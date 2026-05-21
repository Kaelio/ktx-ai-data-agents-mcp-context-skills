/* @jsxImportSource react */
import type { MemoryFlowReplayInput } from './context/ingest/memory-flow/types.js';
import { render as renderInkTest } from 'ink-testing-library';
import React, { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryFlowTuiApp,
  memoryFlowCommandForInkInput,
  renderMemoryFlowTui,
  sanitizeMemoryFlowTuiError,
  startLiveMemoryFlowTui,
  type KtxMemoryFlowTuiIo,
  type MemoryFlowInkInstance,
} from './memory-flow-tui.js';

function replayInput(): MemoryFlowReplayInput {
  return {
    runId: 'run-1', connectionId: 'warehouse', adapter: 'live-database',
    status: 'done', sourceDir: null, syncId: 'sync-1', reportId: 'report-1', reportPath: 'report-1', errors: [],
    plannedWorkUnits: [
      { unitKey: 'orders', rawFiles: ['orders'], peerFileCount: 0, dependencyCount: 1 },
      { unitKey: 'customers', rawFiles: ['customers'], peerFileCount: 1, dependencyCount: 0 },
    ],
    details: {
      actions: [
        { unitKey: 'orders', target: 'wiki', action: 'created', key: 'wiki/orders.md', summary: 'order lifecycle', rawFiles: ['orders'], status: 'success' },
        { unitKey: 'customers', target: 'sl', action: 'updated', key: 'orbit_demo.customers', summary: 'customer metrics', rawFiles: ['customers'], status: 'success' },
      ],
      provenance: [{ rawPath: 'orders', artifactKind: 'wiki', artifactKey: 'wiki/orders.md', actionType: 'wiki_written' }],
      transcripts: [{ unitKey: 'orders', path: '/tmp/t.jsonl', toolCallCount: 2, errorCount: 0, toolNames: ['read_raw_span', 'memory_ingest'] }],
    },
    events: [
      { type: 'source_acquired', adapter: 'live-database', trigger: 'manual_resync', fileCount: 2 },
      { type: 'scope_detected', fingerprint: 'scope-1' },
      { type: 'raw_snapshot_written', syncId: 'sync-1', rawFileCount: 2 },
      { type: 'diff_computed', added: 1, modified: 1, deleted: 0, unchanged: 0 },
      { type: 'chunks_planned', chunkCount: 2, workUnitCount: 2, evictionCount: 0 },
      { type: 'work_unit_started', unitKey: 'orders', skills: ['wiki_capture'], stepBudget: 40 },
      { type: 'candidate_action', unitKey: 'orders', target: 'wiki', action: 'created', key: 'wiki/orders.md' },
      { type: 'work_unit_finished', unitKey: 'orders', status: 'success' },
      { type: 'work_unit_started', unitKey: 'customers', skills: ['sl_capture'], stepBudget: 40 },
      { type: 'candidate_action', unitKey: 'customers', target: 'sl', action: 'updated', key: 'orbit_demo.customers' },
      { type: 'work_unit_finished', unitKey: 'customers', status: 'success' },
      { type: 'reconciliation_finished', conflictCount: 0, fallbackCount: 0 },
      { type: 'saved', commitSha: 'commit-one', wikiCount: 1, slCount: 1 },
      { type: 'provenance_recorded', rowCount: 1 },
      { type: 'report_created', runId: 'run-1', reportPath: 'report-1' },
    ],
  };
}

function runningReplayInput(): MemoryFlowReplayInput {
  return { ...replayInput(), status: 'running', syncId: 'pending', reportId: undefined, reportPath: undefined, plannedWorkUnits: [], events: [{ type: 'source_acquired', adapter: 'live-database', trigger: 'manual_resync', fileCount: 1 }] };
}

function packagedReplayInput(overrides: Partial<MemoryFlowReplayInput> = {}): MemoryFlowReplayInput {
  return {
    ...replayInput(),
    connectionId: 'orbit_demo',
    metadata: {
      schemaVersion: 1,
      mode: 'seeded',
      origin: 'packaged',
      timing: 'prebuilt',
      capturedAt: null,
      sourceReportId: 'demo-seeded-report',
      sourceReportPath: 'reports/seeded-demo-report.json',
      fallbackReason: null,
    },
    ...overrides,
  };
}

function makeIo(): { io: KtxMemoryFlowTuiIo; stderr: () => string } {
  let stderr = '';
  return { io: { stdin: { isTTY: true, setRawMode: vi.fn() }, stdout: { isTTY: true, columns: 120, write: vi.fn() }, stderr: { write(chunk: string) { stderr += chunk; } } }, stderr: () => stderr };
}

