import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKtxSetupState } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  contextBuildCommands,
  readKtxSetupContextState,
  runKtxSetupContextStep,
  writeKtxSetupContextState,
} from './setup-context.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
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

async function writeReadyProject(projectDir: string) {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: revenue',
      'setup:',
      '  database_connection_ids:',
      '    - warehouse',
      '  completed_steps:',
      '    - project',
      '    - llm',
      '    - embeddings',
      '    - databases',
      '    - sources',
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      '    url: env:DATABASE_URL',
      '  docs:',
      '    driver: notion',
      '    auth_token_ref: env:NOTION_TOKEN',
      '    crawl_mode: all_accessible',
      'llm:',
      '  provider:',
      '    backend: anthropic',
      '  models:',
      '    default: claude-sonnet-4-6',
      'ingest:',
      '  embeddings:',
      '    backend: openai',
      '    model: text-embedding-3-small',
      '    dimensions: 1536',
      'scan:',
      '  enrichment:',
      '    mode: llm',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function writeScanReport(
  projectDir: string,
  syncId: string,
  report: { mode: string; tableDescriptions: string; columnDescriptions: string; embeddings: string },
) {
  const reportDir = join(projectDir, 'raw-sources', 'warehouse', 'live-database', syncId);
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    join(reportDir, 'scan-report.json'),
    `${JSON.stringify(
      {
        connectionId: 'warehouse',
        mode: report.mode,
        dryRun: false,
        artifactPaths: {
          manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
          enrichmentArtifacts:
            report.mode === 'enriched'
              ? [`raw-sources/warehouse/live-database/${syncId}/enrichment/descriptions.json`]
              : [],
        },
        enrichment: {
          tableDescriptions: report.tableDescriptions,
          columnDescriptions: report.columnDescriptions,
          embeddings: report.embeddings,
        },
        enrichmentState: {
          completedStages: report.tableDescriptions === 'completed' ? ['descriptions', 'embeddings'] : [],
          failedStages: report.tableDescriptions === 'failed' ? ['descriptions'] : [],
        },
        createdAt: syncId,
      },
      null,
      2,
    )}\n`,
  );
}

async function writeReadyEnrichedScanReport(projectDir: string, syncId = '2026-05-09T10:00:00.000Z') {
  await writeScanReport(projectDir, syncId, {
    mode: 'enriched',
    tableDescriptions: 'completed',
    columnDescriptions: 'completed',
    embeddings: 'completed',
  });
}

