import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IngestReportSnapshot, MemoryFlowReplayInput } from '@ktx/context/ingest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxDemo } from './demo.js';
import { DEMO_FULL_JOB_ID, defaultDemoProjectDir, ensureDemoProject } from './demo-assets.js';
import type { DemoFullResult } from './demo-full.js';
import { createTestDemoPromptAdapter } from './demo-interaction.js';
import type { renderMemoryFlowTui } from './memory-flow-tui.js';
import { KTX_NEXT_STEP_DIRECT_COMMANDS } from './next-steps.js';
import { resetVizFallbackWarningsForTest } from './viz-fallback.js';

const SEEDED_DEMO_SEMANTIC_SOURCE_COUNT = 46;
const SEEDED_DEMO_KNOWLEDGE_PAGE_COUNT = 28;

function makeIo(options: { isTTY?: boolean; columns?: number; rawMode?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdin: {
        isTTY: options.isTTY ?? false,
        ...(options.rawMode === false ? {} : { setRawMode: vi.fn() }),
      },
      stdout: {
        isTTY: options.isTTY ?? false,
        columns: options.columns ?? 140,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function fakeFullResult(projectDir: string): DemoFullResult {
  const report: IngestReportSnapshot = {
    id: 'report-full',
    runId: 'run-full',
    jobId: DEMO_FULL_JOB_ID,
    connectionId: 'orbit_demo',
    sourceKey: 'live-database',
    createdAt: '2026-05-01T00:00:00.000Z',
    body: {
      syncId: 'sync-full',
      diffSummary: { added: 7, modified: 0, deleted: 0, unchanged: 0 },
      commitSha: null,
      workUnits: [
        {
          unitKey: 'accounts',
          rawFiles: ['accounts.schema.json'],
          status: 'success',
          actions: [
            { target: 'wiki', type: 'created', key: 'knowledge/accounts.md', detail: 'account lifecycle context' },
            { target: 'sl', type: 'created', key: 'orbit_demo.accounts', detail: 'accounts semantic source' },
          ],
          touchedSlSources: [{ connectionId: 'orbit_demo', sourceName: 'orbit_demo.accounts' }],
        },
      ],
      failedWorkUnits: [],
      reconciliationSkipped: false,
      conflictsResolved: [],
      evictionsApplied: [],
      unmappedFallbacks: [],
      evictionInputs: [],
      unresolvedCards: [],
      supersededBy: null,
      overrideOf: null,
      provenanceRows: [
        {
          rawPath: 'accounts.schema.json',
          artifactKind: 'wiki',
          artifactKey: 'knowledge/accounts.md',
          actionType: 'wiki_written',
        },
      ],
      toolTranscripts: [],
    },
  };

  return {
    project: { projectDir } as never,
    scan: { report: { runId: 'scan-run' } } as never,
    ingest: { result: { ok: true }, report } as never,
    report,
    replay: {
      runId: 'run-full',
      connectionId: 'orbit_demo',
      adapter: 'live-database',
      status: 'done',
      sourceDir: `${projectDir}/raw-sources/orbit_demo/live-database/sync-full`,
      syncId: 'sync-full',
      errors: [],
      events: [
        { type: 'source_acquired', adapter: 'live-database', trigger: 'demo_full', fileCount: 7 },
        { type: 'saved', commitSha: null, wikiCount: 1, slCount: 1 },
        { type: 'provenance_recorded', rowCount: 1 },
        { type: 'report_created', runId: 'run-full', reportPath: 'report-full' },
      ],
      plannedWorkUnits: [],
      details: { actions: [], provenance: [], transcripts: [] },
    },
  };
}

describe('runKtxDemo', () => {
  let tempDir: string;

  beforeEach(async () => {
    resetVizFallbackWarningsForTest();
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-demo-command-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('initializes the demo project', async () => {
    const io = makeIo();
    await expect(
      runKtxDemo({ command: 'init', projectDir: tempDir, force: false, inputMode: 'disabled' }, io.io),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain(`Demo project: ${tempDir}`);
    expect(io.stdout()).toContain('Config:');
    expect(io.stdout()).toContain('Replay:');
    expect(io.stderr()).toBe('');
  });

  it('renders the packaged replay in no-input viz mode', async () => {
    const io = makeIo({ isTTY: true });
    await expect(
      runKtxDemo(
        { command: 'replay', projectDir: tempDir, outputMode: 'viz', inputMode: 'disabled' },
        io.io,
        { env: { ...process.env, TERM: 'xterm-256color' } },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  Warehouse + dbt + BI + Docs  done');
    expect(io.stdout()).toContain('Saved 16 memories');
    expect(io.stderr()).toBe('');
  });

  it('routes interactive packaged replay viz through the stored TUI renderer', async () => {
    const io = makeIo({ isTTY: true });
    const renderStoredMemoryFlow = vi.fn<typeof renderMemoryFlowTui>(async () => true);

    await expect(
      runKtxDemo(
        { command: 'replay', projectDir: tempDir, outputMode: 'viz' },
        io.io,
        { env: { ...process.env, TERM: 'xterm-256color' }, renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).toHaveBeenCalledTimes(1);
    expect(renderStoredMemoryFlow.mock.calls[0]?.[0]).toMatchObject({
      runId: 'demo-seeded-orbit',
      connectionId: 'orbit_demo',
      adapter: 'live-database',
    });
    expect(renderStoredMemoryFlow.mock.calls[0]?.[2]).toEqual({ speedMultiplier: 0.125 });
    expect(io.stdout()).toContain('KTX finished ingesting your data');
    expect(io.stderr()).toBe('');
  });

  it('routes interactive seeded demo viz through the stored TUI renderer at eighth speed', async () => {
    const io = makeIo({ isTTY: true });
    const renderStoredMemoryFlow = vi.fn<typeof renderMemoryFlowTui>(async () => true);

    await expect(
      runKtxDemo(
        { command: 'seeded', projectDir: tempDir, outputMode: 'viz' },
        io.io,
        { env: { ...process.env, TERM: 'xterm-256color' }, renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).toHaveBeenCalledTimes(1);
    expect(renderStoredMemoryFlow.mock.calls[0]?.[2]).toEqual({ speedMultiplier: 0.125 });
    expect(io.stdout()).toContain('KTX finished ingesting your data');
    expect(io.stderr()).toBe('');
  });

  it('falls back to plain replay output when interactive replay viz lacks stdin raw mode', async () => {
    const io = makeIo({ isTTY: true, rawMode: false });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxDemo(
        { command: 'replay', projectDir: tempDir, outputMode: 'viz' },
        io.io,
        { env: { ...process.env, TERM: 'xterm-256color' }, renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Memory-flow summary: done');
    expect(io.stdout()).toContain('Connection: orbit_demo');
    expect(io.stdout()).toContain('ktx sl list');
    expect(io.stdout()).toContain('ktx wiki list');
    expect(io.stdout()).not.toContain('ktx serve --mcp stdio --user-id local');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdin raw mode is unavailable; printing plain output.',
    );
  });

  it('degrades default visual demo replay to a plain memory-flow summary when stdout is redirected', async () => {
    const testIo = makeIo({ isTTY: false });

    await expect(
      runKtxDemo({ command: 'replay', projectDir: tempDir, outputMode: 'viz', inputMode: 'disabled' }, testIo.io),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Memory-flow summary: done');
    expect(testIo.stdout()).toContain('Connection: orbit_demo');
    expect(testIo.stdout()).toContain('ktx sl list');
    expect(testIo.stdout()).toContain('ktx wiki list');
    expect(testIo.stdout()).not.toContain('ktx serve --mcp stdio --user-id local');
    expect(testIo.stdout()).not.toContain('KTX memory flow');
    expect(testIo.stderr()).toContain(
      'Visualization requested but stdout is not an interactive terminal; printing plain output.',
    );
  });

  it('prints JSON replay output when requested', async () => {
    const io = makeIo();
    await expect(
      runKtxDemo({ command: 'replay', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' }, io.io),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({ runId: 'demo-seeded-orbit', connectionId: 'orbit_demo' });
    expect(io.stderr()).toBe('');
  });

  it('runs the packaged SQLite demo scan', async () => {
    const io = makeIo();
    await expect(runKtxDemo({ command: 'scan', projectDir: tempDir, inputMode: 'disabled' }, io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain('Demo scan: done');
    expect(io.stdout()).toContain('Connection: orbit_demo');
    expect(io.stdout()).toContain('Driver: sqlite');
    expect(io.stdout()).toContain('Report: raw-sources/orbit_demo/live-database/');
    expect(io.stderr()).toBe('');
  });

  it('runs seeded mode with pre-seeded assets and inspect summary', async () => {
    const io = makeIo({ isTTY: true });
    await expect(
      runKtxDemo(
        { command: 'seeded', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        io.io,
        { env: { ...process.env, TERM: 'xterm-256color' } },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Mode: seeded');
    expect(io.stdout()).toContain('LLM calls: none');
    expect(io.stdout()).toContain('Semantic-layer sources:');
    expect(io.stdout()).toContain('Knowledge pages:');
    expect(io.stderr()).toBe('');
  });

  it('uses seeded mode as the default demo and creates a temp project when no project-dir is supplied', async () => {
    const io = makeIo();

    await expect(
      runKtxDemo(
        { command: 'seeded', projectDir: defaultDemoProjectDir(), outputMode: 'plain', inputMode: 'disabled' },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Mode: seeded');
    expect(io.stdout()).toContain('Source: packaged demo project');
    expect(io.stdout()).toContain('Generated context: prebuilt from bundled assets');
    expect(io.stdout()).toContain('LLM calls: none');
    expect(io.stdout()).toContain('Your KTX project files are at:');
    expect(io.stdout()).toContain(join(tmpdir(), 'ktx-demo-'));
    expect(io.stdout()).not.toContain('ktx serve --mcp stdio');
    expect(io.stdout()).not.toContain(['ktx', 'mcp'].join(' '));
    expect(io.stdout()).not.toContain('deterministic');
  });

  it('degrades default visual seeded demo to plain output when TERM is dumb', async () => {
    const testIo = makeIo({ isTTY: true, columns: 120 });

    await expect(
      runKtxDemo(
        { command: 'seeded', projectDir: tempDir, outputMode: 'viz', inputMode: 'disabled' },
        testIo.io,
        { env: { ...process.env, TERM: 'dumb' } },
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Mode: seeded');
    expect(testIo.stdout()).toContain('LLM calls: none');
    expect(testIo.stderr()).toContain(
      'Visualization requested but TERM=dumb does not support the visual renderer; printing plain output.',
    );
  });

  it('prints demo inspect as plain text and JSON', async () => {
    const seededIo = makeIo();
    await expect(
      runKtxDemo({ command: 'seeded', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' }, seededIo.io),
    ).resolves.toBe(0);

    const plainIo = makeIo();
    await expect(
      runKtxDemo({ command: 'inspect', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' }, plainIo.io),
    ).resolves.toBe(0);
    expect(plainIo.stdout()).toContain('Mode: seeded');
    expect(plainIo.stdout()).toContain('Semantic-layer sources:');

    const jsonIo = makeIo();
    await expect(
      runKtxDemo({ command: 'inspect', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' }, jsonIo.io),
    ).resolves.toBe(0);
    const parsed = JSON.parse(jsonIo.stdout());
    expect(parsed).toMatchObject({
      projectDir: tempDir,
      mode: 'seeded',
      status: { status: 'ready', missing: [] },
      sourceBundle: {
        warehouse: { tableCount: 8, totalRows: 11234 },
        dbt: { modelCount: 3, sourceTableCount: 8 },
        bi: { exploreCount: 5, dashboardCount: 2 },
        notion: { pageCount: 8 },
      },
      generatedOutputs: {
        semanticLayer: {
          manifestSourceCount: SEEDED_DEMO_SEMANTIC_SOURCE_COUNT,
          fileCount: SEEDED_DEMO_SEMANTIC_SOURCE_COUNT,
        },
        knowledge: {
          manifestPageCount: SEEDED_DEMO_KNOWLEDGE_PAGE_COUNT,
          fileCount: SEEDED_DEMO_KNOWLEDGE_PAGE_COUNT,
        },
        links: { manifestLinkCount: 23, linkCount: 23 },
        reports: { primaryPath: 'reports/seeded-demo-report.json', fileCount: 1 },
      },
      modeMetadata: {
        mode: 'seeded',
        source: 'packaged demo project',
        generatedContext: 'prebuilt from bundled assets',
        llmCalls: 'none',
      },
      nextCommands: KTX_NEXT_STEP_DIRECT_COMMANDS,
    });
    expect(parsed.generatedOutputs.replays.fileCount).toBeGreaterThanOrEqual(3);
    expect(jsonIo.stderr()).toBe('');
  });

  it('routes top-level full mode and prints memory-flow plus final summary', async () => {
    const testIo = makeIo({ isTTY: true });
    const runFullDemo = vi.fn().mockResolvedValue(fakeFullResult(tempDir));
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo({ command: 'full', projectDir: tempDir, outputMode: 'viz', inputMode: 'disabled' }, testIo.io, {
        env: {},
        runFullDemo,
      }),
    ).resolves.toBe(0);

    expect(runFullDemo).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        env: {},
        onMemoryFlowChange: expect.any(Function),
      }),
    );
    expect(testIo.stdout()).toContain('KTX memory flow  orbit_demo/live-database  done');
    expect(testIo.stdout()).toContain('Full demo ingest: done');
    expect(testIo.stdout()).toContain('Next: ktx setup demo inspect');
    expect(testIo.stdout()).toContain('Shows the files, semantic-layer sources, and memory KTX just produced.');
  });

  it('streams live memory-flow snapshots for full demo viz and then prints final summary', async () => {
    const testIo = makeIo({ isTTY: true, columns: 120 });
    const liveSession = {
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => liveSession);
    const runFullDemo = vi.fn(
      async (options: { projectDir: string; onMemoryFlowChange?: (snapshot: MemoryFlowReplayInput) => void }) => {
        options.onMemoryFlowChange?.({
          ...fakeFullResult(tempDir).replay,
          status: 'running',
          events: [{ type: 'source_acquired', adapter: 'live-database', trigger: 'demo_full', fileCount: 7 }],
        });
        return fakeFullResult(tempDir);
      },
    );
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo({ command: 'full', projectDir: tempDir, outputMode: 'viz' }, testIo.io, {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        prompts: createTestDemoPromptAdapter({ choices: ['reuse'] }),
        runFullDemo,
        startLiveMemoryFlow,
      }),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).toHaveBeenCalledTimes(1);
    expect(liveSession.update).toHaveBeenCalledTimes(1);
    expect(liveSession.close).toHaveBeenCalledTimes(1);
    expect(testIo.stdout()).not.toContain('Memory-flow summary: done');
    expect(testIo.stdout()).toContain('KTX finished ingesting your data');
    expect(testIo.stdout()).toContain('ktx sl list');
    expect(testIo.stdout()).toContain('ktx wiki list');
    expect(testIo.stdout()).not.toContain('ktx serve --mcp stdio --user-id local');
    expect(testIo.stdout()).not.toContain(['ktx', 'ask'].join(' '));
    expect(testIo.stdout()).not.toContain(['ktx', 'mcp'].join(' '));
  });

  it('uses plain progress for full demo viz when stdin raw mode is unavailable', async () => {
    const testIo = makeIo({ isTTY: true, rawMode: false, columns: 120 });
    const liveSession = {
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => liveSession);
    const runFullDemo = vi.fn(
      async (options: { projectDir: string; onMemoryFlowChange?: (snapshot: MemoryFlowReplayInput) => void }) => {
        options.onMemoryFlowChange?.({
          ...fakeFullResult(tempDir).replay,
          status: 'running',
          events: [{ type: 'source_acquired', adapter: 'live-database', trigger: 'demo_full', fileCount: 7 }],
        });
        return fakeFullResult(tempDir);
      },
    );
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo({ command: 'full', projectDir: tempDir, outputMode: 'viz' }, testIo.io, {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        prompts: createTestDemoPromptAdapter({ choices: ['reuse'] }),
        runFullDemo,
        startLiveMemoryFlow,
      }),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).not.toHaveBeenCalled();
    expect(runFullDemo).toHaveBeenCalledWith(
      expect.objectContaining({
        onMemoryFlowChange: expect.any(Function),
      }),
    );
    expect(testIo.stdout()).toContain('[connect]  Connected live-database - 7 database files (demo_full)');
    expect(testIo.stdout()).toContain('Full demo ingest: done');
    expect(testIo.stdout()).not.toContain('KTX memory flow');
    expect(testIo.stderr()).toContain(
      'Visualization requested but stdin raw mode is unavailable; printing plain output.',
    );
  });

  it('streams plain-text progress lines for full demo when no live TUI is active', async () => {
    const testIo = makeIo();
    const runFullDemo = vi.fn(
      async (options: { projectDir: string; onMemoryFlowChange?: (snapshot: MemoryFlowReplayInput) => void }) => {
        const baseSnapshot = fakeFullResult(tempDir).replay;
        options.onMemoryFlowChange?.({
          ...baseSnapshot,
          status: 'running',
          events: [{ type: 'source_acquired', adapter: 'live-database', trigger: 'manual_resync', fileCount: 7 }],
        });
        options.onMemoryFlowChange?.({
          ...baseSnapshot,
          status: 'running',
          events: [
            { type: 'source_acquired', adapter: 'live-database', trigger: 'manual_resync', fileCount: 7 },
            { type: 'diff_computed', added: 0, modified: 0, deleted: 0, unchanged: 7 },
          ],
        });
        return fakeFullResult(tempDir);
      },
    );
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo(
        { command: 'full', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        { env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, runFullDemo }, // pragma: allowlist secret
      ),
    ).resolves.toBe(0);

    const stdout = testIo.stdout();
    expect(stdout).toContain('[connect]  Connected live-database - 7 database files (manual_resync)');
    expect(stdout).toContain('[diff]     Tables: =7 unchanged');
    expect(stdout).toContain('Full demo ingest: done');
  });

  it('skips plain progress lines for json output mode', async () => {
    const testIo = makeIo();
    const runFullDemo = vi.fn(
      async (options: { projectDir: string; onMemoryFlowChange?: (snapshot: MemoryFlowReplayInput) => void }) => {
        expect(options.onMemoryFlowChange).toBeUndefined();
        return fakeFullResult(tempDir);
      },
    );
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo(
        { command: 'full', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' },
        testIo.io,
        { env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, runFullDemo }, // pragma: allowlist secret
      ),
    ).resolves.toBe(0);
    expect(testIo.stdout()).not.toContain('[connect]');
    expect(testIo.stdout()).not.toContain('[snapshot]');
  });

  it('routes demo ingest full mode', async () => {
    const testIo = makeIo();
    const runFullDemo = vi.fn().mockResolvedValue(fakeFullResult(tempDir));
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo(
        { command: 'ingest', mode: 'full', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        { env: {}, runFullDemo },
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Full demo ingest: done');
  });

  it('saves full-demo replay output for the next demo replay command', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-demo-full-replay-'));
    await ensureDemoProject({ projectDir: tempDir, force: false });
    const io = makeIo();

    await expect(
      runKtxDemo(
        { command: 'full', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        io.io,
        {
          env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
          runFullDemo: vi.fn(async () => fakeFullResult(tempDir)),
        },
      ),
    ).resolves.toBe(0);

    const replayIo = makeIo();
    await expect(
      runKtxDemo({ command: 'replay', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' }, replayIo.io),
    ).resolves.toBe(0);
    expect(JSON.parse(replayIo.stdout())).toMatchObject({
      runId: 'run-full',
      metadata: { mode: 'full', origin: 'captured' },
    });
  });

  it('routes demo ingest seeded mode through the seeded path', async () => {
    const testIo = makeIo();

    await expect(
      runKtxDemo(
        { command: 'ingest', mode: 'seeded', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Mode: seeded');
    expect(testIo.stdout()).toContain('LLM calls: none');
  });

  it('routes demo doctor through the doctor module', async () => {
    const testIo = makeIo();
    const runDoctor = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxDemo(
        {
          command: 'doctor',
          projectDir: tempDir,
          outputMode: 'plain',
          inputMode: 'disabled',
        },
        testIo.io,
        { runDoctor },
      ),
    ).resolves.toBe(0);

    expect(runDoctor).toHaveBeenCalledWith(
      {
        command: 'demo',
        projectDir: tempDir,
        outputMode: 'plain',
        inputMode: 'disabled',
      },
      testIo.io,
    );
  });

  it('resets the demo project only when force is explicit', async () => {
    await ensureDemoProject({ projectDir: tempDir, force: false });
    await rm(join(tempDir, 'demo.db'), { force: true });

    const rejected = makeIo();
    await expect(
      runKtxDemo({ command: 'reset', projectDir: tempDir, force: false, inputMode: 'disabled' }, rejected.io),
    ).resolves.toBe(1);
    expect(rejected.stderr()).toContain(`ktx setup demo reset is destructive; pass --force to recreate ${tempDir}`);

    const accepted = makeIo();
    await expect(
      runKtxDemo({ command: 'reset', projectDir: tempDir, force: true, inputMode: 'disabled' }, accepted.io),
    ).resolves.toBe(0);
    expect(accepted.stdout()).toContain(`Demo project reset: ${tempDir}`);
  });

  it('rehydrates seeded assets after reset --force', async () => {
    const resetIo = makeIo();
    await expect(
      runKtxDemo({ command: 'reset', projectDir: tempDir, force: true, inputMode: 'disabled' }, resetIo.io),
    ).resolves.toBe(0);

    const seededIo = makeIo();
    await expect(
      runKtxDemo(
        { command: 'seeded', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        seededIo.io,
      ),
    ).resolves.toBe(0);

    expect(seededIo.stdout()).toContain('Status: ready');
    expect(seededIo.stdout()).toContain(
      `Semantic-layer sources: ${SEEDED_DEMO_SEMANTIC_SOURCE_COUNT} manifest, ${SEEDED_DEMO_SEMANTIC_SOURCE_COUNT} files`,
    );
    expect(seededIo.stdout()).toContain(
      `Knowledge pages: ${SEEDED_DEMO_KNOWLEDGE_PAGE_COUNT} manifest, ${SEEDED_DEMO_KNOWLEDGE_PAGE_COUNT} files`,
    );
    expect(seededIo.stdout()).not.toContain('Status: corrupt');
    expect(seededIo.stdout()).not.toContain(
      `Semantic-layer sources: ${SEEDED_DEMO_SEMANTIC_SOURCE_COUNT} manifest, 0 files`,
    );
  });

  it('fails corrupted demo projects in no-input mode with reset guidance', async () => {
    await ensureDemoProject({ projectDir: tempDir, force: false });
    await rm(join(tempDir, 'demo.db'), { force: true });
    const testIo = makeIo();

    await expect(
      runKtxDemo({ command: 'replay', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' }, testIo.io),
    ).resolves.toBe(1);

    expect(testIo.stderr()).toContain(`Demo project is not ready at ${tempDir}: missing demo.db`);
    expect(testIo.stderr()).toContain(`ktx setup demo reset --project-dir ${tempDir} --force --no-input`);
  });

  it('uses a process-local Anthropic key from the interactive prompt', async () => {
    const testIo = makeIo({ isTTY: true, columns: 120 });
    const runFullDemo = vi.fn().mockResolvedValue(fakeFullResult(tempDir));
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo(
        { command: 'full', projectDir: tempDir, outputMode: 'plain' },
        testIo.io,
        {
          env: {},
          prompts: createTestDemoPromptAdapter({
            choices: ['reuse', 'process_key'],
            passwords: ['sk-ant-process'], // pragma: allowlist secret
          }),
          runFullDemo,
        },
      ),
    ).resolves.toBe(0);

    expect(runFullDemo).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        env: { ANTHROPIC_API_KEY: 'sk-ant-process' }, // pragma: allowlist secret
        onMemoryFlowChange: expect.any(Function),
      }),
    );
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).toContain('api_key: env:ANTHROPIC_API_KEY');
  });

  it('routes an interactive missing-key choice to seeded mode', async () => {
    const testIo = makeIo({ isTTY: true, columns: 120 });
    const runFullDemo = vi.fn();
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo(
        { command: 'full', projectDir: tempDir, outputMode: 'plain' },
        testIo.io,
        {
          env: {},
          prompts: createTestDemoPromptAdapter({ choices: ['reuse', 'seeded'] }),
          runFullDemo,
        },
      ),
    ).resolves.toBe(0);

    expect(runFullDemo).not.toHaveBeenCalled();
    expect(testIo.stdout()).toContain('Mode: seeded');
    expect(testIo.stdout()).toContain('LLM calls: none');
    expect(testIo.stdout()).not.toContain('deterministic');
  });

  it('routes missing full-mode credentials to seeded when the interactive user chooses the no-LLM demo', async () => {
    const testIo = makeIo({ isTTY: true });

    await expect(
      runKtxDemo(
        { command: 'full', projectDir: tempDir, outputMode: 'plain' },
        testIo.io,
        {
          env: { ...process.env, ANTHROPIC_API_KEY: '' },
          prompts: createTestDemoPromptAdapter({ choices: ['seeded'] }),
        },
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Mode: seeded');
    expect(testIo.stdout()).toContain('LLM calls: none');
    expect(testIo.stdout()).not.toContain('deterministic');
  });

  it('routes an interactive missing-key choice to replay mode', async () => {
    const testIo = makeIo({ isTTY: true, columns: 120 });
    const runFullDemo = vi.fn();
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      runKtxDemo(
        { command: 'full', projectDir: tempDir, outputMode: 'viz' },
        testIo.io,
        {
          env: {},
          prompts: createTestDemoPromptAdapter({ choices: ['reuse', 'replay'] }),
          runFullDemo,
        },
      ),
    ).resolves.toBe(0);

    expect(runFullDemo).not.toHaveBeenCalled();
    expect(testIo.stdout()).toContain('KTX memory flow');
    expect(testIo.stdout()).toContain('done');
  });
});
