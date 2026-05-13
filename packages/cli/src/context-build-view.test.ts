import { buildDefaultKtxProjectConfig, type KtxProjectConfig } from '@ktx/context/project';
import { describe, expect, it, vi } from 'vitest';
import type { KtxPublicIngestProject, KtxPublicIngestTargetResult } from './public-ingest.js';
import {
  type ContextBuildTargetState,
  extractProgressMessage,
  createRepainter,
  initViewState,
  parseIngestSummary,
  parseScanSummary,
  renderContextBuildView,
  runContextBuild,
  viewStateFromSourceProgress,
} from './context-build-view.js';

function makeIo(options: { isTTY?: boolean; columns?: number } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.isTTY,
        columns: options.columns,
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

function projectWithConnections(connections: KtxProjectConfig['connections']): KtxPublicIngestProject {
  return {
    projectDir: '/tmp/project',
    config: {
      ...buildDefaultKtxProjectConfig('warehouse'),
      connections,
    },
  };
}

function successResult(
  connectionId: string,
  driver: string,
  operation: 'database-ingest' | 'source-ingest',
): KtxPublicIngestTargetResult {
  return {
    connectionId,
    driver,
    steps: [
      { operation: 'database-schema', status: operation === 'database-ingest' ? 'done' : 'skipped' },
      { operation: 'query-history', status: 'skipped' },
      { operation: 'source-ingest', status: operation === 'source-ingest' ? 'done' : 'skipped' },
      { operation: 'memory-update', status: operation === 'source-ingest' ? 'done' : 'skipped' },
    ],
  };
}

function failedResult(
  connectionId: string,
  driver: string,
  operation: 'database-ingest' | 'source-ingest',
): KtxPublicIngestTargetResult {
  return {
    connectionId,
    driver,
    steps: [
      {
        operation: 'database-schema',
        status: operation === 'database-ingest' ? 'failed' : 'skipped',
        detail: `${connectionId} failed at database-schema.`,
      },
      { operation: 'query-history', status: 'skipped' },
      { operation: 'source-ingest', status: operation === 'source-ingest' ? 'failed' : 'skipped' },
      { operation: 'memory-update', status: 'not-run' },
    ],
  };
}

describe('extractProgressMessage', () => {
  it('extracts percentage and message from scan progress', () => {
    expect(extractProgressMessage('\r[45%] Scanning tables...[K')).toBe('[45%] Scanning tables...');
  });

  it('extracts from permanent progress lines', () => {
    expect(extractProgressMessage('[100%] Done\n')).toBe('[100%] Done');
  });

  it('returns null for non-progress output', () => {
    expect(extractProgressMessage('KTX scan completed\n')).toBeNull();
  });
});

describe('parseScanSummary', () => {
  it('extracts table count from scan output', () => {
    expect(parseScanSummary('Semantic layer comparison found 5 changes across 42 tables')).toBe('42 tables');
  });

  it('handles singular form', () => {
    expect(parseScanSummary('found 1 change across 1 table')).toBe('1 tables');
  });

  it('returns null when no match', () => {
    expect(parseScanSummary('No changes detected')).toBeNull();
  });
});

describe('parseIngestSummary', () => {
  it('extracts task count and saved memory', () => {
    expect(parseIngestSummary('Tasks: 5\nSaved memory: 3 wiki, 2 SL')).toBe('3 wiki, 2 SL');
  });

  it('extracts task count alone when no saved memory', () => {
    expect(parseIngestSummary('Tasks: 5\nStatus: done')).toBe('5 tasks');
  });

  it('still parses the legacy "Work units:" wording for backward compat', () => {
    expect(parseIngestSummary('Work units: 7\nStatus: done')).toBe('7 tasks');
  });

  it('extracts saved memory alone when no task count', () => {
    expect(parseIngestSummary('Saved memory: 3 wiki, 2 SL')).toBe('3 wiki, 2 SL');
  });

  it('returns null when no match', () => {
    expect(parseIngestSummary('Status: done')).toBeNull();
  });
});

describe('initViewState', () => {
  it('partitions targets into primary and context sources', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
      { connectionId: 'dbt-main', driver: 'dbt', operation: 'source-ingest', adapter: 'dbt', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);

    expect(state.primarySources).toHaveLength(1);
    expect(state.primarySources[0].target.connectionId).toBe('warehouse');
    expect(state.contextSources).toHaveLength(1);
    expect(state.contextSources[0].target.connectionId).toBe('dbt-main');
    expect(state.frame).toBe(0);
  });

  it('initializes global timing fields', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    expect(state.startedAt).toBeNull();
    expect(state.totalElapsedMs).toBe(0);
  });
});

