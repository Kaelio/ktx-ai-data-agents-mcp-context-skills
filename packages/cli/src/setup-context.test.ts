import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultKtxProjectConfig, parseKtxProjectConfig, serializeKtxProjectConfig, type KtxProjectConfig } from './context/project/config.js';
import { readKtxSetupState, writeKtxSetupState } from './context/project/setup-config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  contextBuildCommands,
  readKtxSetupContextState,
  runKtxSetupContextStep,
  type KtxSetupContextDeps,
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

type ReadyProjectOverrides = Omit<Partial<KtxProjectConfig>, 'ingest' | 'llm' | 'scan'> & {
  ingest?: Partial<KtxProjectConfig['ingest']>;
  llm?: Partial<KtxProjectConfig['llm']>;
  scan?: Omit<Partial<KtxProjectConfig['scan']>, 'enrichment' | 'relationships'> & {
    enrichment?: Partial<KtxProjectConfig['scan']['enrichment']>;
    relationships?: Partial<KtxProjectConfig['scan']['relationships']>;
  };
};

async function writeReadyProject(projectDir: string, overrides: ReadyProjectOverrides = {}) {
  const defaults = buildDefaultKtxProjectConfig();
  const readyConfig: KtxProjectConfig = {
    ...defaults,
    setup: { database_connection_ids: ['warehouse'] },
    connections: {
      warehouse: { driver: 'postgres', url: 'env:DATABASE_URL', context: { depth: 'deep' } },
      docs: { driver: 'notion', auth_token_ref: 'env:NOTION_TOKEN', crawl_mode: 'all_accessible' },
    },
    llm: {
      provider: { backend: 'anthropic' },
      models: { default: 'claude-sonnet-4-6' },
    },
    ingest: {
      ...defaults.ingest,
      embeddings: {
        backend: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
    },
    scan: {
      ...defaults.scan,
      enrichment: {
        mode: 'llm',
        embeddings: {
          backend: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
        },
      },
    },
  };
  const nextConfig: KtxProjectConfig = {
    ...readyConfig,
    ...overrides,
    setup: overrides.setup ?? readyConfig.setup,
    connections: overrides.connections ?? readyConfig.connections,
    llm: {
      ...readyConfig.llm,
      ...overrides.llm,
      provider: overrides.llm?.provider ?? readyConfig.llm.provider,
      models: overrides.llm?.models ?? readyConfig.llm.models,
    },
    ingest: {
      ...readyConfig.ingest,
      ...overrides.ingest,
      embeddings: overrides.ingest?.embeddings ?? readyConfig.ingest.embeddings,
      workUnits: overrides.ingest?.workUnits ?? readyConfig.ingest.workUnits,
    },
    scan: {
      ...readyConfig.scan,
      ...overrides.scan,
      enrichment: {
        ...readyConfig.scan.enrichment,
        ...(overrides.scan?.enrichment ?? {}),
      },
      relationships: {
        ...readyConfig.scan.relationships,
        ...(overrides.scan?.relationships ?? {}),
      },
    },
  };
  await writeFile(join(projectDir, 'ktx.yaml'), serializeKtxProjectConfig(nextConfig), 'utf-8');
  await writeKtxSetupState(projectDir, {
    completed_steps: ['project', 'llm', 'embeddings', 'databases', 'sources'],
  });
}

async function writeScanReport(
  projectDir: string,
  syncId: string,
  report: {
    mode: string;
    tableDescriptions: string;
    columnDescriptions: string;
    embeddings: string;
    manifestShards?: string[];
    completedStages?: string[];
    relationships?: { accepted: number; review: number; rejected: number; skipped: number };
  },
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
          manifestShards: report.manifestShards ?? ['semantic-layer/warehouse/_schema/public.yaml'],
          enrichmentArtifacts:
            report.mode === 'enriched'
              ? [`raw-sources/warehouse/live-database/${syncId}/enrichment/descriptions.json`]
              : [],
        },
        enrichment: {
          tableDescriptions: report.tableDescriptions,
          columnDescriptions: report.columnDescriptions,
          embeddings: report.embeddings,
          ...(report.relationships ? { relationships: report.relationships } : {}),
        },
        enrichmentState: {
          completedStages:
            report.completedStages ?? (report.tableDescriptions === 'completed' ? ['descriptions', 'embeddings'] : []),
          failedStages: report.tableDescriptions === 'failed' ? ['descriptions'] : [],
        },
        createdAt: syncId,
      },
      null,
      2,
    )}\n`,
  );
}

async function writeReadyEnrichedScanReport(
  projectDir: string,
  syncId = '2026-05-09T10:00:00.000Z',
  overrides: Partial<Parameters<typeof writeScanReport>[2]> = {},
) {
  await writeScanReport(projectDir, syncId, {
    mode: 'enriched',
    tableDescriptions: 'completed',
    columnDescriptions: 'completed',
    embeddings: 'completed',
    completedStages: ['descriptions', 'embeddings', 'relationships'],
    relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
    ...overrides,
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
      status: 'stale',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: ['docs'],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir),
      failureReason: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.',
      sourceProgress: [
        {
          connectionId: 'warehouse',
          operation: 'database-ingest',
          status: 'running',
          percent: 42,
          message: 'Generating descriptions 4/10 tables',
          updatedAtMs: 1000,
        },
      ],
    });

    const state = await readKtxSetupContextState(tempDir);
    expect(state).toMatchObject({
      runId: 'setup-context-local-abc123',
      status: 'stale',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: ['docs'],
      commands: {
        build: `ktx setup --project-dir ${tempDir}`,
        status: `ktx status --project-dir ${tempDir}`,
      },
      failureReason: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.',
      sourceProgress: [
        {
          connectionId: 'warehouse',
          operation: 'database-ingest',
          status: 'running',
          percent: 42,
          message: 'Generating descriptions 4/10 tables',
          updatedAtMs: 1000,
        },
      ],
    });
    expect(JSON.stringify(state)).not.toContain('DATABASE_URL');
    expect(JSON.stringify(state)).not.toContain('NOTION_TOKEN');
  });

  it('runs setup context build, verifies readiness, and marks context complete', async () => {
    await writeReadyProject(tempDir);
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({
      exitCode: 0,
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
      }),
      io.io,
      expect.objectContaining({ onSourceProgress: expect.any(Function) }),
    );
    expect(verifyContextReady).toHaveBeenCalledWith(tempDir);
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('context');
    await expect(readKtxSetupContextState(tempDir)).resolves.toMatchObject({
      runId: 'setup-context-local-abc123',
      status: 'completed',
      completedAt: '2026-05-09T10:00:00.000Z',
      reportIds: ['report-docs-1'],
      artifactPaths: ['raw-sources/warehouse/live-database/sync-1/scan-report.json'],
    });
    expect(io.stdout()).toContain('KTX context is ready for agents.');
    expect(io.stdout()).toContain('Databases:');
    expect(io.stdout()).not.toContain(['Primary sources', ':'].join(''));
  });

  it('records only failed sources as retryable when the context build fails', async () => {
    await writeReadyProject(tempDir);
    const io = makeIo();
    const runContextBuildMock = vi.fn(async (_project, _args, _io, hooks) => {
      hooks.onSourceProgress?.([
        { connectionId: 'warehouse', operation: 'database-ingest', status: 'done', elapsedMs: 1000 },
        { connectionId: 'docs', operation: 'source-ingest', status: 'failed', elapsedMs: 2000 },
      ]);
      return {
        exitCode: 1,
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
        { connectionId: 'warehouse', operation: 'database-ingest', status: 'done', elapsedMs: 1000 },
        { connectionId: 'docs', operation: 'source-ingest', status: 'failed', elapsedMs: 2000 },
      ],
    });
  });

  it('marks context complete without prompting when initial source ingest already made agent context', async () => {
    await writeReadyProject(tempDir);
    await mkdir(join(tempDir, 'semantic-layer', 'dbt-main'), { recursive: true });
    await mkdir(join(tempDir, 'wiki', 'global'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'dbt-main', 'mart_revenue_daily.yaml'), 'name: mart_revenue_daily\n');
    await writeFile(join(tempDir, 'wiki', 'global', 'metrics.md'), '# Metrics\n');
    await writeReadyEnrichedScanReport(tempDir);
    const io = makeIo();
    const runContextBuildMock = vi.fn<NonNullable<KtxSetupContextDeps['runContextBuild']>>(async () => ({
      exitCode: 0,
    }));

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
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('context');
    await expect(readKtxSetupContextState(tempDir)).resolves.toMatchObject({
      runId: 'setup-context-local-existing',
      status: 'completed',
      completedAt: '2026-05-09T10:00:00.000Z',
      contextSourceConnectionIds: ['docs'],
    });
    expect(io.stdout()).toContain('KTX context is ready for agents.');
    expect(io.stdout()).not.toContain(['Primary sources', ':'].join(''));
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
      return { exitCode: 0 };
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

  it('treats fast database context as ready from schema manifest shards without AI artifacts', async () => {
    await writeReadyProject(tempDir, {
      connections: {
        warehouse: { driver: 'postgres', readonly: true, context: { depth: 'fast' } },
      },
      llm: { provider: { backend: 'none' }, models: {} },
      scan: { enrichment: { mode: 'none' } },
    });
    await mkdir(join(tempDir, 'semantic-layer', 'warehouse', '_schema'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'warehouse', '_schema', 'public.yaml'), 'tables: {}\n');
    await writeScanReport(tempDir, '2026-05-09T10:00:00.000Z', {
      mode: 'structural',
      tableDescriptions: 'skipped',
      columnDescriptions: 'skipped',
      embeddings: 'skipped',
      manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn<NonNullable<KtxSetupContextDeps['runContextBuild']>>(async () => ({
      exitCode: 0,
    }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        {
          runContextBuild: runContextBuildMock,
        },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(runContextBuildMock).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Existing context artifacts were found from setup ingest.');
  });

  it('stores fast context depth non-interactively when deep readiness is missing', async () => {
    await writeReadyProject(tempDir, {
      connections: { warehouse: { driver: 'postgres', readonly: true } },
      llm: { provider: { backend: 'none' }, models: {} },
      scan: { enrichment: { mode: 'none' } },
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn<NonNullable<KtxSetupContextDeps['runContextBuild']>>(async () => ({
      exitCode: 0,
    }));
    const verifyContextReady = vi.fn(async () => ({
      ready: true,
      agentContextReady: true,
      semanticSearchReady: true,
      details: ['ready'],
    }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock, verifyContextReady },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse.context).toMatchObject({ depth: 'fast' });
    expect(runContextBuildMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectDir: tempDir, inputMode: 'disabled' }),
      expect.anything(),
      expect.anything(),
    );
    expect(runContextBuildMock.mock.calls[0]?.[1]).not.toMatchObject({
      scanMode: 'enriched',
      detectRelationships: true,
    });
  });

  it('prompts for database context depth after final readiness is known', async () => {
    await writeReadyProject(tempDir, {
      connections: { warehouse: { driver: 'postgres', readonly: true } },
      llm: {
        provider: { backend: 'gateway', gateway: { api_key: 'env:KTX_GATEWAY_API_KEY' } }, // pragma: allowlist secret
        models: { default: 'gpt-test' },
      },
      scan: {
        enrichment: {
          mode: 'llm',
          embeddings: { backend: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
        },
      },
    });
    const io = makeIo();
    const select = vi.fn(async () => 'deep');
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0 }));
    const verifyContextReady = vi.fn(async () => ({
      ready: true,
      agentContextReady: true,
      semanticSearchReady: true,
      details: ['ready'],
    }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'auto' },
        io.io,
        {
          prompts: { select, cancel: vi.fn() },
          runContextBuild: runContextBuildMock,
          verifyContextReady,
        },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('How much database context should KTX build?'),
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse.context).toMatchObject({ depth: 'deep' });
  });

  it('requires completed relationships for deep context when relationship discovery is enabled', async () => {
    await writeReadyProject(tempDir, {
      connections: {
        warehouse: { driver: 'postgres', readonly: true, context: { depth: 'deep' } },
      },
      scan: { relationships: { enabled: true } },
    });
    await mkdir(join(tempDir, 'semantic-layer', 'dbt-main'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'dbt-main', 'mart_revenue_daily.yaml'), 'name: mart_revenue_daily\n');
    await writeReadyEnrichedScanReport(tempDir, '2026-05-09T10:00:00.000Z', {
      completedStages: ['descriptions', 'embeddings'],
      relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => {
      await writeReadyEnrichedScanReport(tempDir, '2026-05-09T10:01:00.000Z', {
        completedStages: ['descriptions', 'embeddings', 'relationships'],
        relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
      });
      return { exitCode: 0 };
    });

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(runContextBuildMock).toHaveBeenCalledOnce();
  });

  it('does not require relationships for deep context when relationship discovery is disabled', async () => {
    await writeReadyProject(tempDir, {
      connections: {
        warehouse: { driver: 'postgres', readonly: true, context: { depth: 'deep' } },
      },
      scan: { relationships: { enabled: false } },
    });
    await mkdir(join(tempDir, 'semantic-layer', 'dbt-main'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'dbt-main', 'mart_revenue_daily.yaml'), 'name: mart_revenue_daily\n');
    await writeReadyEnrichedScanReport(tempDir, '2026-05-09T10:00:00.000Z', {
      completedStages: ['descriptions', 'embeddings'],
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0 }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(runContextBuildMock).not.toHaveBeenCalled();
  });

  it('refuses empty setup context builds', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
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

    expect(io.stderr()).toContain('No databases or context sources are configured for a KTX context build.');
  });

  it('starts a fresh foreground build when stale state is found', async () => {
    await writeReadyProject(tempDir, {
      connections: { warehouse: { driver: 'postgres', readonly: true, context: { depth: 'fast' } } },
    });
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-stale',
      status: 'stale',
      startedAt: '2026-05-09T09:00:00.000Z',
      updatedAt: '2026-05-09T09:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir),
      failureReason: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.',
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0 }));
    const verifyContextReady = vi.fn(async () => ({
      ready: true,
      agentContextReady: true,
      semanticSearchReady: true,
      details: ['ready'],
    }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock, verifyContextReady },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(runContextBuildMock).toHaveBeenCalledOnce();
  });
});