function fakeInkInstance(): MemoryFlowInkInstance {
  return { rerender: vi.fn(), unmount: vi.fn(), waitUntilExit: vi.fn(async () => undefined), clear: vi.fn() };
}

async function waitForInkInput(): Promise<void> { await new Promise((r) => setTimeout(r, 10)); }

function renderedAppProps(tree: ReactNode): Record<string, unknown> {
  expect(React.isValidElement(tree)).toBe(true);
  return (tree as React.ReactElement<Record<string, unknown>>).props;
}

describe('memoryFlowCommandForInkInput', () => {
  it('maps input to commands', () => {
    expect(memoryFlowCommandForInkInput('q', {})).toBe('quit');
    expect(memoryFlowCommandForInkInput('c', { ctrl: true })).toBe('quit');
    expect(memoryFlowCommandForInkInput('x', {})).toBeNull();
  });
});

describe('sanitizeMemoryFlowTuiError', () => {
  it('redacts credentials', () => {
    expect(sanitizeMemoryFlowTuiError(new Error('postgres://x?api_key=y password=z'))).toBe('[redacted-url] [redacted]');
  });
});

describe('MemoryFlowTuiApp', () => {
  it('always shows the KTX logo', () => {
    const { lastFrame } = renderInkTest(<MemoryFlowTuiApp input={replayInput()} terminalWidth={120} onExit={vi.fn()} showBoot={false} />);
    expect(lastFrame()).toContain('╚███╔╝');
  });

  it('shows persistent HUD with source and status terminology', () => {
    const { lastFrame } = renderInkTest(<MemoryFlowTuiApp input={{ ...replayInput(), connectionId: 'warehouse' }} terminalWidth={120} onExit={vi.fn()} showBoot={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Database (warehouse)');
    expect(frame).toContain('2 tables');
    expect(frame).toContain('done');
    expect(frame).toContain('warehouse');
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
  });

  it('hides the internal demo connection id before packaged replay source events are visible', () => {
    const { lastFrame } = renderInkTest(
      <MemoryFlowTuiApp
        input={packagedReplayInput({ status: 'running', events: [] })}
        terminalWidth={120}
        onExit={vi.fn()}
        showBoot={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Orbit Demo');
    expect(frame).not.toContain('orbit_demo');
    expect(frame).not.toContain('Database (orbit_demo)');
  });

  it('keeps the packaged replay source label public while only one source event is visible', () => {
    const { lastFrame } = renderInkTest(
      <MemoryFlowTuiApp
        input={packagedReplayInput({
          status: 'running',
          events: [{ type: 'source_acquired', adapter: 'live-database', trigger: 'demo_seeded', fileCount: 8 }],
        })}
        terminalWidth={120}
        onExit={vi.fn()}
        showBoot={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Orbit Demo');
    expect(frame).not.toContain('orbit_demo');
    expect(frame).not.toContain('Database (orbit_demo)');
  });

  it('shows a prepopulated data disclaimer for packaged demo replay cost estimates', () => {
    const { lastFrame } = renderInkTest(
      <MemoryFlowTuiApp
        input={packagedReplayInput()}
        terminalWidth={120}
        onExit={vi.fn()}
        showBoot={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('$');
    expect(frame).toContain('Pre-run demo: $ shown is illustrative; no money is being spent now.');
    expect(frame).not.toContain('orbit_demo');
  });

  it('does not show the prepopulated data disclaimer for captured full replay cost estimates', () => {
    const { lastFrame } = renderInkTest(
      <MemoryFlowTuiApp
        input={{
          ...replayInput(),
          metadata: {
            schemaVersion: 1,
            mode: 'full',
            origin: 'captured',
            timing: 'captured',
            capturedAt: '2026-05-01T00:00:00.000Z',
            sourceReportId: 'report-full',
            sourceReportPath: 'reports/report-full.json',
            fallbackReason: null,
          },
        }}
        terminalWidth={120}
        onExit={vi.fn()}
        showBoot={false}
      />,
    );
    expect(lastFrame()).not.toContain('Demo data is prepopulated');
  });

  it('shows accumulated activity feed on completion', () => {
    const { lastFrame } = renderInkTest(<MemoryFlowTuiApp input={replayInput()} terminalWidth={120} onExit={vi.fn()} showBoot={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Connected — found 2 tables to ingest');
    expect(frame).toContain('Created so far:');
    expect(frame).toContain('order lifecycle');
    expect(frame).toContain('customer metrics');
    expect(frame).toContain('KTX finished ingesting your data');
    expect(frame).toContain('ktx sl');
    expect(frame).toContain('ktx wiki');
    expect(frame).not.toContain('ktx serve --mcp stdio --user-id local');
    expect(frame).not.toContain(['ktx', 'ask'].join(' '));
    expect(frame).not.toContain(['ktx', 'mcp'].join(' '));
  });

  it('handles quit while running', async () => {
    const onExit = vi.fn();
    const { stdin } = renderInkTest(<MemoryFlowTuiApp input={runningReplayInput()} terminalWidth={120} onExit={onExit} showBoot={false} />);
    stdin.write('q');
    await waitForInkInput();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('shows active work unit with progress', () => {
    const running: MemoryFlowReplayInput = {
      ...runningReplayInput(),
      events: [
        { type: 'source_acquired', adapter: 'live-database', trigger: 'manual_resync', fileCount: 1 },
        { type: 'diff_computed', added: 1, modified: 0, deleted: 0, unchanged: 0 },
        { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
        { type: 'work_unit_started', unitKey: 'orders', skills: ['wiki_capture'], stepBudget: 40 },
      ],
      plannedWorkUnits: [{ unitKey: 'orders', rawFiles: ['orders'], peerFileCount: 0, dependencyCount: 1 }],
    };
    const { lastFrame } = renderInkTest(<MemoryFlowTuiApp input={running} terminalWidth={120} onExit={vi.fn()} showBoot={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ingesting — 0/1 business area done');
    expect(frame).toContain('Reading table schemas, understanding relationships, creating query definitions');
    expect(frame).toContain('╚███╔╝');
  });

  it('describes multi-source ingestion as building the context layer', () => {
    const running: MemoryFlowReplayInput = {
      ...runningReplayInput(),
      adapter: 'multi-source',
      events: [
        { type: 'source_acquired', adapter: 'live-database', trigger: 'manual_resync', fileCount: 8 },
        { type: 'source_acquired', adapter: 'dbt-descriptions', trigger: 'manual_resync', fileCount: 3 },
        { type: 'diff_computed', added: 11, modified: 0, deleted: 0, unchanged: 0 },
        { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
        { type: 'work_unit_started', unitKey: 'orders', skills: ['wiki_capture'], stepBudget: 40 },
      ],
      plannedWorkUnits: [{ unitKey: 'orders', rawFiles: ['orders'], peerFileCount: 0, dependencyCount: 1 }],
    };

    const { lastFrame } = renderInkTest(<MemoryFlowTuiApp input={running} terminalWidth={120} onExit={vi.fn()} showBoot={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ingesting warehouse, dbt, BI, and docs into a unified context layer');
    expect(frame).not.toContain('unified semantic layer');
  });

  it('hides completion while running', () => {
    const { lastFrame } = renderInkTest(<MemoryFlowTuiApp input={runningReplayInput()} terminalWidth={120} onExit={vi.fn()} showBoot={false} />);
    expect(lastFrame()).not.toContain('KTX finished ingesting');
  });
});

describe('startLiveMemoryFlowTui', () => {
  it('starts and updates', async () => {
    const { io } = makeIo();
    const instance = fakeInkInstance();
    const live = await startLiveMemoryFlowTui(runningReplayInput(), io, { renderInk: () => instance });
    expect(live).not.toBeNull();
    live?.update(replayInput());
    expect(instance.rerender).toHaveBeenCalledTimes(1);
    live?.close();
    expect(instance.unmount).toHaveBeenCalledTimes(1);
  });

  it('redacts errors', async () => {
    const { io, stderr } = makeIo();
    await expect(startLiveMemoryFlowTui(runningReplayInput(), io, { renderInk: () => { throw new Error('postgres://x?token=y'); } })).resolves.toBeNull();
    expect(stderr()).toContain('[redacted-url]');
  });
});

describe('renderMemoryFlowTui', () => {
  it('renders and returns true', async () => {
    const { io } = makeIo();
    const instance = fakeInkInstance();
    await expect(renderMemoryFlowTui(replayInput(), io, { renderInk: () => instance })).resolves.toBe(true);
  });

  it('scales event timing with the speed multiplier while keeping animations normal speed', async () => {
    const { io } = makeIo();
    const instance = fakeInkInstance();
    let renderedTree: ReactNode = null;

    await expect(
      renderMemoryFlowTui(replayInput(), io, {
        speedMultiplier: 0.125,
        renderInk: (tree) => {
          renderedTree = tree;
          return instance;
        },
      }),
    ).resolves.toBe(true);

    expect(renderedAppProps(renderedTree)).toMatchObject({
      paceMsPerEvent: 1440,
      frameMs: 140,
      completionFrameMs: 80,
      completionHoldMs: 1000,
    });
  });

  it('redacts errors', async () => {
    const { io, stderr } = makeIo();
    await expect(renderMemoryFlowTui(replayInput(), io, { renderInk: () => { throw new Error('postgres://x?token=y'); } })).resolves.toBe(false);
    expect(stderr()).toContain('[redacted-url]');
  });
});