describe('renderContextBuildView', () => {
  it('renders all-queued state with ○ icon and progress counter', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
      { connectionId: 'dbt-main', driver: 'dbt', operation: 'source-ingest', adapter: 'dbt', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Building KTX context');
    expect(output).toContain('(0/2)');
    expect(output).toContain('○');
    expect(output).toContain('Databases:');
    expect(output).toContain('warehouse');
    expect(output).toContain('queued');
    expect(output).toContain('Context sources:');
    expect(output).toContain('dbt-main');
  });

  it('renders header with total elapsed time when set', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    state.totalElapsedMs = 65000;

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('(0/1 · 1m05s)');
  });

  it('renders project directory when provided', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);

    const output = renderContextBuildView(state, { styled: false, projectDir: '/tmp/project' });
    expect(output).toContain('Project: /tmp/project');
  });

  it('renders public warnings in the foreground view', () => {
    const state = initViewState([
      {
        connectionId: 'docs',
        driver: 'notion',
        operation: 'source-ingest',
        adapter: 'notion',
        debugCommand: 'ktx ingest docs --debug',
        steps: ['source-ingest', 'memory-update'],
      },
    ]);

    const rendered = renderContextBuildView(state, {
      styled: false,
      warnings: ['--deep affects database ingest only; ignoring it for docs.'],
    });

    expect(rendered).toContain('Warnings:');
    expect(rendered).toContain('--deep affects database ingest only; ignoring it for docs.');
  });

  it('renders public notices in the foreground view before warnings', () => {
    const state = initViewState([
      {
        connectionId: 'warehouse',
        driver: 'postgres',
        operation: 'database-ingest',
        debugCommand: 'ktx ingest warehouse --debug',
        steps: ['database-schema', 'query-history'],
        databaseDepth: 'deep',
        detectRelationships: true,
        queryHistory: { enabled: true, dialect: 'postgres' },
      },
    ]);

    const rendered = renderContextBuildView(state, {
      styled: false,
      notices: ['Schema ingest runs before query history for warehouse.'],
      warnings: ['--query-history requires deep ingest; running warehouse with --deep.'],
    });

    expect(rendered.indexOf('Notices:')).toBeLessThan(rendered.indexOf('Warnings:'));
    expect(rendered).toContain('Schema ingest runs before query history for warehouse.');
    expect(rendered).toContain('--query-history requires deep ingest; running warehouse with --deep.');
  });

  it('renders dynamic separator matching header width', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    state.totalElapsedMs = 120000;

    const output = renderContextBuildView(state, { styled: false });
    const lines = output.split('\n');
    const headerLine = lines.find((l) => l.includes('Building KTX context'))!;
    const separatorLine = lines.find((l) => /^─+$/.test(l))!;
    expect(separatorLine.length).toBeGreaterThanOrEqual(headerLine.length);
  });

  it('renders completed state with summary', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    state.primarySources[0].status = 'done';
    state.primarySources[0].elapsedMs = 72000;
    state.primarySources[0].summaryText = '42 tables';

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('42 tables');
    expect(output).toContain('1m12s');
    expect(output).toContain('(1/1)');
  });

  it('renders running target with elapsed time', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    state.primarySources[0].status = 'running';
    state.primarySources[0].elapsedMs = 30000;

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('reading schema');
    expect(output).toContain('(30s)');
  });

  it('renders running target with progress bar when percentage is available', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    state.primarySources[0].status = 'running';
    state.primarySources[0].detailLine = '[50%] Scanning tables...';
    state.primarySources[0].elapsedMs = 15000;

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('██████░░░░░░');
    expect(output).toContain('50%');
    expect(output).toContain('Scanning tables...');
    expect(output).toContain('(15s)');
  });

  it('shows how long a running target has gone without a progress update', () => {
    const state = initViewState([
      { connectionId: 'notion-main', driver: 'notion', operation: 'source-ingest', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);
    state.contextSources[0].status = 'running';
    state.contextSources[0].startedAt = 1_000;
    state.contextSources[0].elapsedMs = 113_000;
    state.contextSources[0].progressUpdatedAtMs = 46_000;
    state.contextSources[0].detailLine = '[45%] No tasks to process; finalizing ingest';

    const output = renderContextBuildView(state, { styled: false });

    expect(output).toContain('No tasks to process; finalizing ingest');
    expect(output).toContain('last update 1m08s ago');
    expect(output).toContain('(1m53s)');
  });

  it('does not show progress age while updates are recent', () => {
    const state = initViewState([
      { connectionId: 'notion-main', driver: 'notion', operation: 'source-ingest', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);
    state.contextSources[0].status = 'running';
    state.contextSources[0].startedAt = 1_000;
    state.contextSources[0].elapsedMs = 40_000;
    state.contextSources[0].progressUpdatedAtMs = 25_000;
    state.contextSources[0].detailLine = '[45%] Planning tasks';

    const output = renderContextBuildView(state, { styled: false });

    expect(output).not.toContain('last update');
  });

  it('renders completion summary when all targets are done', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
      { connectionId: 'dbt-main', driver: 'dbt', operation: 'source-ingest', adapter: 'dbt', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);
    state.primarySources[0].status = 'done';
    state.primarySources[0].elapsedMs = 72000;
    state.contextSources[0].status = 'done';
    state.contextSources[0].elapsedMs = 34000;
    state.totalElapsedMs = 106000;

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Done in 1m46s · 2 sources processed');
  });

  it('renders singular source label in completion summary', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    state.primarySources[0].status = 'done';
    state.primarySources[0].elapsedMs = 5000;
    state.totalElapsedMs = 5000;

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Done in 5s · 1 source processed');
  });

  it('does not render completion summary while targets are still active', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
      { connectionId: 'dbt-main', driver: 'dbt', operation: 'source-ingest', adapter: 'dbt', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);
    state.primarySources[0].status = 'done';
    state.contextSources[0].status = 'running';
    state.totalElapsedMs = 30000;

    const output = renderContextBuildView(state, { styled: false });
    expect(output).not.toContain('Done in');
  });

  it('renders failed state', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    state.primarySources[0].status = 'failed';
    state.primarySources[0].failureText = 'KTX lost its connection to PostgreSQL while reading schema for warehouse.';

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('✗');
    expect(output).toContain('KTX lost its connection to PostgreSQL while reading schema for warehouse.');
  });

  it('omits empty groups', () => {
    const state = initViewState([
      { connectionId: 'dbt-main', driver: 'dbt', operation: 'source-ingest', adapter: 'dbt', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);

    const output = renderContextBuildView(state, { styled: false });
    expect(output).not.toContain('Databases:');
    expect(output).toContain('Context sources:');
  });

  it('renders foreground-only progress hints without detach or resume commands', () => {
    const state = initViewState([
      {
        connectionId: 'warehouse',
        driver: 'postgres',
        operation: 'database-ingest',
        debugCommand: 'ktx ingest warehouse --debug',
        steps: ['database-schema'],
      },
    ]);
    state.primarySources[0].status = 'running';

    const rendered = renderContextBuildView(state, { styled: false, showHint: true, projectDir: '/tmp/project' });

    expect(rendered).toContain('Ctrl+C to stop');
    expect(rendered).not.toContain('d to detach');
    expect(rendered).not.toContain('resume');
  });

  it('omits detach hint when all targets are done', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'database-ingest', debugCommand: '', steps: ['database-schema'] },
    ]);
    state.primarySources[0].status = 'done';
    state.totalElapsedMs = 5000;

    const output = renderContextBuildView(state, { styled: false, showHint: true });
    expect(output).not.toContain('Ctrl+C to stop');
  });
});

