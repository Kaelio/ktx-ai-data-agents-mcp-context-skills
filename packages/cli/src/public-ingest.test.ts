import { buildDefaultKtxProjectConfig, type KtxProjectConfig } from '@ktx/context/project';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPublicIngestPlan,
  type KtxPublicIngestDeps,
  type KtxPublicIngestProject,
  runKtxPublicIngest,
} from './public-ingest.js';

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
      ...buildDefaultKtxProjectConfig('warehouse'),
      connections,
    },
  };
}

function deepReadyProject(
  connections: KtxProjectConfig['connections'],
  relationshipsEnabled = true,
): KtxPublicIngestProject {
  const config = buildDefaultKtxProjectConfig('warehouse');
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
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      prod_metabase: { driver: 'metabase' },
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
          databaseDepth: 'fast',
          detectRelationships: false,
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

  it('rejects bare non-interactive ingest until the interactive confirmation slice exists', () => {
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });

    expect(() => buildPublicIngestPlan(project, { projectDir: '/tmp/project', all: false })).toThrow(
      'Context build requires a connection id or all targets',
    );
  });

  it('resolves database depth from flags, stored context, and defaults', () => {
    const project = projectWithConnections({
      fast_default: { driver: 'postgres' },
      deep_default: { driver: 'postgres', context: { depth: 'deep' } },
      docs: { driver: 'notion' },
    });

    expect(
      buildPublicIngestPlan(project, {
        projectDir: '/tmp/project',
        targetConnectionId: 'fast_default',
        all: false,
        queryHistory: 'default',
      }).targets[0],
    ).toMatchObject({ connectionId: 'fast_default', databaseDepth: 'fast', queryHistory: { enabled: false } });

    expect(
      buildPublicIngestPlan(project, {
        projectDir: '/tmp/project',
        targetConnectionId: 'deep_default',
        all: false,
        queryHistory: 'default',
      }).targets[0],
    ).toMatchObject({ connectionId: 'deep_default', databaseDepth: 'deep' });

    expect(
      buildPublicIngestPlan(project, {
        projectDir: '/tmp/project',
        targetConnectionId: 'docs',
        all: false,
        depth: 'deep',
        queryHistory: 'default',
      }).warnings,
    ).toEqual(['--deep affects database ingest only; ignoring it for docs.']);
  });

  it('upgrades effective depth when query history is explicitly enabled', () => {
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: false } } },
    });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'warehouse',
      all: false,
      depth: 'fast',
      queryHistory: 'enabled',
      queryHistoryWindowDays: 30,
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      databaseDepth: 'deep',
      queryHistory: { enabled: true, windowDays: 30, dialect: 'postgres' },
    });
    expect(plan.warnings).toEqual(['--query-history requires deep ingest; running warehouse with --deep.']);
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
      databaseDepth: 'fast',
      queryHistory: { enabled: false, unsupported: true },
    });
    expect(plan.warnings).toEqual(['--query-history is not supported for sqlite; running schema ingest for local.']);
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
      databaseDepth: 'deep',
      queryHistory: { enabled: true, dialect: 'postgres', windowDays: 30 },
      steps: ['database-schema', 'query-history'],
    });
  });

  it('adds a schema-first notice when query history is explicitly enabled', () => {
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
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
      databaseDepth: 'fast',
      queryHistory: { enabled: false, windowDays: 30, unsupported: true },
      steps: ['database-schema'],
    });
    expect(plan.warnings).toEqual(['--query-history is not supported for sqlite; running schema ingest for local.']);
  });

  it('aggregates ignored database-depth warnings for all source targets', () => {
    const plan = buildPublicIngestPlan(
      projectWithConnections({
        warehouse: { driver: 'postgres' },
        docs: { driver: 'notion' },
        dbt: { driver: 'dbt' },
      }),
      {
        projectDir: '/tmp/project',
        all: true,
        depth: 'deep',
        queryHistory: 'default',
      },
    );

    expect(plan.warnings).toEqual(['--deep ignored for 2 non-database sources.']);
  });

  it('records a preflight failure for deep database ingest when readiness config is missing', () => {
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
    });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'warehouse',
      all: false,
      queryHistory: 'default',
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      databaseDepth: 'deep',
      preflightFailure:
        'warehouse requires deep ingest readiness: model configuration, scan enrichment mode, scan embeddings. Run ktx setup or rerun with --fast.',
    });
  });

  it('honors scan.relationships.enabled when planning deep database ingest', () => {
    const plan = buildPublicIngestPlan(
      deepReadyProject({ warehouse: { driver: 'postgres', context: { depth: 'deep' } } }, false),
      {
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        queryHistory: 'default',
      },
    );

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      databaseDepth: 'deep',
      detectRelationships: false,
    });
  });
});

