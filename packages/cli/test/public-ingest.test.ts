import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultKtxProjectConfig, type KtxProjectConfig } from '../src/context/project/config.js';
import { initKtxProject } from '../src/context/project/project.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPublicIngestPlan,
  type KtxPublicIngestDeps,
  type KtxPublicIngestProject,
  publicProgressMessage,
  runKtxPublicIngest,
} from '../src/public-ingest.js';
import type { ManagedPythonCommandRuntime } from '../src/managed-python-command.js';

function makeIo(options: { isTTY?: boolean; interactive?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      ...(options.interactive
        ? {
            stdin: {
              isTTY: true,
              setRawMode: vi.fn(),
            },
          }
        : {}),
      stdout: {
        isTTY: options.isTTY,
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
      ...buildDefaultKtxProjectConfig(),
      connections,
    },
  };
}

function deepReadyProject(
  connections: KtxProjectConfig['connections'],
  relationshipsEnabled = true,
): KtxPublicIngestProject {
  const config = buildDefaultKtxProjectConfig();
  return {
    projectDir: '/tmp/project',
    config: {
      ...config,
      connections,
      llm: {
        ...config.llm,
        provider: { backend: 'gateway', gateway: { api_key: 'env:KTX_GATEWAY_API_KEY' } }, // pragma: allowlist secret
        models: { default: 'gpt-test' },
      },
      scan: {
        ...config.scan,
        enrichment: {
          mode: 'llm',
          embeddings: {
            backend: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
          },
        },
        relationships: {
          ...config.scan.relationships,
          enabled: relationshipsEnabled,
        },
      },
    },
  };
}