describe('renderContextBuildView phase rows', () => {
  function dbTarget(connectionId: string, queryHistoryEnabled = false) {
    return {
      connectionId,
      driver: 'postgres',
      operation: 'database-ingest' as const,
      debugCommand: '',
      steps: queryHistoryEnabled
        ? (['database-schema', 'query-history'] as ('database-schema' | 'query-history')[])
        : (['database-schema'] as ('database-schema' | 'query-history')[]),
      ...(queryHistoryEnabled ? { queryHistory: { enabled: true, dialect: 'postgres' as const } } : {}),
    };
  }

  function sourceTarget(connectionId: string) {
    return {
      connectionId,
      driver: 'dbt',
      operation: 'source-ingest' as const,
      adapter: 'dbt',
      debugCommand: '',
      steps: ['source-ingest', 'memory-update'] as ('source-ingest' | 'memory-update')[],
    };
  }

  function setPhase(
    state: ReturnType<typeof initViewState>,
    connectionId: string,
    phaseKey: 'database-schema' | 'query-history' | 'source-ingest',
    patch: Partial<ContextBuildTargetState['phases'][number]>,
  ): void {
    const target = [...state.primarySources, ...state.contextSources].find((t) => t.target.connectionId === connectionId);
    const phase = target?.phases.find((p) => p.key === phaseKey);
    if (!phase) throw new Error(`No phase ${phaseKey} on ${connectionId}`);
    Object.assign(phase, patch);
  }

  it('renders two phase rows for a database-ingest target with query history', () => {
    const state = initViewState([dbTarget('warehouse', true)]);
    state.primarySources[0].status = 'running';
    setPhase(state, 'warehouse', 'database-schema', {
      status: 'done',
      percent: 100,
      summary: '172 tables',
      elapsedMs: 52_000,
    });
    setPhase(state, 'warehouse', 'query-history', {
      status: 'running',
      percent: 7,
      detail: '12/172 · arr-movements',
      elapsedMs: 36_000,
    });

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Schema');
    expect(output).toContain('100%');
    expect(output).toContain('172 tables');
    expect(output).toContain('(52s)');
    expect(output).toContain('Query history');
    expect(output).toContain('7%');
    expect(output).toContain('12/172 · arr-movements');
    expect(output).toContain('(36s)');
  });

  it('renders a single Schema phase row when query history is disabled', () => {
    const state = initViewState([dbTarget('warehouse', false)]);
    state.primarySources[0].status = 'running';
    setPhase(state, 'warehouse', 'database-schema', {
      status: 'running',
      percent: 42,
      detail: 'Profiling 73/172 tables',
    });

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Schema');
    expect(output).toContain('42%');
    expect(output).toContain('Profiling 73/172 tables');
    expect(output).not.toContain('Query history');
  });

  it('renders Source ingest phase row for a source-ingest target', () => {
    const state = initViewState([sourceTarget('dbt-main')]);
    state.contextSources[0].status = 'running';
    setPhase(state, 'dbt-main', 'source-ingest', {
      status: 'running',
      percent: 25,
      detail: 'Reading models',
    });

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Source ingest');
    expect(output).toContain('25%');
    expect(output).toContain('Reading models');
    expect(output).not.toContain('Schema  ');
  });

  it('renders skipped Query history when schema phase fails', () => {
    const state = initViewState([dbTarget('warehouse', true)]);
    state.primarySources[0].status = 'running';
    setPhase(state, 'warehouse', 'database-schema', { status: 'failed', percent: 30 });
    setPhase(state, 'warehouse', 'query-history', { status: 'skipped' });

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Schema');
    expect(output).toContain('failed');
    expect(output).toContain('Query history');
    expect(output).toContain('skipped');
  });

  it('renders queued Query history with an em-dash and empty bar', () => {
    const state = initViewState([dbTarget('warehouse', true)]);
    state.primarySources[0].status = 'running';
    setPhase(state, 'warehouse', 'database-schema', {
      status: 'running',
      percent: 12,
      detail: 'Introspecting',
    });

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Query history');
    expect(output).toContain('queued');
    expect(output).toContain('—');
  });

  it('falls back to single-line legacy detail when no phase has started yet', () => {
    const state = initViewState([dbTarget('warehouse', false)]);
    state.primarySources[0].status = 'running';
    state.primarySources[0].detailLine = '[5%] Preparing database ingest';

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Preparing database ingest');
    expect(output).toContain('5%');
    expect(output).not.toContain('○ Schema');
  });
});