describe('runKtxPublicIngest', () => {
  it('maps fast and deep database targets to scan internals', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      fast: { driver: 'postgres' },
      deep: { driver: 'postgres', context: { depth: 'deep' } },
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
      expect.objectContaining({ connectionId: 'deep', mode: 'enriched', detectRelationships: true }),
      expect.anything(),
    );
    expect(runScan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ connectionId: 'fast', mode: 'structural', detectRelationships: false }),
      expect.anything(),
    );
  });

  it('runs query history after schema ingest with current-run window override', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: true, windowDays: 90 } } },
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

    expect(runScan).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'warehouse', mode: 'enriched' }),
      expect.anything(),
    );
    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        connectionId: 'warehouse',
        adapter: 'historic-sql',
        allowImplicitAdapter: true,
        historicSqlPullConfigOverride: expect.objectContaining({ dialect: 'postgres', windowDays: 30 }),
      }),
      expect.anything(),
    );
  });

  it('preserves configured query-history pull fields while overriding the current-run window', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: {
        driver: 'postgres',
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
      },
    });
    expect(ingestArgs?.historicSqlPullConfigOverride).not.toHaveProperty('enabled');
  });

  it('prints the schema-first notice for explicit query-history runs', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
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
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
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
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
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
          depth: 'fast',
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
        depth: 'fast',
        queryHistory: 'default',
      }),
      io.io,
    );
    expect(runScan).not.toHaveBeenCalled();
  });

  it('runs all independent targets and reports partial failures', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      prod_metabase: { driver: 'metabase' },
    });
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
        mode: 'structural',
        detectRelationships: false,
        dryRun: false,
      },
      expect.anything(),
    );
    expect(io.stdout()).toContain('Ingest finished with partial failures');
    expect(io.stdout()).toContain('warehouse failed at database-schema.');
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project --fast');
    expect(io.stdout()).not.toContain('Debug:');
  });

  it('prints query-history retry guidance for query-history facet failures', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async () => 1);

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
    ).resolves.toBe(1);

    expect(io.stdout()).toContain('warehouse failed at query-history.');
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project --deep --query-history');
    expect(io.stdout()).not.toContain('historic-sql');
  });

  it('fails deep-readiness targets before work starts while continuing independent --all targets', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
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
    expect(io.stdout()).toContain('warehouse requires deep ingest readiness');
  });

  it('can request enriched relationship scans for setup-managed context builds', async () => {
    const io = makeIo();
    const project = deepReadyProject({ warehouse: { driver: 'postgres' } });
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
        detectRelationships: true,
        dryRun: false,
      },
      expect.objectContaining({ capturedOutput: expect.any(Function) }),
    );
  });

  it('prints stable JSON results', async () => {
    const io = makeIo();
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });

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

  it('routes public status and watch to the ingest status renderer', async () => {
    const runIngest = vi.fn(async () => 0);
    const statusIo = makeIo();
    const watchIo = makeIo();

    await expect(
      runKtxPublicIngest(
        { command: 'status', projectDir: '/tmp/ktx', json: false, inputMode: 'disabled' },
        statusIo.io,
        { runIngest },
      ),
    ).resolves.toBe(0);
    await expect(
      runKtxPublicIngest(
        { command: 'watch', projectDir: '/tmp/ktx', runId: 'run-1', json: false, inputMode: 'auto' },
        watchIo.io,
        { runIngest },
      ),
    ).resolves.toBe(0);

    expect(runIngest).toHaveBeenNthCalledWith(
      1,
      {
        command: 'status',
        projectDir: '/tmp/ktx',
        outputMode: 'plain',
        inputMode: 'disabled',
      },
      statusIo.io,
    );
    expect(runIngest).toHaveBeenNthCalledWith(
      2,
      {
        command: 'watch',
        projectDir: '/tmp/ktx',
        runId: 'run-1',
        outputMode: 'viz',
        inputMode: 'auto',
      },
      watchIo.io,
    );
  });
});