describe('buildPublicIngestPlan', () => {
  it('plans warehouse connections as scan targets and source connections as source ingest targets', () => {
    const project = deepReadyProject({
      warehouse: { driver: 'postgres' },
      prod_metabase: { driver: 'metabase', api_url: 'https://metabase.example.com' },
      docs: { driver: 'notion' },
    });

    expect(buildPublicIngestPlan(project, { projectDir: '/tmp/project', all: true })).toEqual({
      projectDir: '/tmp/project',
      targets: [
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          operation: 'database-ingest',
          debugCommand: 'ktx ingest warehouse --debug',
          steps: ['database-schema'],
          detectRelationships: true,
          queryHistory: { enabled: false },
        },
        {
          connectionId: 'docs',
          driver: 'notion',
          operation: 'source-ingest',
          adapter: 'notion',
          debugCommand: 'ktx ingest docs --debug',
          steps: ['source-ingest', 'memory-update'],
        },
        {
          connectionId: 'prod_metabase',
          driver: 'metabase',
          operation: 'source-ingest',
          adapter: 'metabase',
          debugCommand: 'ktx ingest prod_metabase --debug',
          steps: ['source-ingest', 'memory-update'],
        },
      ],
      warnings: [],
    });
  });

  it('treats a bare invocation (no connection id, no --all) as all configured connections', () => {
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      docs: { driver: 'notion' },
    });

    const plan = buildPublicIngestPlan(project, { projectDir: '/tmp/project', all: false });

    expect(plan.targets.map((target) => target.connectionId).sort()).toEqual(['docs', 'warehouse']);
  });

  it('rejects stale local Looker source driver aliases', () => {
    const project = projectWithConnections({
      local_looker: { driver: 'local_looker' } as never,
    });

    expect(() => buildPublicIngestPlan(project, { projectDir: '/tmp/project', all: true })).toThrow(
      'unsupported public ingest driver "local_looker"',
    );
  });

  it('enables query history when explicitly requested even if stored config disables it', () => {
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: false } } },
    });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'warehouse',
      all: false,
      queryHistory: 'enabled',
      queryHistoryWindowDays: 30,
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      queryHistory: { enabled: true, windowDays: 30, dialect: 'postgres' },
      steps: ['database-schema', 'query-history'],
    });
    expect(plan.warnings).toEqual([]);
  });

  it('warns and skips query history for unsupported database drivers', () => {
    const project = projectWithConnections({ local: { driver: 'sqlite' } });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'local',
      all: false,
      queryHistory: 'enabled',
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'local',
      queryHistory: { enabled: false, unsupported: true },
    });
    expect(plan.warnings).toEqual(['--query-history is not supported for sqlite; running schema ingest for local.']);
  });

  it('aggregates unsupported query-history warnings for all database targets', () => {
    const plan = buildPublicIngestPlan(
      deepReadyProject({
        local: { driver: 'sqlite' },
        mysql_warehouse: { driver: 'mysql' },
        warehouse: { driver: 'postgres' },
      }),
      {
        projectDir: '/tmp/project',
        all: true,
        queryHistory: 'enabled',
      },
    );

    expect(plan.targets).toEqual([
      expect.objectContaining({
        connectionId: 'local',
        queryHistory: { enabled: false, unsupported: true },
        steps: ['database-schema'],
      }),
      expect.objectContaining({
        connectionId: 'mysql_warehouse',
        queryHistory: { enabled: false, unsupported: true },
        steps: ['database-schema'],
      }),
      expect.objectContaining({
        connectionId: 'warehouse',
        queryHistory: expect.objectContaining({ enabled: true, dialect: 'postgres' }),
        steps: ['database-schema', 'query-history'],
      }),
    ]);
    expect(plan.warnings).toEqual([
      '--query-history is not supported for 2 database connections (mysql, sqlite); running schema ingest for those connections.',
    ]);
  });

  it('aggregates stored unsupported query-history config warnings for all database targets', () => {
    const plan = buildPublicIngestPlan(
      projectWithConnections({
        local: { driver: 'sqlite', context: { queryHistory: { enabled: true } } },
        mysql_warehouse: { driver: 'mysql', context: { queryHistory: { enabled: true } } },
      }),
      {
        projectDir: '/tmp/project',
        all: true,
        queryHistory: 'default',
      },
    );

    expect(plan.targets).toEqual([
      expect.objectContaining({
        connectionId: 'local',
        queryHistory: { enabled: false, unsupported: true },
        steps: ['database-schema'],
      }),
      expect.objectContaining({
        connectionId: 'mysql_warehouse',
        queryHistory: { enabled: false, unsupported: true },
        steps: ['database-schema'],
      }),
    ]);
    expect(plan.warnings).toEqual([
      '2 database connections have query history enabled in ktx.yaml, but their drivers do not support it; running schema ingest for those connections.',
    ]);
  });

  it('treats query-history window override as current-run query-history enablement', () => {
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: false, windowDays: 90 } } },
    });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'warehouse',
      all: false,
      queryHistory: 'default',
      queryHistoryWindowDays: 30,
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      queryHistory: { enabled: true, dialect: 'postgres', windowDays: 30 },
      steps: ['database-schema', 'query-history'],
    });
  });

  it('adds a schema-first notice when query history is explicitly enabled', () => {
    const project = deepReadyProject({
      warehouse: { driver: 'postgres' },
    });

    expect(
      buildPublicIngestPlan(project, {
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        queryHistory: 'enabled',
      }).notices,
    ).toEqual(['Schema ingest runs before query history for warehouse.']);
  });

  it('warns and skips query-history window override for unsupported database drivers', () => {
    const plan = buildPublicIngestPlan(
      projectWithConnections({
        local: { driver: 'sqlite' },
      }),
      {
        projectDir: '/tmp/project',
        targetConnectionId: 'local',
        all: false,
        queryHistory: 'default',
        queryHistoryWindowDays: 30,
      },
    );

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'local',
      queryHistory: { enabled: false, windowDays: 30, unsupported: true },
      steps: ['database-schema'],
    });
    expect(plan.warnings).toEqual(['--query-history is not supported for sqlite; running schema ingest for local.']);
  });

  it('records a preflight failure for database ingest when enrichment readiness config is missing', () => {
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'warehouse',
      all: false,
      queryHistory: 'default',
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      preflightFailure:
        'warehouse cannot be ingested: enrichment is not configured (model configuration, scan enrichment mode, scan embeddings). Run ktx setup to configure a model and embeddings.',
    });
  });

  it('honors scan.relationships.enabled when planning database ingest', () => {
    const plan = buildPublicIngestPlan(
      deepReadyProject({ warehouse: { driver: 'postgres' } }, false),
      {
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        queryHistory: 'default',
      },
    );

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      detectRelationships: false,
    });
  });
});