describe('createRepainter', () => {
  it('moves up visual rows, not just newline count, when content wraps', () => {
    const io = makeIo({ isTTY: true, columns: 5 });
    const repainter = createRepainter(io.io);

    repainter.paint('abcdefghijk\n');
    repainter.paint('updated\n');
    repainter.paint('done\n');

    const cursorMoves = [...io.stdout().matchAll(/\u001b\[(\d+)A\r/g)].map((match) => Number(match[1]));
    expect(cursorMoves).toEqual([3, 2]);
  });

  it('returns to the start of a single-line frame without moving up when content has no newline', () => {
    const io = makeIo({ isTTY: true, columns: 80 });
    const repainter = createRepainter(io.io);

    repainter.paint('hello');
    repainter.paint('bye');

    expect(io.stdout()).toContain('bye');
    expect(io.stdout()).not.toMatch(/\[\d+A/);
  });

  it('does not undershoot cursor-up when a line is exactly the terminal width', () => {
    const io = makeIo({ isTTY: true, columns: 10 });
    const repainter = createRepainter(io.io);

    repainter.paint('0123456789\nsecond\n');
    repainter.paint('0123456789\nsecond\n');

    const cursorMoves = [...io.stdout().matchAll(/\[(\d+)A/g)].map((m) => Number(m[1]));
    expect(cursorMoves).toEqual([2]);
  });
});

describe('runContextBuild', () => {
  it('executes scan targets before source-ingest targets', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      dbt_main: { driver: 'dbt' },
      warehouse: { driver: 'postgres' },
    });
    const callOrder: string[] = [];
    const executeTarget = vi.fn(async (target) => {
      callOrder.push(target.connectionId);
      return successResult(target.connectionId, target.driver, target.operation);
    });

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(callOrder).toEqual(['warehouse', 'dbt_main']);
  });

  it('runs only the requested connection when foreground build receives a target', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      docs: { driver: 'notion' },
    });
    const executeTarget = vi.fn(async (target) =>
      successResult(target.connectionId, target.driver, target.operation),
    );

    await expect(
      runContextBuild(
        project,
        {
          projectDir: '/tmp/project',
          inputMode: 'disabled',
          targetConnectionId: 'warehouse',
          all: false,
          depth: 'fast',
          queryHistory: 'default',
        },
        io.io,
        { executeTarget, now: () => 1000 },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(executeTarget).toHaveBeenCalledTimes(1);
    expect(executeTarget.mock.calls[0]?.[0]).toMatchObject({
      connectionId: 'warehouse',
      operation: 'database-ingest',
      databaseDepth: 'fast',
    });
    expect(io.stdout()).toContain('Databases:');
    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).not.toContain('docs');
  });

  it('returns exit code 1 when any target fails', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });
    const executeTarget = vi.fn(async (target) => failedResult(target.connectionId, target.driver, target.operation));

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toEqual({ exitCode: 1 });
  });

  it('renders a friendly network failure when target output contains a network error code', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });
    const executeTarget = vi.fn(async (target, _args, targetIo) => {
      targetIo.stderr.write('Error: read EADDRNOTAVAIL\n');
      return failedResult(target.connectionId, target.driver, target.operation);
    });

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(io.stdout()).toContain('KTX lost its connection to PostgreSQL while reading schema for warehouse.');
    expect(io.stdout()).toContain('network address unavailable (EADDRNOTAVAIL)');
    expect(io.stdout()).toContain('Retry: ktx setup --project-dir /tmp/project');
    expect(io.stdout()).not.toContain('BoundPool');
  });

  it('renders localhost SQL analysis refusal as a runtime failure during query history', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { depth: 'deep', queryHistory: { enabled: true } } },
    });
    const executeTarget = vi.fn(async (target, _args, targetIo) => {
      targetIo.stderr.write('connect ECONNREFUSED 127.0.0.1:8765\n');
      return {
        connectionId: target.connectionId,
        driver: target.driver,
        steps: [
          { operation: 'database-schema', status: 'done' },
          { operation: 'query-history', status: 'failed', detail: 'warehouse failed at query-history.' },
          { operation: 'source-ingest', status: 'skipped' },
          { operation: 'memory-update', status: 'skipped' },
        ],
      } satisfies KtxPublicIngestTargetResult;
    });

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(io.stdout()).toContain(
      'KTX could not reach the local SQL analysis runtime while processing query history for warehouse.',
    );
    expect(io.stdout()).toContain('connection refused (ECONNREFUSED)');
    expect(io.stdout()).toContain('Retry: ktx setup --project-dir /tmp/project');
    expect(io.stdout()).not.toContain('KTX lost its connection to PostgreSQL');
  });

  it('uses captured query-history stderr instead of generic failed-at detail', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { depth: 'deep', queryHistory: { enabled: true } } },
    });
    const executeTarget = vi.fn(async (target, _args, targetIo) => {
      targetIo.stdout.write('KTX scan completed\n');
      targetIo.stdout.write('Mode: enriched\n');
      targetIo.stderr.write('Missing bundled Python runtime manifest: /tmp/assets/python/manifest.json\n');
      targetIo.stderr.write('In a source checkout, build the local runtime assets with: pnpm run artifacts:build\n');
      targetIo.stderr.write('Then retry the runtime-backed KTX command.\n');
      return {
        connectionId: target.connectionId,
        driver: target.driver,
        steps: [
          { operation: 'database-schema', status: 'done' },
          {
            operation: 'query-history',
            status: 'failed',
            detail:
              'warehouse failed at query-history. Retry: ktx ingest warehouse --project-dir /tmp/project --deep --query-history',
          },
          { operation: 'source-ingest', status: 'skipped' },
          { operation: 'memory-update', status: 'skipped' },
        ],
      } satisfies KtxPublicIngestTargetResult;
    });

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled', entrypoint: 'ingest' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(io.stdout()).toContain('Missing bundled Python runtime manifest: /tmp/assets/python/manifest.json.');
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project --deep --query-history');
    expect(io.stdout()).not.toContain('Then retry the runtime-backed KTX command');
    expect(io.stdout()).not.toContain('warehouse failed at query-history');
    expect(io.stdout().match(/Retry: /g)).toHaveLength(1);
  });

  it('renders a friendly network failure when target execution throws', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const executeTarget = vi.fn(async () => {
      throw error;
    });

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(io.stdout()).toContain('KTX lost its connection to PostgreSQL while reading schema for warehouse.');
    expect(io.stdout()).toContain('connection reset (ECONNRESET)');
  });

  it('uses direct ingest retry guidance for public ingest failures', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });
    const executeTarget = vi.fn(async (target) => failedResult(target.connectionId, target.driver, target.operation));

    await runContextBuild(
      project,
      {
        projectDir: '/tmp/project',
        inputMode: 'disabled',
        targetConnectionId: 'warehouse',
        all: false,
        entrypoint: 'ingest',
      },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project');
    expect(io.stdout()).not.toContain('Retry: ktx setup');
  });

  it('renders query-history progress without the historic-sql adapter key', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: true } } },
    });
    const executeTarget = vi.fn(async (target, _args, _targetIo, deps) => {
      deps.ingestProgress?.({ percent: 5, message: 'Fetching source files for warehouse/historic-sql' });
      return successResult(target.connectionId, target.driver, target.operation);
    });

    await runContextBuild(
      project,
      {
        projectDir: '/tmp/project',
        inputMode: 'disabled',
        targetConnectionId: 'warehouse',
        all: false,
        entrypoint: 'ingest',
      },
      io.io,
      { executeTarget, now: () => 1000, sourceProgressThrottleMs: 0 },
    );

    expect(io.stdout()).toContain('Fetching query history for warehouse');
    expect(io.stdout()).not.toContain('historic-sql');
  });

  it('renders database ingest progress without scan wording', async () => {
    const io = makeIo();
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
    const executeTarget = vi.fn(async (target, _args, _targetIo, deps) => {
      await deps.scanProgress?.update(0.05, 'Preparing scan');
      await deps.scanProgress?.update(0.15, 'Inspecting database schema');
      await deps.scanProgress?.update(0.7, 'Writing schema artifacts');
      return successResult(target.connectionId, target.driver, target.operation);
    });

    await expect(
      runContextBuild(
        project,
        {
          projectDir: '/tmp/project',
          inputMode: 'disabled',
          targetConnectionId: 'warehouse',
          all: false,
        },
        io.io,
        { executeTarget, now: () => 1000, sourceProgressThrottleMs: 0 },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(io.stdout()).toContain('Preparing database ingest');
    expect(io.stdout()).toContain('Reading database schema');
    expect(io.stdout()).toContain('Writing schema context');
    expect(io.stdout()).not.toContain('Preparing scan');
    expect(io.stdout()).not.toMatch(/\bscan\b/i);
  });

  it('passes schema-first notices from the plan into foreground output', async () => {
    const io = makeIo();
    const project: KtxPublicIngestProject = {
      ...projectWithConnections({
        warehouse: { driver: 'postgres', context: { depth: 'deep' } },
      }),
      config: {
        ...projectWithConnections({ warehouse: { driver: 'postgres' } }).config,
        connections: {
          warehouse: { driver: 'postgres', context: { depth: 'deep' } },
        },
        llm: {
          provider: { backend: 'gateway', gateway: { api_key: 'env:KTX_GATEWAY_API_KEY' } },
          models: { default: 'gpt-test' },
        },
        scan: {
          ...projectWithConnections({ warehouse: { driver: 'postgres' } }).config.scan,
          enrichment: {
            mode: 'llm',
            embeddings: {
              backend: 'openai',
              model: 'text-embedding-3-small',
              dimensions: 1536,
            },
          },
        },
      },
    };
    const executeTarget = vi.fn(async (target) => successResult(target.connectionId, target.driver, target.operation));

    await expect(
      runContextBuild(
        project,
        {
          projectDir: '/tmp/project',
          inputMode: 'disabled',
          targetConnectionId: 'warehouse',
          all: false,
          queryHistory: 'enabled',
        },
        io.io,
        { executeTarget, now: () => 1000 },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(io.stdout()).toContain('Schema ingest runs before query history for warehouse.');
  });

  it('renders final view for non-TTY output', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      dbt_main: { driver: 'dbt' },
    });
    const executeTarget = vi.fn(async (target) => successResult(target.connectionId, target.driver, target.operation));

    await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    const output = io.stdout();
    expect(output).toContain('Building KTX context');
    expect(output).toContain('Project: /tmp/project');
    expect(output).toContain('Databases:');
    expect(output).toContain('warehouse');
    expect(output).toContain('Context sources:');
    expect(output).toContain('dbt_main');
  });

  it('passes scan mode and detect relationships through to target execution', async () => {
    const io = makeIo();
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
    const executeTarget = vi.fn(async (target) => successResult(target.connectionId, target.driver, target.operation));

    await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled', scanMode: 'enriched', detectRelationships: true },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(executeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'warehouse', operation: 'database-ingest' }),
      expect.objectContaining({ scanMode: 'enriched', detectRelationships: true }),
      expect.anything(),
      expect.objectContaining({
        scanProgress: expect.anything(),
        ingestProgress: expect.any(Function),
      }),
    );
  });

  it('calls onSourceProgress when sources start and finish', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      dbt_main: { driver: 'dbt' },
    });
    const progressUpdates: Array<Array<{ connectionId: string; status: string }>> = [];
    const executeTarget = vi.fn(async (target) => successResult(target.connectionId, target.driver, target.operation));

    await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      {
        executeTarget,
        now: () => 1000,
        onSourceProgress: (sources) => {
          progressUpdates.push(sources.map((s) => ({ connectionId: s.connectionId, status: s.status })));
        },
      },
    );

    expect(progressUpdates).toHaveLength(4);
    expect(progressUpdates[0]).toEqual([
      { connectionId: 'warehouse', status: 'running' },
      { connectionId: 'dbt_main', status: 'queued' },
    ]);
    expect(progressUpdates[1]).toEqual([
      { connectionId: 'warehouse', status: 'done' },
      { connectionId: 'dbt_main', status: 'queued' },
    ]);
    expect(progressUpdates[2]).toEqual([
      { connectionId: 'warehouse', status: 'done' },
      { connectionId: 'dbt_main', status: 'running' },
    ]);
    expect(progressUpdates[3]).toEqual([
      { connectionId: 'warehouse', status: 'done' },
      { connectionId: 'dbt_main', status: 'done' },
    ]);
  });

  it('publishes structured target progress without expanding the compact source rows', async () => {
    const io = makeIo({ isTTY: true });
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });
    const progressUpdates: Array<Array<{ connectionId: string; percent?: number; message?: string }>> = [];
    const executeTarget = vi.fn(async (target, _args, _targetIo, deps) => {
      await deps.scanProgress?.update(0.37, 'Generating descriptions 3/8 tables', { transient: true });
      return successResult(target.connectionId, target.driver, target.operation);
    });

    await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      {
        executeTarget,
        now: () => 1000,
        onSourceProgress: (sources) => {
          progressUpdates.push(
            sources.map((s) => ({
              connectionId: s.connectionId,
              ...(s.percent !== undefined ? { percent: s.percent } : {}),
              ...(s.message !== undefined ? { message: s.message } : {}),
            })),
          );
        },
        sourceProgressThrottleMs: 0,
      },
    );

    expect(progressUpdates).toContainEqual([
      { connectionId: 'warehouse', percent: 37, message: 'Generating descriptions 3/8 tables' },
    ]);
    expect(io.stdout()).toContain('Generating descriptions 3/8 tables');
  });

  it('returns report IDs and artifact paths parsed from target output', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      dbt_main: { driver: 'dbt' },
    });
    const executeTarget = vi.fn(async (target, _args, targetIo) => {
      if (target.operation === 'database-ingest') {
        targetIo.stdout.write('Report: raw-sources/warehouse/live-database/sync-1/scan-report.json\n');
        targetIo.stdout.write('Raw sources: raw-sources/warehouse/live-database/sync-1\n');
      } else {
        targetIo.stdout.write('Report: report-dbt-1\n');
        targetIo.stdout.write('Saved memory: 2 wiki, 3 SL\n');
      }
      return successResult(target.connectionId, target.driver, target.operation);
    });

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      reportIds: ['report-dbt-1'],
      artifactPaths: [
        'raw-sources/warehouse/live-database/sync-1/scan-report.json',
        'raw-sources/warehouse/live-database/sync-1',
      ],
    });
  });

  it('returns report IDs parsed from failed source-ingest target output', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      dbt_main: { driver: 'dbt' },
    });
    const executeTarget = vi.fn(async (target, _args, targetIo) => {
      if (target.operation === 'database-ingest') {
        return successResult(target.connectionId, target.driver, target.operation);
      }

      targetIo.stdout.write('Report: report-dbt-failed\n');
      targetIo.stdout.write('Tasks: 3\n');
      return failedResult(target.connectionId, target.driver, target.operation);
    });

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      reportIds: ['report-dbt-failed'],
    });
  });
});

