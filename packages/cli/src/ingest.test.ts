import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalLookerRuntimeStore,
  LocalMetabaseSourceStateReader,
  type LocalIngestResult,
  type LocalMetabaseFanoutProgress,
  type RunLocalIngestOptions,
  type SourceAdapter,
} from '@ktx/context/ingest';
import { initKtxProject, ktxLocalStateDbPath, loadKtxProject } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KtxIngestArgs, runKtxIngest } from './ingest.js';
import type { KtxCliLocalIngestAdaptersOptions } from './local-adapters.js';
import {
  CliLookerSlWritingAgentRunner,
  CliMetabaseAgentRunner,
  CliMetabaseSourceAdapter,
  completedLocalBundleRun,
  failedLocalBundleRun,
  localFakeBundleReport,
  makeCliLookerParser,
  makeCliLookerRuntimeClient,
  makeIo,
  persistLocalBundleReport,
  runPublicMetabaseSyncModeCase,
  writeMetabaseConfig,
  writeWarehouseConfig,
} from './ingest.test-utils.js';
import { resetVizFallbackWarningsForTest } from './viz-fallback.js';
import { runKtxSetup } from './setup.js';

describe('runKtxIngest', () => {
  let tempDir: string;
  let originalTerm: string | undefined;
  const interactiveEnv = (): NodeJS.ProcessEnv => ({ ...process.env, CI: 'false' });

  beforeEach(async () => {
    resetVizFallbackWarningsForTest();
    originalTerm = process.env.TERM;
    process.env.TERM = 'xterm-256color';
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-ingest-'));
  });

  afterEach(async () => {
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs local ingest and reads status', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      const result = completedLocalBundleRun(input, 'cli-local-run-1');
      await persistLocalBundleReport(projectDir, result.report);
      return result;
    });

    const runIo = makeIo();
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        runIo.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'cli-local-run-1',
        },
      ),
    ).resolves.toBe(0);

    expect(runIo.stdout()).toContain('Report: report-live-1');
    expect(runIo.stdout()).toContain('Run: run-live-1');
    expect(runIo.stdout()).toContain('Job: cli-local-run-1');
    expect(runIo.stdout()).toContain('Status: done');
    expect(runIo.stdout()).toContain('Diff: +2/~0/-0/=0');
    expect(runIo.stdout()).toContain('Saved memory: 1 wiki, 1 SL');

    const statusIo = makeIo();
    await expect(
      runKtxIngest({ command: 'status', projectDir, runId: 'cli-local-run-1', outputMode: 'plain' }, statusIo.io),
    ).resolves.toBe(0);

    expect(statusIo.stdout()).toContain('Report: report-live-1');
    expect(statusIo.stdout()).toContain('Run: run-live-1');
    expect(statusIo.stdout()).toContain('Job: cli-local-run-1');
    expect(statusIo.stdout()).toContain('Status: done');
    expect(statusIo.stdout()).toContain('Diff: +2/~0/-0/=0');
    expect(statusIo.stderr()).toBe('');
  });

  it('prints provider setup guidance when a skip-llm setup project runs ingest', async () => {
    const projectDir = join(tempDir, 'project');
    const setupIo = makeIo();
    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir,
          mode: 'new',
          agents: false,
          agentScope: 'project',
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.0.0-test',
          skipLlm: true,
          skipEmbeddings: true,
          databaseDrivers: ['postgres'],
          databaseConnectionId: 'warehouse',
          databaseUrl: 'env:WAREHOUSE_URL',
          databaseSchemas: [],
          enableHistoricSql: true,
          skipDatabases: false,
          skipSources: true,
        },
        setupIo.io,
        {
          databasesDeps: {
            testConnection: async (_projectDir, _connectionId, io) => {
              io.stdout.write('Driver: postgres\nTables: 1\n');
              return 0;
            },
            scanConnection: async () => 0,
            historicSqlProbe: async () => ({ ok: true, lines: ['PASS Historic SQL probe skipped in test'] }),
          },
          context: async () => ({ status: 'skipped', projectDir }),
        },
      ),
    ).resolves.toBe(0);

    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runIo = makeIo();
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'historic-sql',
          sourceDir,
          outputMode: 'plain',
        },
        runIo.io,
      ),
    ).resolves.toBe(1);

    expect(runIo.stdout()).toBe('');
    expect(runIo.stderr()).toContain(
      'ktx ingest run requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner.',
    );
    expect(runIo.stderr()).toContain(
      `ktx setup --project-dir ${projectDir} --anthropic-api-key-env ANTHROPIC_API_KEY --anthropic-model claude-sonnet-4-6 --no-input`,
    );
  });

  it('routes metabase scheduled pulls to the fan-out runner and prints child summaries', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();
    const report = localFakeBundleReport('metabase-child-1', {
      id: 'report-metabase-child-1',
      runId: 'run-a',
      jobId: 'metabase-child-1',
      connectionId: 'warehouse_a',
      sourceKey: 'metabase',
    });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalMetabaseIngest: async () => ({
            metabaseConnectionId: 'prod-metabase',
            status: 'all_succeeded',
            totals: { workUnits: 2, failedWorkUnits: 0 },
            children: [
              {
                jobId: 'metabase-child-1',
                metabaseConnectionId: 'prod-metabase',
                metabaseDatabaseId: 1,
                targetConnectionId: 'warehouse_a',
                result: {
                  jobId: 'metabase-child-1',
                  runId: 'run-a',
                  syncId: 'sync-a',
                  diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
                  workUnitCount: 1,
                  failedWorkUnits: [],
                  artifactsWritten: 0,
                  commitSha: null,
                },
                report,
              },
            ],
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
    expect(io.stdout()).toContain('warehouse_a');
    expect(io.stdout()).toContain('metabase-child-1');
    expect(io.stderr()).toContain('Metabase ingest: prod-metabase');
  });

  it('returns a non-zero code when Metabase fan-out has failed children', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();
    const report = localFakeBundleReport('metabase-child-1', {
      id: 'report-metabase-child-1',
      runId: 'run-a',
      jobId: 'metabase-child-1',
      connectionId: 'warehouse_a',
      sourceKey: 'metabase',
      body: {
        failedWorkUnits: ['metabase-db-1'],
        workUnits: [
          {
            unitKey: 'metabase-db-1',
            rawFiles: ['cards/1.json'],
            status: 'failed',
            reason: 'tool write failed',
            actions: [],
            touchedSlSources: [],
          },
        ],
      },
    });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalMetabaseIngest: async () => ({
            metabaseConnectionId: 'prod-metabase',
            status: 'partial_failure',
            totals: { workUnits: 1, failedWorkUnits: 1 },
            children: [
              {
                jobId: 'metabase-child-1',
                metabaseConnectionId: 'prod-metabase',
                metabaseDatabaseId: 1,
                targetConnectionId: 'warehouse_a',
                result: {
                  jobId: 'metabase-child-1',
                  runId: 'run-a',
                  syncId: 'sync-a',
                  diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
                  workUnitCount: 1,
                  failedWorkUnits: ['metabase-db-1'],
                  artifactsWritten: 0,
                  commitSha: null,
                },
                report,
              },
            ],
          }),
        },
      ),
    ).resolves.toBe(1);

    expect(io.stdout()).toContain('Metabase fan-out: partial_failure');
    expect(io.stdout()).toContain('Failed work units: 1');
    expect(io.stdout()).toContain('status=error');
    expect(io.stderr()).toContain('Metabase ingest: prod-metabase');
  });

  it('prints Metabase fan-out progress before the final summary', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();
    const report = localFakeBundleReport('metabase-child-1', {
      id: 'report-metabase-child-1',
      runId: 'run-a',
      jobId: 'metabase-child-1',
      connectionId: 'warehouse_a',
      sourceKey: 'metabase',
    });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalMetabaseIngest: async (input) => {
            const progress = (input as { progress?: LocalMetabaseFanoutProgress }).progress;
            progress?.onMetabaseFanoutPlanned?.({
              metabaseConnectionId: 'prod-metabase',
              children: [{ metabaseDatabaseId: 1, targetConnectionId: 'warehouse_a' }],
            });
            progress?.onMetabaseChildStarted?.({
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              jobId: 'metabase-child-1',
            });
            progress?.onMetabaseChildCompleted?.({
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              jobId: 'metabase-child-1',
              status: 'done',
            });
            return {
              metabaseConnectionId: 'prod-metabase',
              status: 'all_succeeded',
              totals: { workUnits: 2, failedWorkUnits: 0 },
              children: [
                {
                  jobId: 'metabase-child-1',
                  metabaseConnectionId: 'prod-metabase',
                  metabaseDatabaseId: 1,
                  targetConnectionId: 'warehouse_a',
                  result: {
                    jobId: 'metabase-child-1',
                    runId: 'run-a',
                    syncId: 'sync-a',
                    diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
                    workUnitCount: 1,
                    failedWorkUnits: [],
                    artifactsWritten: 0,
                    commitSha: null,
                  },
                  report,
                },
              ],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('Metabase ingest: prod-metabase');
    expect(io.stderr()).toContain('Targets: 1 mapped database');
    expect(io.stderr()).toContain('- database=1 target=warehouse_a status=running job=metabase-child-1');
    expect(io.stderr()).toContain('- database=1 target=warehouse_a status=done job=metabase-child-1');
    expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
    expect(io.stdout()).not.toContain('status=running job=metabase-child-1');
  });

  it('writes metabase fan-out progress to stderr and final result to stdout', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalMetabaseIngest: async (input) => {
            input.progress?.onMetabaseFanoutPlanned?.({
              metabaseConnectionId: 'prod-metabase',
              children: [{ metabaseDatabaseId: 1, targetConnectionId: 'warehouse_a' }],
            });
            input.progress?.onMetabaseChildStarted?.({
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              jobId: 'metabase-child-1',
            });
            return {
              metabaseConnectionId: 'prod-metabase',
              status: 'all_succeeded',
              totals: { workUnits: 0, failedWorkUnits: 0 },
              children: [],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('Metabase ingest: prod-metabase');
    expect(io.stderr()).toContain('status=running job=metabase-child-1');
    expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
    expect(io.stdout()).not.toContain('status=running job=metabase-child-1');
  });

  it('runs Metabase scheduled ingest through the public CLI command path with real fan-out', async () => {
    const projectDir = join(tempDir, 'metabase-cli-project');
    await writeWarehouseConfig(projectDir);
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: metabase-cli',
        'connections:',
        '  prod-metabase:',
        '    driver: metabase',
        '    api_url: https://metabase.example.test',
        '    api_key: literal-test-key',
        '  warehouse_a:',
        '    driver: postgres',
        '    url: postgresql://readonly@db.example.test/warehouse_a',
        '  warehouse_b:',
        '    driver: postgres',
        '    url: postgresql://readonly@db.example.test/warehouse_b',
        'ingest:',
        '  adapters:',
        '    - metabase',
        '  embeddings:',
        '    backend: deterministic',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(project) });
    await store.replaceSourceState({
      connectionId: 'prod-metabase',
      syncMode: 'ALL',
      defaultTagNames: ['ktx'],
      selections: [],
      mappings: [
        {
          metabaseDatabaseId: 1,
          metabaseDatabaseName: 'Warehouse A',
          metabaseEngine: 'postgres',
          metabaseHost: 'db.example.test',
          metabaseDbName: 'warehouse_a',
          targetConnectionId: 'warehouse_a',
          syncEnabled: true,
          source: 'refresh',
        },
        {
          metabaseDatabaseId: 2,
          metabaseDatabaseName: 'Warehouse B',
          metabaseEngine: 'postgres',
          metabaseHost: 'db.example.test',
          metabaseDbName: 'warehouse_b',
          targetConnectionId: 'warehouse_b',
          syncEnabled: true,
          source: 'refresh',
        },
      ],
    });
    const adapter = new CliMetabaseSourceAdapter();
    const agentRunner = new CliMetabaseAgentRunner();
    const childJobIds = ['metabase-child-1', 'metabase-child-2'];
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'plain',
        },
        io.io,
        {
          createAdapters: vi.fn(() => [adapter]),
          jobIdFactory: () => childJobIds.shift() ?? 'metabase-child-extra',
          localIngestOptions: {
            agentRunner,
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('Metabase ingest: prod-metabase');
    expect(io.stderr()).toContain('Targets: 2 mapped databases');
    expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
    expect(io.stdout()).toContain('Source: prod-metabase');
    expect(io.stdout()).toContain('Children: 2');
    expect(io.stdout()).toContain('target=warehouse_a database=1 status=done job=metabase-child-1');
    expect(io.stdout()).toContain('target=warehouse_b database=2 status=done job=metabase-child-2');
    expect(adapter.fetchCalls).toEqual([
      { metabaseConnectionId: 'prod-metabase', metabaseDatabaseId: 1, connectionId: 'warehouse_a' },
      { metabaseConnectionId: 'prod-metabase', metabaseDatabaseId: 2, connectionId: 'warehouse_b' },
    ]);

    const statusIo = makeIo();
    await expect(
      runKtxIngest(
        { command: 'status', projectDir, runId: 'metabase-child-1', outputMode: 'plain' },
        statusIo.io,
      ),
    ).resolves.toBe(0);
    expect(statusIo.stdout()).toContain('Job: metabase-child-1');
    expect(statusIo.stdout()).toContain('Adapter: metabase');
    expect(statusIo.stdout()).toContain('Connection: warehouse_a');
    expect(statusIo.stderr()).toBe('');
  });

  it('runs public Metabase CLI scheduled ingest for ALL, ONLY, and EXCEPT sync modes', async () => {
    await runPublicMetabaseSyncModeCase(tempDir, {
      name: 'all',
      syncMode: 'ALL',
      selections: [],
      expectedWorkUnitKeys: ['metabase-col-12', 'metabase-col-13'],
      expectedRawFiles: [
        'cards/101.json',
        'cards/102.json',
        'cards/103.json',
        'collections/12.json',
        'collections/13.json',
      ],
    });

    await runPublicMetabaseSyncModeCase(tempDir, {
      name: 'only',
      syncMode: 'ONLY',
      selections: [{ selectionType: 'collection', metabaseObjectId: 12 }],
      expectedWorkUnitKeys: ['metabase-col-12'],
      expectedRawFiles: ['cards/101.json', 'cards/102.json', 'collections/12.json'],
    });

    await runPublicMetabaseSyncModeCase(tempDir, {
      name: 'except',
      syncMode: 'EXCEPT',
      selections: [{ selectionType: 'item', metabaseObjectId: 102 }],
      expectedWorkUnitKeys: ['metabase-col-12', 'metabase-col-13'],
      expectedRawFiles: ['cards/101.json', 'cards/103.json', 'collections/12.json', 'collections/13.json'],
    });
  });

  it('prints metabase fan-out JSON results', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'json',
        },
        io.io,
        {
          runLocalMetabaseIngest: async () => ({
            metabaseConnectionId: 'prod-metabase',
            status: 'all_succeeded',
            totals: { workUnits: 0, failedWorkUnits: 0 },
            children: [],
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      metabaseConnectionId: 'prod-metabase',
      status: 'all_succeeded',
      children: [],
    });
    expect(io.stderr()).toBe('');
  });

  it('keeps metabase JSON stdout free of operational adapter logs', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();
    let adapterOptions: KtxCliLocalIngestAdaptersOptions | undefined;

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'json',
        },
        io.io,
        {
          createAdapters: (_project, options) => {
            adapterOptions = options;
            options?.logger?.warn('adapter warning');
            return [];
          },
          runLocalMetabaseIngest: async (input) => {
            input.adapters.find((adapter) => adapter.source === 'metabase');
            return {
              metabaseConnectionId: 'prod-metabase',
              status: 'all_succeeded',
              totals: { workUnits: 0, failedWorkUnits: 0 },
              children: [],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(adapterOptions?.logger).toEqual(expect.objectContaining({ warn: expect.any(Function) }));
    expect(() => JSON.parse(io.stdout())).not.toThrow();
    expect(io.stderr()).toBe('');
  });

  it('rejects source-dir uploads through the metabase fan-out route', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          adapter: 'metabase',
          connectionId: 'prod-metabase',
          sourceDir: projectDir,
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalMetabaseIngest: async () => {
            throw new Error('fan-out should not be called');
          },
        },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('source-dir uploads are not supported for the Metabase fan-out adapter');
    expect(io.stderr()).not.toContain('ktx ingest run requires llm.provider.backend');
    expect(io.stdout()).toBe('');
  });

  it('prints previous run and diff summary for local ingest results', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'local-job-1'));

    const io = makeIo();
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toBe('');
    expect(io.stdout()).toContain('Report: report-live-1\n');
    expect(io.stdout()).toContain('Job: local-job-1\n');
    expect(io.stdout()).toContain('Diff: +2/~0/-0/=0\n');
  });

  it('includes historic-sql projection output in saved memory counts', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => {
      const result = completedLocalBundleRun(input, 'historic-sql-projection');
      return {
        ...result,
        report: localFakeBundleReport('historic-sql-projection', {
          sourceKey: 'historic-sql',
          body: {
            workUnits: [],
            postProcessor: {
              sourceKey: 'historic-sql',
              status: 'success',
              result: {
                tableUsageMerged: 56,
                staleTablesMarked: 1,
                patternPagesWritten: 30,
                stalePatternPagesMarked: 2,
                archivedPatternPages: 3,
                legacyPagesDeleted: 4,
              },
              errors: [],
              warnings: [],
              touchedSources: [],
            },
          },
        }),
      };
    });

    const io = makeIo();
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'historic-sql',
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          createAdapters: vi.fn(() => [
            { source: 'historic-sql', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
          ]),
          jobIdFactory: () => 'historic-sql-projection',
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toBe('');
    expect(io.stdout()).toContain('Adapter: historic-sql\n');
    expect(io.stdout()).toContain('Saved memory: 39 wiki, 57 SL\n');
  });

  it('returns a non-zero code when local ingest reports failed work units', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => failedLocalBundleRun(input, 'local-job-failed'));

    const io = makeIo();
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-failed',
        },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toBe('');
    expect(io.stdout()).toContain('Status: error\n');
  });

  it('passes the debug LLM request file to local ingest runs', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const runLocalIngest = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, 'job-debug'),
    );
    const io = makeIo();
    const debugFile = join(projectDir, '.ktx', 'llm-debug.jsonl');

    const exitCode = await runKtxIngest(
      {
        command: 'run',
        projectDir,
        connectionId: 'warehouse',
        adapter: 'fake',
        outputMode: 'plain',
        debugLlmRequestFile: debugFile,
      },
      io.io,
      { runLocalIngest },
    );

    expect(exitCode).toBe(0);
    expect(runLocalIngest).toHaveBeenCalledWith(expect.objectContaining({ llmDebugRequestFile: debugFile }));
  });

  it('passes daemon database introspection URL to default local ingest adapters', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          databaseIntrospectionUrl: 'http://127.0.0.1:8765',
          outputMode: 'plain',
        } satisfies KtxIngestArgs,
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
        },
      ),
    ).resolves.toBe(0);

    expect(createAdapters).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir }),
      expect.objectContaining({
        databaseIntrospectionUrl: 'http://127.0.0.1:8765',
        logger: expect.any(Object),
      }),
    );
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        adapters: createdAdapters,
        adapter: 'fake',
        connectionId: 'warehouse',
        pullConfigOptions: expect.objectContaining({
          databaseIntrospectionUrl: 'http://127.0.0.1:8765',
          logger: expect.any(Object),
        }),
      }),
    );
  });

  it('passes managed daemon options to adapters and pull-config options when no explicit daemon URL is set', async () => {
    const projectDir = join(tempDir, 'managed-daemon-ingest-project');
    await initKtxProject({ projectDir, projectName: 'managed-daemon-ingest-project' });
    await writeWarehouseConfig(projectDir);
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
          outputMode: 'plain',
        } satisfies KtxIngestArgs,
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
        },
      ),
    ).resolves.toBe(0);

    const expectedManagedDaemon = {
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
    };
    expect(createAdapters).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir }),
      expect.objectContaining({
        managedDaemon: expectedManagedDaemon,
        logger: expect.any(Object),
      }),
    );
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        pullConfigOptions: expect.objectContaining({
          managedDaemon: expectedManagedDaemon,
          logger: expect.any(Object),
        }),
      }),
    );
  });

  it('passes the target connection id when constructing local historic-sql adapters', async () => {
    const projectDir = join(tempDir, 'historic-sql-project');
    await writeWarehouseConfig(projectDir);
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: historic-sql-project',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        '      minExecutions: 2',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
      'utf-8',
    );
    const createdAdapters: SourceAdapter[] = [
      { source: 'historic-sql', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-historic-job'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'historic-sql',
          outputMode: 'plain',
        },
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-historic-job',
        },
      ),
    ).resolves.toBe(0);

    expect(createAdapters).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir }),
      expect.objectContaining({
        historicSqlConnectionId: 'warehouse',
        logger: expect.any(Object),
      }),
    );
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        adapters: createdAdapters,
        adapter: 'historic-sql',
        connectionId: 'warehouse',
      }),
    );
  });

  it('prints live progress for plain local ingest in interactive terminals', async () => {
    const projectDir = join(tempDir, 'historic-sql-progress-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: historic-sql-progress-project',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        '      minExecutions: 2',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
      'utf-8',
    );
    const createdAdapters: SourceAdapter[] = [
      { source: 'historic-sql', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => {
      expect(input.memoryFlow).toBeDefined();
      input.memoryFlow?.emit({
        type: 'source_acquired',
        adapter: 'historic-sql',
        trigger: 'manual_resync',
        fileCount: 3,
      });
      input.memoryFlow?.update({ syncId: 'sync-progress-1' });
      input.memoryFlow?.emit({ type: 'raw_snapshot_written', syncId: 'sync-progress-1', rawFileCount: 3 });
      input.memoryFlow?.emit({ type: 'diff_computed', added: 2, modified: 0, deleted: 0, unchanged: 1 });
      input.memoryFlow?.update({
        plannedWorkUnits: [
          {
            unitKey: 'historic-sql-table-public-orders',
            rawFiles: ['tables/public/orders.json'],
            peerFileCount: 0,
            dependencyCount: 0,
          },
        ],
      });
      input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 });
      input.memoryFlow?.emit({
        type: 'work_unit_started',
        unitKey: 'historic-sql-table-public-orders',
        skills: ['historic_sql_table_digest'],
        stepBudget: 40,
      });
      input.memoryFlow?.emit({
        type: 'work_unit_finished',
        unitKey: 'historic-sql-table-public-orders',
        status: 'success',
      });
      input.memoryFlow?.emit({ type: 'saved', commitSha: null, wikiCount: 0, slCount: 1 });
      input.memoryFlow?.emit({ type: 'provenance_recorded', rowCount: 3 });
      input.memoryFlow?.emit({ type: 'report_created', runId: 'run-live-1', reportPath: 'report-live-1' });
      input.memoryFlow?.finish('done');
      return completedLocalBundleRun(input, input.jobId ?? 'historic-progress-job');
    });
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'historic-sql',
          outputMode: 'plain',
        },
        io.io,
        {
          env: interactiveEnv(),
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'historic-progress-job',
        },
      ),
    ).resolves.toBe(0);

    const stdout = io.stdout();
    const stderr = io.stderr();
    expect(stderr).toContain('[5%] Fetching source files for warehouse/historic-sql');
    expect(stderr).toContain('[15%] Fetched 3 source files from historic-sql');
    expect(stderr).toContain('[45%] Planned 1 work unit');
    expect(stderr).toContain('[80%] Processed 1/1 work units');
    expect(stderr).toContain('[100%] Ingest completed');
    expect(stdout).toContain('Report: report-live-1');
    expect(stdout).not.toContain('[5%]');
  });

  it('writes plain TTY ingest progress to stderr and final report to stdout', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'local-job-1'));
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        io.io,
        {
          env: interactiveEnv(),
          runLocalIngest: runLocal,
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('[5%] Fetching source files for warehouse/fake');
    expect(io.stdout()).toContain('Report: report-live-1');
    expect(io.stdout()).not.toContain('[5%]');
  });

  it('prints plain WorkUnit step progress during long-running local ingest', async () => {
    const projectDir = join(tempDir, 'historic-sql-step-progress-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: historic-sql-step-progress-project',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        '      minExecutions: 2',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
      'utf-8',
    );
    const createdAdapters: SourceAdapter[] = [
      { source: 'historic-sql', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => {
      input.memoryFlow?.update({
        plannedWorkUnits: [
          {
            unitKey: 'historic-sql-table-public-orders',
            rawFiles: ['tables/public/orders.json'],
            peerFileCount: 0,
            dependencyCount: 0,
          },
          {
            unitKey: 'historic-sql-table-public-customers',
            rawFiles: ['tables/public/customers.json'],
            peerFileCount: 0,
            dependencyCount: 0,
          },
        ],
      });
      input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 2, workUnitCount: 2, evictionCount: 0 });
      input.memoryFlow?.emit({
        type: 'work_unit_started',
        unitKey: 'historic-sql-table-public-orders',
        skills: ['historic_sql_table_digest'],
        stepBudget: 40,
      });
      input.memoryFlow?.emit({
        type: 'work_unit_step',
        unitKey: 'historic-sql-table-public-orders',
        stepIndex: 7,
        stepBudget: 40,
      });
      input.memoryFlow?.emit({
        type: 'work_unit_finished',
        unitKey: 'historic-sql-table-public-orders',
        status: 'success',
      });
      input.memoryFlow?.finish('done');
      return completedLocalBundleRun(input, input.jobId ?? 'historic-step-progress-job');
    });
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'historic-sql',
          outputMode: 'plain',
        },
        io.io,
        {
          env: interactiveEnv(),
          createAdapters: vi.fn(() => createdAdapters as never),
          runLocalIngest: runLocal,
          jobIdFactory: () => 'historic-step-progress-job',
        },
      ),
    ).resolves.toBe(0);

    const stderr = io.stderr();
    expect(stderr).toContain('[45%] Planned 2 work units');
    expect(stderr).toContain('[55%] Processing 1/2 work units: historic-sql-table-public-orders');
    expect(stderr).toContain(
      '\r[58%] Processing work units: 0/2 complete, 1 active; latest historic-sql-table-public-orders step 7/40\u001b[K',
    );
    expect(stderr).toContain('[68%] Processed 1/2 work units');
  });

  it('renders concurrent WorkUnit step progress as transient aggregate status', async () => {
    const projectDir = join(tempDir, 'historic-sql-concurrent-progress-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: historic-sql-concurrent-progress-project',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        '      minExecutions: 2',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
      'utf-8',
    );
    const createdAdapters: SourceAdapter[] = [
      { source: 'historic-sql', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const workUnitKeys = [
      'historic-sql-table-public-orders',
      'historic-sql-table-public-customers',
      'historic-sql-table-public-line-items',
      'historic-sql-table-public-payments',
      'historic-sql-table-public-products',
      'historic-sql-table-public-suppliers',
    ];
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => {
      input.memoryFlow?.update({
        plannedWorkUnits: workUnitKeys.map((unitKey) => ({
          unitKey,
          rawFiles: [`tables/${unitKey}.json`],
          peerFileCount: 0,
          dependencyCount: 0,
        })),
      });
      input.memoryFlow?.emit({
        type: 'chunks_planned',
        chunkCount: workUnitKeys.length,
        workUnitCount: workUnitKeys.length,
        evictionCount: 0,
      });
      for (const unitKey of workUnitKeys) {
        input.memoryFlow?.emit({
          type: 'work_unit_started',
          unitKey,
          skills: ['historic_sql_table_digest'],
          stepBudget: 40,
        });
      }
      for (const unitKey of workUnitKeys) {
        input.memoryFlow?.emit({ type: 'work_unit_step', unitKey, stepIndex: 1, stepBudget: 40 });
      }
      input.memoryFlow?.finish('done');
      return completedLocalBundleRun(input, input.jobId ?? 'historic-concurrent-progress-job');
    });
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'historic-sql',
          outputMode: 'plain',
        },
        io.io,
        {
          env: interactiveEnv(),
          createAdapters: vi.fn(() => createdAdapters as never),
          runLocalIngest: runLocal,
          jobIdFactory: () => 'historic-concurrent-progress-job',
        },
      ),
    ).resolves.toBe(0);

    const stderr = io.stderr();
    expect(stderr).toContain(
      '\r[56%] Processing work units: 0/6 complete, 6 active; latest historic-sql-table-public-suppliers step 1/40\u001b[K',
    );
    expect(stderr).not.toContain(
      '\n[56%] Processing 6/6 work units: historic-sql-table-public-suppliers step 1/40\n',
    );
    expect(stderr).toContain('\n[100%] Ingest completed\n');
  });

  it('passes local Looker pull-config options and agent runner into scheduled ingest for Looker scheduled ingest', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const pullConfigOptions = {
      looker: {
        parser: { parse: vi.fn() },
      },
    };
    const agentRunner = { runLoop: vi.fn() } as never;
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          outputMode: 'plain',
        } satisfies KtxIngestArgs,
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
          localIngestOptions: {
            agentRunner,
            pullConfigOptions,
          },
        },
      ),
    ).resolves.toBe(0);

    expect(createAdapters).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir }),
      expect.objectContaining({
        logger: expect.any(Object),
        looker: {
          parser: pullConfigOptions.looker.parser,
        },
      }),
    );
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunner,
        pullConfigOptions: expect.objectContaining(pullConfigOptions),
      }),
    );
  });

  it('runs Looker scheduled ingest through the public CLI command path', async () => {
    const projectDir = join(tempDir, 'looker-project');
    await writeWarehouseConfig(projectDir);
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: looker-cli',
        'connections:',
        '  prod-looker:',
        '    driver: looker',
        '    base_url: https://looker.example.test',
        '    client_id: client',
        '  prod-warehouse:',
        '    driver: postgres',
        '    url: postgresql://readonly@db.example.test/analytics',
        'ingest:',
        '  adapters:',
        '    - looker',
      '  embeddings:',
      '    backend: deterministic',
      '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir });
    const store = new LocalLookerRuntimeStore({ dbPath: ktxLocalStateDbPath(project) });
    await store.setCursors('prod-looker', {
      dashboardsLastSyncedAt: null,
      looksLastSyncedAt: null,
    });
    await store.upsertConnectionMapping({
      lookerConnectionId: 'prod-looker',
      lookerConnectionName: 'analytics',
      ktxConnectionId: 'prod-warehouse',
      source: 'cli',
    });
    const runtimeClient = makeCliLookerRuntimeClient();
    const parser = makeCliLookerParser();
    const agentRunner = new CliLookerSlWritingAgentRunner();
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-looker',
          adapter: 'looker',
          outputMode: 'plain',
        },
        io.io,
        {
          jobIdFactory: () => 'cli-looker-job',
          localIngestOptions: {
            agentRunner,
            pullConfigOptions: {
              looker: {
                client: runtimeClient,
                runtimeClient,
                parser,
              },
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toBe('');
    expect(io.stdout()).toContain('Job: cli-looker-job');
    expect(io.stdout()).toContain('Adapter: looker');
    expect(io.stdout()).toContain('Connection: prod-looker');
    expect(io.stdout()).toContain('Status: done');
    expect(io.stdout()).toContain('Saved memory: 0 wiki, 1 SL');
    expect(parser.parse).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'ecommerce.orders', sql_table_name: 'public.orders', dialect: 'postgres' }),
        expect.objectContaining({ key: 'ecommerce.orders.users', sql_table_name: 'public.users', dialect: 'postgres' }),
      ]),
    );
    expect(runtimeClient.cleanup).toHaveBeenCalledTimes(1);
    const slPath = join(projectDir, 'semantic-layer', 'prod-warehouse', 'looker__ecommerce__orders.yaml');
    await access(slPath);
    await expect(readFile(slPath, 'utf-8')).resolves.toContain('table: public.orders');

    const statusIo = makeIo();
    await expect(
      runKtxIngest(
        { command: 'status', projectDir, runId: 'cli-looker-job', outputMode: 'plain' },
        statusIo.io,
      ),
    ).resolves.toBe(0);
    expect(statusIo.stdout()).toContain('Job: cli-looker-job');
    expect(statusIo.stdout()).toContain('Adapter: looker');
    expect(statusIo.stderr()).toBe('');
  });

});