describe('publicProgressMessage', () => {
  it('rewrites internal scan and historic-sql phrasing for public ingest progress', () => {
    const databaseProject = deepReadyProject({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: true, dialect: 'postgres' } } },
    });
    const databaseTarget = buildPublicIngestPlan(databaseProject, {
      projectDir: '/tmp/project',
      all: false,
      targetConnectionId: 'warehouse',
      queryHistory: 'default',
    }).targets[0];

    expect(databaseTarget).toBeDefined();
    expect(publicProgressMessage('Inspecting database schema', databaseTarget)).toBe('Reading database schema');
    expect(publicProgressMessage('Enriching schema metadata', databaseTarget)).toBe(
      'Building enriched schema context',
    );
    expect(publicProgressMessage('Fetching source files for warehouse/historic-sql', databaseTarget)).toBe(
      'Fetching query history for warehouse',
    );
  });
});

describe('runKtxPublicIngest', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps database targets to enriched scan internals', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      first: { driver: 'postgres' },
      second: { driver: 'postgres' },
    });
    const runScan = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        { command: 'run', projectDir: '/tmp/project', all: true, json: false, inputMode: 'disabled', queryHistory: 'default' },
        io.io,
        { loadProject: vi.fn(async () => project), runScan },
      ),
    ).resolves.toBe(0);

    expect(runScan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ connectionId: 'first', mode: 'enriched', detectRelationships: true }),
      expect.anything(),
    );
    expect(runScan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ connectionId: 'second', mode: 'enriched', detectRelationships: true }),
      expect.anything(),
    );
  });

  it('emits debug telemetry for ingest targets and project snapshots without project paths', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-public-ingest-telemetry-'));
    try {
      await initKtxProject({ projectDir });
      const io = makeIo({ isTTY: true });
      const project = deepReadyProject({
        warehouse: { driver: 'sqlite', path: join(projectDir, 'warehouse.sqlite') },
      });

      const code = await runKtxPublicIngest(
        { command: 'run', projectDir, targetConnectionId: 'warehouse', all: false, json: false, inputMode: 'disabled' },
        io.io,
        { loadProject: vi.fn(async () => project), runScan: vi.fn(async () => 0) },
      );

      expect(code).toBe(0);
      expect(io.stderr()).toContain('"event":"ingest_completed"');
      expect(io.stderr()).toContain('"event":"project_stack_snapshot"');
      expect(io.stderr()).not.toContain(projectDir);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('runs query history after schema ingest with current-run window override', async () => {
    const io = makeIo();
    const runtimeIo = makeIo({ isTTY: true });
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: true, windowDays: 90 } } },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn<NonNullable<KtxPublicIngestDeps['runIngest']>>(async () => 0);
    const deps = {
      loadProject: vi.fn(async () => project),
      runScan,
      runIngest,
      runtimeIo: runtimeIo.io,
    } as KtxPublicIngestDeps & { runtimeIo: typeof runtimeIo.io };

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          cliVersion: '0.0.0-test',
          runtimeInstallPolicy: 'never',
          queryHistory: 'enabled',
          queryHistoryWindowDays: 30,
        },
        io.io,
        deps,
      ),
    ).resolves.toBe(0);

    expect(runScan).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'warehouse', mode: 'enriched' }),
      expect.anything(),
      expect.objectContaining({ runtimeIo: runtimeIo.io }),
    );
    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        connectionId: 'warehouse',
        adapter: 'historic-sql',
        allowImplicitAdapter: true,
        cliVersion: '0.0.0-test',
        runtimeInstallPolicy: 'never',
        historicSqlPullConfigOverride: expect.objectContaining({ dialect: 'postgres', windowDays: 30 }),
      }),
      expect.anything(),
      expect.objectContaining({ runtimeIo: runtimeIo.io }),
    );
  });

  it('preserves configured query-history pull fields while overriding the current-run window', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: {
        driver: 'postgres',
        enabled_tables: ['orbit_analytics.int_active_contract_arr'],
        context: {
          queryHistory: {
            enabled: true,
            windowDays: 90,
            minExecutions: 7,
            concurrency: 3,
            staleArchiveAfterDays: 120,
            filters: {
              dropTrivialProbes: true,
              serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
              orchestrators: { mode: 'mark-only' },
              dropFailedBelow: { errorRate: 0.5, executions: 3 },
            },
            redactionPatterns: ['(?i)secret'],
          },
        },
      },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn<NonNullable<KtxPublicIngestDeps['runIngest']>>(async () => 0);

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'enabled',
          queryHistoryWindowDays: 30,
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    const ingestArgs = runIngest.mock.calls[0]?.[0] as
      | Extract<Parameters<NonNullable<KtxPublicIngestDeps['runIngest']>>[0], { command: 'run' }>
      | undefined;
    expect(ingestArgs).toMatchObject({
      command: 'run',
      connectionId: 'warehouse',
      adapter: 'historic-sql',
      allowImplicitAdapter: true,
      historicSqlPullConfigOverride: {
        dialect: 'postgres',
        windowDays: 30,
        minExecutions: 7,
        concurrency: 3,
        staleArchiveAfterDays: 120,
        filters: {
          dropTrivialProbes: true,
          serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
          orchestrators: { mode: 'mark-only' },
          dropFailedBelow: { errorRate: 0.5, executions: 3 },
        },
        redactionPatterns: ['(?i)secret'],
        enabledTables: ['orbit_analytics.int_active_contract_arr'],
      },
    });
    expect(ingestArgs?.historicSqlPullConfigOverride).not.toHaveProperty('enabled');
  });

  it('prints the schema-first notice for explicit query-history runs', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres' },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'enabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Schema ingest runs before query history for warehouse.');
  });

  it('suppresses internal scan output for public database ingest summaries', async () => {
    const io = makeIo();
    const project = deepReadyProject({ warehouse: { driver: 'postgres' } });
    const runScan = vi.fn(async (_args, scanIo) => {
      scanIo.stdout.write('KTX scan completed\n');
      scanIo.stdout.write('Mode: structural\n');
      scanIo.stdout.write('Report: raw-sources/warehouse/live-database/sync-1/scan-report.json\n');
      scanIo.stdout.write('Raw sources: raw-sources/warehouse/live-database/sync-1\n');
      return 0;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Ingest finished\n');
    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).not.toContain('KTX scan completed');
    expect(io.stdout()).not.toContain('Mode: structural');
    expect(io.stdout()).not.toContain('Report: raw-sources');
    expect(io.stdout()).not.toContain('live-database');
  });

  it('sanitizes captured database scan failure details in direct public output', async () => {
    const io = makeIo();
    const project = deepReadyProject({ warehouse: { driver: 'postgres' } });
    const runScan = vi.fn(async (_args, scanIo) => {
      scanIo.stdout.write('KTX scan enrichment failed after structural scan completed: embedding service timed out\n');
      return 1;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan },
      ),
    ).resolves.toBe(1);

    expect(io.stdout()).toContain(
      'warehouse failed: Database enrichment failed after schema context completed: embedding service timed out.',
    );
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project');
    expect(io.stdout()).not.toContain('KTX scan enrichment failed');
    expect(io.stdout()).not.toContain('structural scan');
  });

  it('suppresses lower-level source report output during direct public source ingest', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      docs: { driver: 'notion' },
    });
    const runIngest = vi.fn(async (_args, ingestIo) => {
      ingestIo.stdout.write('Report: report-docs-1\n');
      ingestIo.stdout.write('Adapter: notion\n');
      ingestIo.stdout.write('Saved memory: 2 wiki, 0 SL\n');
      return 0;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'docs',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Ingest finished');
    expect(io.stdout()).toContain('docs');
    expect(io.stdout()).toContain('Source ingest');
    expect(io.stdout()).not.toContain('Report: report-docs-1');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stdout()).not.toContain('notion\n');
    expect(io.stderr()).toBe('');
  });

  it('suppresses historic-sql report output during direct public query-history ingest', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres' },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async (_args, ingestIo) => {
      ingestIo.stdout.write('Report: report-query-history-1\n');
      ingestIo.stdout.write('Adapter: historic-sql\n');
      ingestIo.stdout.write('Saved memory: 1 wiki, 1 SL\n');
      return 0;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'enabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Schema ingest runs before query history for warehouse.');
    expect(io.stdout()).toContain('Ingest finished');
    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).toContain('done');
    expect(io.stdout()).not.toContain('Report: report-query-history-1');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stdout()).not.toContain('historic-sql');
    expect(io.stderr()).toBe('');
  });

  it('streams plain non-json progress to stderr while keeping final results on stdout', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: true, dialect: 'postgres' } } },
      docs: { driver: 'notion' },
    });
    const runScan = vi.fn<NonNullable<KtxPublicIngestDeps['runScan']>>(async (_args, scanIo, deps) => {
      scanIo.stdout.write('KTX scan completed\n');
      scanIo.stdout.write('Report: raw-sources/warehouse/live-database/sync-1/scan-report.json\n');
      await deps?.progress?.update(0.12, 'Inspecting database schema');
      const enrichmentProgress = deps?.progress?.startPhase(0.5);
      await enrichmentProgress?.update(0.75, 'Enriching schema metadata', { transient: true });
      await deps?.progress?.update(1, 'Writing schema artifacts');
      return 0;
    });
    const runIngest = vi.fn<NonNullable<KtxPublicIngestDeps['runIngest']>>(async (ingestArgs, ingestIo, deps) => {
      ingestIo.stdout.write(`Adapter: ${ingestArgs.adapter}\n`);
      ingestIo.stdout.write('Report: report-progress-1\n');
      if (ingestArgs.adapter === 'historic-sql') {
        deps?.progress?.({ percent: 15, message: 'Fetching source files for warehouse/historic-sql' });
        deps?.progress?.({ percent: 90, message: 'Saved memory: 1 wiki, 1 SL' });
        return 0;
      }
      deps?.progress?.({ percent: 55, message: 'Processing 3/8 tasks' });
      deps?.progress?.({ percent: 90, message: 'Saved memory: 6 wiki, 2 SL' });
      return 0;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          all: true,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'default',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Ingest finished');
    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).toContain('docs');
    expect(io.stdout()).not.toContain('KTX scan completed');
    expect(io.stdout()).not.toContain('Report:');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stderr()).toContain('[1/2] warehouse · database schema\n');
    expect(io.stderr()).toContain('  [12%] Reading database schema\n');
    expect(io.stderr()).toContain('  [50%] Building enriched schema context\n');
    expect(io.stderr()).toContain('[1/2] warehouse · query history\n');
    expect(io.stderr()).toContain('  [15%] Fetching query history for warehouse\n');
    expect(io.stderr()).toContain('[2/2] docs · source ingest\n');
    expect(io.stderr()).toContain('  [55%] Processing 3/8 tasks\n');
    expect(io.stderr()).not.toContain('\r');
  });

  it('does not emit plain progress for json public ingest output', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres' },
    });
    const runScan = vi.fn<NonNullable<KtxPublicIngestDeps['runScan']>>(async (_args, _scanIo, deps) => {
      expect(deps?.progress).toBeUndefined();
      return 0;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: true,
          inputMode: 'disabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      plan: { projectDir: '/tmp/project' },
      results: [{ connectionId: 'warehouse', driver: 'postgres' }],
    });
    expect(io.stderr()).toBe('');
  });

  it('keeps captured failure details when plain progress ports are active', async () => {
    const io = makeIo();
    const project = deepReadyProject({ warehouse: { driver: 'postgres' } });
    const runScan = vi.fn<NonNullable<KtxPublicIngestDeps['runScan']>>(async (_args, scanIo, deps) => {
      await deps?.progress?.update(0.42, 'Enriching schema metadata');
      scanIo.stdout.write('KTX scan enrichment failed after structural scan completed: embedding service timed out\n');
      return 1;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('warehouse · database schema\n');
    expect(io.stderr()).toContain('  [42%] Building enriched schema context\n');
    expect(io.stderr()).toContain('  failed\n');
    expect(io.stdout()).toContain(
      'warehouse failed: Database enrichment failed after schema context completed: embedding service timed out.',
    );
    expect(io.stdout()).not.toContain('KTX scan enrichment failed');
    expect(io.stdout()).not.toContain('structural scan');
  });

  it('delegates interactive TTY public ingest to the foreground context-build view', async () => {
    const io = makeIo({ isTTY: true, interactive: true });
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
    const runContextBuild = vi.fn(async () => ({ exitCode: 0 }));
    const runScan = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'auto',
          queryHistory: 'default',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runContextBuild, runScan },
      ),
    ).resolves.toBe(0);

    expect(runContextBuild).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        entrypoint: 'ingest',
        queryHistory: 'default',
      }),
      io.io,
    );
    expect(runScan).not.toHaveBeenCalled();
  });

  it('preflights foreground query-history runtime before starting the context-build view', async () => {
    const io = makeIo({ isTTY: true, interactive: true });
    const calls: string[] = [];
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });
    const ensureRuntime = vi.fn(async (): Promise<ManagedPythonCommandRuntime> => {
      calls.push('runtime');
      return {} as ManagedPythonCommandRuntime;
    });
    const runContextBuild = vi.fn(async () => {
      calls.push('context-build');
      return { exitCode: 0 };
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'auto',
          queryHistory: 'enabled',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'prompt',
        },
        io.io,
        {
          loadProject: vi.fn(async () => project),
          ensureRuntime,
          runContextBuild,
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['runtime', 'context-build']);
    expect(ensureRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        cliVersion: '0.2.0',
        installPolicy: 'prompt',
        feature: 'core',
      }),
    );
  });

  it('preflights foreground managed embeddings runtime before starting the context-build view', async () => {
    const io = makeIo({ isTTY: true, interactive: true });
    const config = buildDefaultKtxProjectConfig();
    const project: KtxPublicIngestProject = {
      projectDir: '/tmp/project',
      config: {
        ...config,
        connections: {
          warehouse: { driver: 'postgres' },
        },
        ingest: {
          ...config.ingest,
          embeddings: {
            backend: 'sentence-transformers',
            model: 'all-MiniLM-L6-v2',
            dimensions: 384,
          },
        },
      },
    };
    const ensureRuntime = vi.fn(async (): Promise<ManagedPythonCommandRuntime> => {
      return {} as ManagedPythonCommandRuntime;
    });
    const runContextBuild = vi.fn(async () => ({ exitCode: 0 }));

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'auto',
          queryHistory: 'default',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'prompt',
        },
        io.io,
        {
          loadProject: vi.fn(async () => project),
          ensureRuntime,
          runContextBuild,
        },
      ),
    ).resolves.toBe(0);

    expect(ensureRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        cliVersion: '0.2.0',
        installPolicy: 'prompt',
        feature: 'local-embeddings',
      }),
    );
    expect(runContextBuild).toHaveBeenCalled();
  });

  it('runs all independent targets and reports partial failures', async () => {
    const io = makeIo();
    const project = deepReadyProject(
      {
        warehouse: { driver: 'postgres' },
        prod_metabase: { driver: 'metabase', api_url: 'https://metabase.example.com' },
      },
      false,
    );
    const runScan = vi.fn(async () => 1);
    const runIngest = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        { command: 'run', projectDir: '/tmp/project', all: true, json: false, inputMode: 'disabled' },
        io.io,
        {
          loadProject: vi.fn(async () => project),
          runScan,
          runIngest,
        },
      ),
    ).resolves.toBe(1);

    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'prod_metabase',
        adapter: 'metabase',
        allowImplicitAdapter: true,
        outputMode: 'plain',
        inputMode: 'disabled',
      }),
      expect.anything(),
    );
    expect(runScan).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: false,
        dryRun: false,
      },
      expect.anything(),
    );
    expect(io.stdout()).toContain('Ingest finished with partial failures');
    expect(io.stdout()).toContain('warehouse failed at database-schema.');
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project');
    expect(io.stdout()).not.toContain('Debug:');
  });

  it('skips the query-history facet but keeps the target green when query-history fails', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres' },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async (_args, ingestIo) => {
      ingestIo.stdout.write(
        'Error: Query history failed for 60 tasks. First failure: Google Cloud authentication failed while analyzing query history: application-default credentials expired or require reauthentication (invalid_grant / invalid_rapt). Run `gcloud auth application-default login`, then retry.\n',
      );
      return 1;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'enabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Ingest finished with skipped query history');
    expect(io.stdout()).toMatch(/warehouse\s+done\s+skipped\s+skipped\s+skipped/);
    expect(io.stdout()).toContain('Skipped query history:');
    expect(io.stdout()).toContain(
      'Query history failed for 60 tasks. First failure: Google Cloud authentication failed while analyzing query history',
    );
    expect(io.stdout()).not.toContain('warehouse failed: Error:');
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project --query-history');
    expect(io.stdout()).not.toContain('historic-sql');
  });

  it('prints the runtime artifact build hint for missing query-history runtime assets', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres' },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async (_args, ingestIo) => {
      ingestIo.stderr.write('Missing bundled Python runtime manifest: /repo/packages/cli/assets/python/manifest.json\n');
      ingestIo.stderr.write('In a source checkout, build the local runtime assets with: pnpm run artifacts:build\n');
      ingestIo.stderr.write('Then retry the runtime-backed KTX command.\n');
      return 1;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'enabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Ingest finished with skipped query history');
    expect(io.stdout()).toContain('Missing bundled Python runtime manifest');
    expect(io.stdout()).toContain(
      'In a source checkout, build the local runtime assets with: pnpm run artifacts:build',
    );
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project --query-history');
    expect(io.stdout()).not.toContain('Then retry the runtime-backed KTX command');
  });

  it('fails enrichment-readiness targets before work starts while continuing independent --all targets', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      docs: { driver: 'notion' },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        { command: 'run', projectDir: '/tmp/project', all: true, json: false, inputMode: 'disabled' },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(1);

    expect(runScan).not.toHaveBeenCalled();
    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run', connectionId: 'docs', adapter: 'notion' }),
      expect.anything(),
    );
    expect(io.stdout()).toContain('warehouse cannot be ingested: enrichment is not configured');
  });

  it('drives scan relationship detection from project config, not from legacy args', async () => {
    const io = makeIo();
    const project = deepReadyProject({ warehouse: { driver: 'postgres' } }, false);
    const runScan = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          all: true,
          json: false,
          inputMode: 'disabled',
          scanMode: 'enriched',
          detectRelationships: true,
        },
        io.io,
        {
          loadProject: vi.fn(async () => project),
          runScan,
        },
      ),
    ).resolves.toBe(0);

    expect(runScan).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: false,
        dryRun: false,
      },
      expect.objectContaining({ capturedOutput: expect.any(Function) }),
    );
  });

  it('prints stable JSON results', async () => {
    const io = makeIo();
    const project = deepReadyProject({ warehouse: { driver: 'postgres' } });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: true,
          inputMode: 'disabled',
        },
        io.io,
        {
          loadProject: vi.fn(async () => project),
          runScan: vi.fn(async () => 0),
        },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      plan: { projectDir: '/tmp/project' },
      results: [{ connectionId: 'warehouse', driver: 'postgres' }],
    });
  });

  it('passes dbt source_dir from connection config to runKtxIngest', async () => {
    const runIngest = vi.fn(async () => 0);
    const io = makeIo();

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/ktx',
          targetConnectionId: 'analytics_dbt',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        {
          loadProject: async () =>
            ({
              projectDir: '/tmp/ktx',
              config: {
                connections: {
                  analytics_dbt: {
                    driver: 'dbt',
                    source_dir: '/repo/dbt',
                  },
                },
              },
            }) as never,
          runIngest,
        },
      ),
    ).resolves.toBe(0);

    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        connectionId: 'analytics_dbt',
        adapter: 'dbt',
        sourceDir: '/repo/dbt',
      }),
      expect.objectContaining({ capturedOutput: expect.any(Function) }),
    );
  });

  it('bypasses adapter allow-lists for connection-centric source ingest', async () => {
    const runIngest = vi.fn(async () => 0);
    const io = makeIo();

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/ktx',
          targetConnectionId: 'docs',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        {
          loadProject: async () =>
            projectWithConnections({
              docs: { driver: 'notion' },
            }),
          runIngest,
        },
      ),
    ).resolves.toBe(0);

    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        connectionId: 'docs',
        adapter: 'notion',
        allowImplicitAdapter: true,
      }),
      expect.objectContaining({ capturedOutput: expect.any(Function) }),
    );
  });

});