describe('viewStateFromSourceProgress', () => {
  it('partitions sources into primary and context groups', () => {
    const state = viewStateFromSourceProgress(
      [
        { connectionId: 'warehouse', operation: 'database-ingest', status: 'running', startedAtMs: 900 },
        { connectionId: 'dbt-main', operation: 'source-ingest', status: 'queued' },
      ],
      1000,
      500,
    );

    expect(state.primarySources).toHaveLength(1);
    expect(state.primarySources[0].target.connectionId).toBe('warehouse');
    expect(state.primarySources[0].status).toBe('running');
    expect(state.primarySources[0].elapsedMs).toBe(100);
    expect(state.contextSources).toHaveLength(1);
    expect(state.contextSources[0].target.connectionId).toBe('dbt-main');
    expect(state.contextSources[0].status).toBe('queued');
    expect(state.totalElapsedMs).toBe(500);
  });

  it('uses stored elapsedMs for completed sources', () => {
    const state = viewStateFromSourceProgress(
      [{ connectionId: 'warehouse', operation: 'database-ingest', status: 'done', elapsedMs: 72000, summaryText: '42 tables' }],
      99999,
    );

    expect(state.primarySources[0].elapsedMs).toBe(72000);
    expect(state.primarySources[0].summaryText).toBe('42 tables');
  });

  it('renders the same view format as the foreground build', () => {
    const state = viewStateFromSourceProgress(
      [
        { connectionId: 'warehouse', operation: 'database-ingest', status: 'done', elapsedMs: 72000, summaryText: '42 tables' },
        { connectionId: 'dbt-main', operation: 'source-ingest', status: 'running', startedAtMs: 900 },
      ],
      1000,
      500,
    );

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Building KTX context');
    expect(output).toContain('Databases:');
    expect(output).toContain('warehouse');
    expect(output).toContain('42 tables');
    expect(output).toContain('Context sources:');
    expect(output).toContain('dbt-main');
    expect(output).toContain('ingesting...');
  });

  it('renders persisted percent and message as compact source-row progress', () => {
    const state = viewStateFromSourceProgress(
      [
        {
          connectionId: 'warehouse',
          operation: 'database-ingest',
          status: 'running',
          startedAtMs: 900,
          percent: 63,
          message: 'Building embeddings 2/4 batches',
          updatedAtMs: 950,
        },
      ],
      1000,
    );

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('warehouse');
    expect(output).toContain('63%');
    expect(output).toContain('Building embeddings 2/4 batches');
    expect(output.match(/warehouse/g)).toHaveLength(1);
  });
});