describe('setup context build state', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-context-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads missing state as not started and writes durable command metadata without secrets', async () => {
    await expect(readKtxSetupContextState(tempDir)).resolves.toMatchObject({ status: 'not_started' });

    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-abc123',
      status: 'running',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: ['docs'],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-abc123'),
    });

    const state = await readKtxSetupContextState(tempDir);
    expect(state).toMatchObject({
      runId: 'setup-context-local-abc123',
      status: 'running',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: ['docs'],
      commands: {
        watch: `ktx setup --project-dir ${tempDir}`,
        status: `ktx status --project-dir ${tempDir}`,
        resume: `ktx setup --project-dir ${tempDir}`,
      },
    });
    expect(JSON.stringify(state)).not.toContain('DATABASE_URL');
    expect(JSON.stringify(state)).not.toContain('NOTION_TOKEN');
  });

  it('runs setup context build, verifies readiness, and marks context complete', async () => {
    await writeReadyProject(tempDir);
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({
      exitCode: 0,
      detached: false,
      reportIds: ['report-docs-1'],
      artifactPaths: ['raw-sources/warehouse/live-database/sync-1/scan-report.json'],
    }));
    const verifyContextReady = vi.fn(async () => ({
      ready: true,
      agentContextReady: true,
      semanticSearchReady: true,
      details: ['warehouse: enriched scan complete', 'docs: memory update complete'],
    }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        {
          runIdFactory: () => 'setup-context-local-abc123',
          now: () => new Date('2026-05-09T10:00:00.000Z'),
          runContextBuild: runContextBuildMock,
          verifyContextReady,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-abc123' });

    expect(runContextBuildMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      expect.objectContaining({
        projectDir: tempDir,
        inputMode: 'disabled',
        scanMode: 'enriched',
        detectRelationships: true,
      }),
      io.io,
      expect.objectContaining({ onDetach: expect.any(Function) }),
    );
    expect(verifyContextReady).toHaveBeenCalledWith(tempDir);
    await expect(readKtxSetupState(tempDir)).resolves.toEqual({
      completed_steps: ['context'],
    });
    await expect(readKtxSetupContextState(tempDir)).resolves.toMatchObject({
      runId: 'setup-context-local-abc123',
      status: 'completed',
      completedAt: '2026-05-09T10:00:00.000Z',
      reportIds: ['report-docs-1'],
      artifactPaths: ['raw-sources/warehouse/live-database/sync-1/scan-report.json'],
    });
    expect(io.stdout()).toContain('KTX context is ready for agents.');
  });

  it('records only failed sources as retryable when the context build fails', async () => {
    await writeReadyProject(tempDir);
    const io = makeIo();
    const runContextBuildMock = vi.fn(async (_project, _args, _io, hooks) => {
      hooks.onSourceProgress?.([
        { connectionId: 'warehouse', operation: 'scan', status: 'done', elapsedMs: 1000 },
        { connectionId: 'docs', operation: 'source-ingest', status: 'failed', elapsedMs: 2000 },
      ]);
      return {
        exitCode: 1,
        detached: false,
        reportIds: ['report-docs-failed'],
        artifactPaths: ['raw-sources/docs/notion/sync-1/ingest-report.json'],
      };
    });

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        {
          runIdFactory: () => 'setup-context-local-failed',
          now: () => new Date('2026-05-09T10:00:00.000Z'),
          runContextBuild: runContextBuildMock,
        },
      ),
    ).resolves.toEqual({ status: 'failed', projectDir: tempDir });

    await expect(readKtxSetupContextState(tempDir)).resolves.toMatchObject({
      runId: 'setup-context-local-failed',
      status: 'failed',
      reportIds: ['report-docs-failed'],
      artifactPaths: ['raw-sources/docs/notion/sync-1/ingest-report.json'],
      retryableFailedTargets: ['docs'],
      sourceProgress: [
        { connectionId: 'warehouse', operation: 'scan', status: 'done', elapsedMs: 1000 },
        { connectionId: 'docs', operation: 'source-ingest', status: 'failed', elapsedMs: 2000 },
      ],
    });
  });

  it('marks context complete without prompting when initial source ingest already made agent context', async () => {
    await writeReadyProject(tempDir);
    await mkdir(join(tempDir, 'semantic-layer', 'dbt-main'), { recursive: true });
    await mkdir(join(tempDir, 'knowledge', 'global'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'dbt-main', 'mart_revenue_daily.yaml'), 'name: mart_revenue_daily\n');
    await writeFile(join(tempDir, 'knowledge', 'global', 'metrics.md'), '# Metrics\n');
    await writeReadyEnrichedScanReport(tempDir);
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0, detached: false }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'auto' },
        io.io,
        {
          prompts: {
            select: vi.fn(async () => {
              throw new Error('setup should not prompt when context is already ready');
            }),
            cancel: vi.fn(),
          },
          runIdFactory: () => 'setup-context-local-existing',
          now: () => new Date('2026-05-09T10:00:00.000Z'),
          runContextBuild: runContextBuildMock,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-existing' });

    expect(runContextBuildMock).not.toHaveBeenCalled();
    await expect(readKtxSetupState(tempDir)).resolves.toEqual({
      completed_steps: ['context'],
    });
    await expect(readKtxSetupContextState(tempDir)).resolves.toMatchObject({
      runId: 'setup-context-local-existing',
      status: 'completed',
      completedAt: '2026-05-09T10:00:00.000Z',
      contextSourceConnectionIds: ['docs'],
    });
    expect(io.stdout()).toContain('KTX context is ready for agents.');
  });

  it('does not mark context ready until primary scans have completed description enrichment', async () => {
    await writeReadyProject(tempDir);
    await mkdir(join(tempDir, 'semantic-layer', 'dbt-main'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'dbt-main', 'mart_revenue_daily.yaml'), 'name: mart_revenue_daily\n');
    await writeScanReport(tempDir, '2026-05-09T09:59:00.000Z', {
      mode: 'structural',
      tableDescriptions: 'skipped',
      columnDescriptions: 'skipped',
      embeddings: 'skipped',
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => {
      await writeReadyEnrichedScanReport(tempDir, '2026-05-09T10:00:00.000Z');
      return { exitCode: 0, detached: false };
    });

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        {
          runIdFactory: () => 'setup-context-local-enriched-scan',
          now: () => new Date('2026-05-09T10:00:00.000Z'),
          runContextBuild: runContextBuildMock,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-enriched-scan' });

    expect(runContextBuildMock).toHaveBeenCalledOnce();
    expect(io.stdout()).not.toContain('Existing context artifacts were found from setup ingest.');
  });

  it('does not treat schema-only scan shards as completed setup context', async () => {
    await writeReadyProject(tempDir);
    await mkdir(join(tempDir, 'semantic-layer', 'warehouse', '_schema'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'warehouse', '_schema', 'public.yaml'), 'tables: {}\n');
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => {
      await mkdir(join(tempDir, 'knowledge', 'global'), { recursive: true });
      await writeFile(join(tempDir, 'knowledge', 'global', 'metrics.md'), '# Metrics\n');
      await writeReadyEnrichedScanReport(tempDir);
      return { exitCode: 0, detached: false };
    });

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        {
          runIdFactory: () => 'setup-context-local-schema-only',
          now: () => new Date('2026-05-09T10:00:00.000Z'),
          runContextBuild: runContextBuildMock,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-schema-only' });

    expect(runContextBuildMock).toHaveBeenCalledOnce();
    expect(io.stdout()).not.toContain('Existing context artifacts were found from setup ingest.');
  });

  it('refuses empty setup context builds', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: revenue',
        'connections: {}',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runIdFactory: () => 'setup-context-local-empty' },
      ),
    ).resolves.toEqual({ status: 'failed', projectDir: tempDir });

    expect(io.stderr()).toContain('No primary or context sources are configured for a KTX context build.');
  });

  it('watches an already-running setup context build from the resume prompt', async () => {
    await writeReadyProject(tempDir);
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-resume-watch',
      status: 'detached',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: ['docs'],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-resume-watch'),
    });
    const io = makeIo();
    const completeRun = async () => {
      await writeKtxSetupContextState(tempDir, {
        runId: 'setup-context-local-resume-watch',
        status: 'completed',
        startedAt: '2026-05-09T10:00:00.000Z',
        updatedAt: '2026-05-09T10:02:00.000Z',
        completedAt: '2026-05-09T10:02:00.000Z',
        primarySourceConnectionIds: ['warehouse'],
        contextSourceConnectionIds: ['docs'],
        reportIds: [],
        artifactPaths: [],
        retryableFailedTargets: [],
        commands: contextBuildCommands(tempDir, 'setup-context-local-resume-watch'),
      });
    };
    const select = vi.fn(async (options: { options: Array<{ value: string; label: string }> }) => {
      expect(options.options.map((option) => option.label)).toContain('Watch progress');
      return 'watch';
    });

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'auto' },
        io.io,
        {
          prompts: { select, cancel: vi.fn() },
          sleep: completeRun,
          watchIntervalMs: 1,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-resume-watch' });
    expect(io.stdout()).toContain('KTX context built: detached');
    expect(io.stdout()).toContain('KTX context built: yes');
  });

  it('auto-watches a running build without prompting when autoWatch is true', async () => {
    await writeReadyProject(tempDir);
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-auto-watch',
      status: 'detached',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-auto-watch'),
    });
    const io = makeIo();
    const completeRun = async () => {
      await writeKtxSetupContextState(tempDir, {
        runId: 'setup-context-local-auto-watch',
        status: 'completed',
        startedAt: '2026-05-09T10:00:00.000Z',
        updatedAt: '2026-05-09T10:02:00.000Z',
        completedAt: '2026-05-09T10:02:00.000Z',
        primarySourceConnectionIds: ['warehouse'],
        contextSourceConnectionIds: [],
        reportIds: [],
        artifactPaths: [],
        retryableFailedTargets: [],
        commands: contextBuildCommands(tempDir, 'setup-context-local-auto-watch'),
      });
    };
    const select = vi.fn(async () => {
      throw new Error('should not prompt when autoWatch is true');
    });

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'auto', autoWatch: true },
        io.io,
        {
          prompts: { select, cancel: vi.fn() },
          sleep: completeRun,
          watchIntervalMs: 1,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-auto-watch' });
    expect(select).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('KTX context built: yes');
  });

  it('renders the progress view when watching a build with sourceProgress', async () => {
    await writeReadyProject(tempDir);
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-progress',
      status: 'detached',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: ['docs'],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-progress'),
      sourceProgress: [
        { connectionId: 'warehouse', operation: 'scan' as const, status: 'done' as const, elapsedMs: 30000 },
        { connectionId: 'docs', operation: 'source-ingest' as const, status: 'running' as const, startedAtMs: Date.now() - 5000 },
      ],
    });
    const io = makeIo();
    const completeRun = async () => {
      await writeKtxSetupContextState(tempDir, {
        runId: 'setup-context-local-progress',
        status: 'completed',
        startedAt: '2026-05-09T10:00:00.000Z',
        updatedAt: '2026-05-09T10:02:00.000Z',
        completedAt: '2026-05-09T10:02:00.000Z',
        primarySourceConnectionIds: ['warehouse'],
        contextSourceConnectionIds: ['docs'],
        reportIds: [],
        artifactPaths: [],
        retryableFailedTargets: [],
        commands: contextBuildCommands(tempDir, 'setup-context-local-progress'),
        sourceProgress: [
          { connectionId: 'warehouse', operation: 'scan' as const, status: 'done' as const, elapsedMs: 30000 },
          { connectionId: 'docs', operation: 'source-ingest' as const, status: 'done' as const, elapsedMs: 60000 },
        ],
      });
    };
    const select = vi.fn(async () => 'watch');

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'auto' },
        io.io,
        {
          prompts: { select, cancel: vi.fn() },
          sleep: completeRun,
          watchIntervalMs: 1,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-progress' });

    const output = io.stdout();
    expect(output).toContain('Building KTX context');
    expect(output).toContain('Primary sources:');
    expect(output).toContain('warehouse');
    expect(output).toContain('Context sources:');
    expect(output).toContain('docs');
    expect(output).not.toContain('KTX context built: detached');
  });

  it('supports d to detach from the progress watch view', async () => {
    await writeReadyProject(tempDir);
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-detach',
      status: 'running',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-detach'),
      sourceProgress: [
        { connectionId: 'warehouse', operation: 'scan' as const, status: 'running' as const, startedAtMs: Date.now() },
      ],
    });
    const io = makeIo();
    let triggerDetach: (() => void) | null = null;

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'auto', autoWatch: true },
        io.io,
        {
          sleep: async () => { triggerDetach?.(); },
          watchIntervalMs: 1,
          setupKeystroke: (onDetach) => {
            triggerDetach = onDetach;
            return () => {};
          },
        },
      ),
    ).resolves.toMatchObject({ status: 'detached' });

    const output = io.stdout();
    expect(output).toContain('Building KTX context');
    expect(output).toContain('Context build continuing in the background.');
    expect(output).toContain('Resume: ktx setup --project-dir');
  });
});
