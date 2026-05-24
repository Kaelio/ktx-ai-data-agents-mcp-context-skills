import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLookerRuntimeStore } from './context/ingest/adapters/looker/local-runtime-store.js';
import { LocalMetabaseDiscoveryCache } from './context/ingest/adapters/metabase/local-source-state-store.js';
import type { LocalIngestResult, LocalMetabaseFanoutProgress, RunLocalIngestOptions } from './context/ingest/local-ingest.js';
import type { SourceAdapter } from './context/ingest/types.js';
import { initKtxProject, loadKtxProject } from './context/project/project.js';
import { ktxLocalStateDbPath } from './context/project/local-state-db.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KtxIngestArgs, type KtxIngestDeps, runKtxIngest } from './ingest.js';
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
  const runtimeReady = (projectDir: string) => ({
    status: 'ready' as const,
    projectDir,
    requirements: { features: ['core' as const], requirements: [] },
  });

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

  it('labels internal database reports without adapter names in plain status output', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const report = localFakeBundleReport('scan-job-1', {
      id: 'report-scan-1',
      runId: 'run-scan-1',
      connectionId: 'warehouse',
      sourceKey: 'live-database',
    });
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'status',
          projectDir,
          reportFile: '/tmp/scan-report.json',
          outputMode: 'plain',
        },
        io.io,
        {
          readReportFile: vi.fn(async () => report),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Source: Database schema\n');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stdout()).not.toContain('live-database');
    expect(io.stderr()).toBe('');
  });

  it('labels internal query-history reports without adapter names in plain status output', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const report = localFakeBundleReport('query-history-job-1', {
      id: 'report-query-history-1',
      runId: 'run-query-history-1',
      connectionId: 'warehouse',
      sourceKey: 'historic-sql',
    });
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'status',
          projectDir,
          reportFile: '/tmp/query-history-report.json',
          outputMode: 'plain',
        },
        io.io,
        {
          readReportFile: vi.fn(async () => report),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Source: Query history\n');
    expect(io.stdout()).not.toContain('Adapter:');
    expect(io.stdout()).not.toContain('historic-sql');
    expect(io.stderr()).toBe('');
  });

  it('emits structured progress for non-TTY local ingest runs', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const progressEvents: Array<{ percent: number; message: string; transient?: boolean }> = [];
    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      input.memoryFlow?.emit({ type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 2 });
      input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 2, workUnitCount: 2, evictionCount: 0 });
      input.memoryFlow?.emit({ type: 'work_unit_started', unitKey: 'orders', skills: [], stepBudget: 4 });
      input.memoryFlow?.emit({ type: 'work_unit_step', unitKey: 'orders', stepIndex: 2, stepBudget: 4 });
      return completedLocalBundleRun(input, 'cli-local-progress-1');
    });
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'cli-local-progress-1',
          progress: (event) => progressEvents.push(event),
        },
      ),
    ).resolves.toBe(0);

    expect(progressEvents).toEqual(
      expect.arrayContaining([
        { percent: 5, message: 'Fetching source files for warehouse/fake' },
        { percent: 15, message: 'Fetched 2 source files from fake' },
        { percent: 45, message: 'Planned 2 tasks' },
        expect.objectContaining({
          message: 'Processing tasks: 0/2 complete, 1 active; latest orders step 2/4',
          transient: true,
        }),
      ]),
    );
    expect(io.stderr()).not.toContain('[15%] Fetched 2 source files from fake');
  });

  it('describes zero-work-unit ingest progress as finalizing instead of appearing half-planned', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const progressEvents: Array<{ percent: number; message: string; transient?: boolean }> = [];
    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      input.memoryFlow?.emit({ type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 2 });
      input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 0, workUnitCount: 0, evictionCount: 0 });
      return completedLocalBundleRun(input, 'cli-local-zero-progress-1');
    });
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'cli-local-zero-progress-1',
          progress: (event) => progressEvents.push(event),
        },
      ),
    ).resolves.toBe(0);

    expect(progressEvents).toEqual(
      expect.arrayContaining([
        { percent: 80, message: 'No tasks to process; finalizing ingest' },
      ]),
    );
    expect(progressEvents).not.toContainEqual({ percent: 45, message: 'Planned 0 tasks' });
  });

  it('prints provider setup guidance when a skip-llm setup project runs ingest', async () => {
    const projectDir = join(tempDir, 'project');
    const setupIo = makeIo();
    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir,
          mode: 'auto',
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
          enableQueryHistory: true,
          skipDatabases: false,
          skipSources: true,
        },
        setupIo.io,
        {
          databasesDeps: {
            testConnection: async (_projectDir, _connectionId, io) => {
              io.stdout.write('Driver: postgres\nStatus: ok\n');
              return 0;
            },
            scanConnection: async () => 0,
            historicSqlReadinessProbe: async () => ({
              ok: true,
              dialect: 'postgres',
              runner: {
                dialect: 'postgres',
                catalogName: 'pg_stat_statements',
                async run() {
                  return { warnings: [], info: [] };
                },
                formatSuccessDetail() {
                  return {
                    detail: 'pg_stat_statements ready (PostgreSQL 16.4)',
                    warnings: [],
                  };
                },
                fixAdvice() {
                  return {
                    failHeadline: 'pg_stat_statements unavailable',
                    remediation: 'Fix query-history grants.',
                  };
                },
              },
              result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
            }),
          },
          context: async () => ({ status: 'skipped', projectDir }),
          runtime: async () => runtimeReady(projectDir),
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
          allowImplicitAdapter: true,
          outputMode: 'plain',
        },
        runIo.io,
      ),
    ).resolves.toBe(1);

    expect(runIo.stdout()).toBe('');
    expect(runIo.stderr()).toContain(
      'ktx ingest requires llm.provider.backend: anthropic, vertex, gateway, or claude-code, or an injected agentRunner.',
    );
    expect(runIo.stderr()).toContain('Configure a local Claude Code session or API-backed LLM, then rerun ingest:');
    expect(runIo.stderr()).toContain(`ktx setup --project-dir ${projectDir} --llm-backend claude-code --no-input`);
    expect(runIo.stderr()).toContain(
      `ktx setup --project-dir ${projectDir} --llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY --llm-model claude-sonnet-4-6 --no-input`,
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
    expect(io.stdout()).toContain('Failed tasks: 1');
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

  it('emits structured progress for Metabase fan-out without writing progress to JSON output', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();
    const progressEvents: Array<{ percent: number; message: string }> = [];

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
          progress: (event) => progressEvents.push(event),
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
            input.progress?.onMetabaseChildCompleted?.({
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              jobId: 'metabase-child-1',
              status: 'done',
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

    expect(progressEvents).toEqual(
      expect.arrayContaining([
        { percent: 5, message: 'Checking Metabase mappings for prod-metabase' },
        { percent: 10, message: 'Metabase prod-metabase: 1 mapped database' },
        { percent: 25, message: 'Metabase database 1 -> warehouse_a running' },
        { percent: 90, message: 'Metabase database 1 -> warehouse_a done' },
      ]),
    );
    expect(io.stdout()).toContain('"status": "all_succeeded"');
    expect(io.stderr()).not.toContain('Metabase ingest: prod-metabase');
  });

  it('emits structured child ingest progress during Metabase fan-out', async () => {
    const projectDir = join(tempDir, 'project');
    await writeMetabaseConfig(projectDir);
    const io = makeIo();
    const progressEvents: Array<{ percent: number; message: string; transient?: boolean }> = [];

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
          progress: (event) => progressEvents.push(event),
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
            input.memoryFlow?.update({
              plannedWorkUnits: [
                {
                  unitKey: 'metabase-col-6',
                  rawFiles: ['cards/40.json'],
                  peerFileCount: 0,
                  dependencyCount: 0,
                },
              ],
            });
            input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 });
            input.memoryFlow?.emit({
              type: 'work_unit_started',
              unitKey: 'metabase-col-6',
              skills: ['sl_capture'],
              stepBudget: 40,
            });
            input.memoryFlow?.emit({
              type: 'work_unit_step',
              unitKey: 'metabase-col-6',
              stepIndex: 7,
              stepBudget: 40,
            });
            input.memoryFlow?.emit({
              type: 'stage_progress',
              stage: 'integration',
              percent: 81,
              message: 'Resolving text conflict for metabase-col-6',
            });
            input.memoryFlow?.emit({ type: 'work_unit_finished', unitKey: 'metabase-col-6', status: 'success' });
            input.memoryFlow?.update({
              plannedWorkUnits: [
                {
                  unitKey: 'metabase-col-7',
                  rawFiles: ['cards/48.json'],
                  peerFileCount: 0,
                  dependencyCount: 0,
                },
              ],
            });
            input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 });
            input.memoryFlow?.emit({
              type: 'work_unit_started',
              unitKey: 'metabase-col-7',
              skills: ['sl_capture'],
              stepBudget: 40,
            });
            input.progress?.onMetabaseChildCompleted?.({
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              jobId: 'metabase-child-1',
              status: 'done',
            });
            return {
              metabaseConnectionId: 'prod-metabase',
              status: 'all_succeeded',
              totals: { workUnits: 1, failedWorkUnits: 0 },
              children: [],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(progressEvents).toEqual(
      expect.arrayContaining([
        { percent: 45, message: 'Planned 1 task' },
        { percent: 55, message: 'Processing 1/1 tasks: metabase-col-6' },
        {
          percent: 60,
          message: 'Processing tasks: 0/1 complete, 1 active; latest metabase-col-6 step 7/40',
          transient: true,
        },
        { percent: 81, message: 'Resolving text conflict for metabase-col-6' },
        { percent: 81, message: 'Processing 1/1 tasks: metabase-col-7' },
      ]),
    );
    expect(io.stdout()).toContain('"status": "all_succeeded"');
    expect(io.stderr()).not.toContain('Metabase ingest: prod-metabase');
  });

  it('runs Metabase scheduled ingest through the public CLI command path with real fan-out', async () => {
    const projectDir = join(tempDir, 'metabase-cli-project');
    await writeWarehouseConfig(projectDir);
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  prod-metabase:',
        '    driver: metabase',
        '    api_url: https://metabase.example.test',
        '    api_key: literal-test-key',
        '    mappings:',
        '      databaseMappings:',
        '        "1": warehouse_a',
        '        "2": warehouse_b',
        '      syncEnabled:',
        '        "1": true',
        '        "2": true',
        '      syncMode: ALL',
        '      defaultTagNames:',
        '        - ktx',
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
        '    backend: none',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir });
    const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: ktxLocalStateDbPath(project) });
    await discoveryCache.refreshDiscoveredDatabases({
      connectionId: 'prod-metabase',
      discovered: [
        { id: 1, name: 'Warehouse A', engine: 'postgres', host: 'db.example.test', dbName: 'warehouse_a' },
        { id: 2, name: 'Warehouse B', engine: 'postgres', host: 'db.example.test', dbName: 'warehouse_b' },
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
    expect(statusIo.stdout()).toContain('Source: Metabase');
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
    expect(io.stderr()).not.toContain('ktx ingest requires llm.provider.backend');
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
            finalization: {
              sourceKey: 'historic-sql',
              status: 'success',
              commitSha: 'finalization-sha',
              touchedPaths: ['semantic-layer/warehouse/_schema/public.yaml', 'wiki/global/historic-sql-orders.md'],
              declaredTouchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
              derivedTouchedSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
              declaredChangedWikiPageKeys: ['historic-sql-orders'],
              derivedChangedWikiPageKeys: ['historic-sql-orders'],
              mismatches: [],
              result: {
                tableUsageMerged: 56,
                staleTablesMarked: 1,
                patternPagesWritten: 30,
                stalePatternPagesMarked: 2,
                archivedPatternPages: 3,
              },
              errors: [],
              warnings: [],
              actions: [
                ...Array.from({ length: 57 }, (_, index) => ({
                  target: 'sl' as const,
                  type: 'updated' as const,
                  key: `orders-${index}`,
                  detail: 'Merged usage',
                  targetConnectionId: 'warehouse',
                  rawPaths: ['tables/public/orders.json'],
                })),
                ...Array.from({ length: 35 }, (_, index) => ({
                  target: 'wiki' as const,
                  type: 'updated' as const,
                  key: `historic-sql-orders-${index}`,
                  detail: 'Projected pattern',
                  rawPaths: ['patterns/orders.json'],
                })),
              ],
              provenanceExclusions: [],
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
    expect(io.stdout()).toContain('Source: Query history\n');
    expect(io.stdout()).toContain('Saved memory: 35 wiki, 57 SL\n');
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

  it('prints trace path and error status for stored failed ingest reports', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const io = makeIo();
    const report = {
      id: 'report-failed',
      runId: 'run-failed',
      jobId: 'job-failed',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      createdAt: '2026-05-17T12:00:00.000Z',
      body: {
        status: 'failed',
        syncId: 'sync-failed',
        diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: null,
        tracePath: '/project/.ktx/ingest-traces/job-failed/trace.jsonl',
        failure: { phase: 'final_gates', message: 'final artifact gates failed' },
        workUnits: [],
        failedWorkUnits: [],
        reconciliationSkipped: true,
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
        evictionInputs: [],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    };

    await runKtxIngest(
      {
        command: 'status',
        projectDir,
        reportFile: '/project/report-failed.json',
        runId: 'run-failed',
        outputMode: 'plain',
        inputMode: 'disabled',
      },
      io.io,
      {
        readReportFile: vi.fn().mockResolvedValue(report),
      },
    );

    expect(io.stdout()).toContain('Trace: /project/.ktx/ingest-traces/job-failed/trace.jsonl');
    expect(io.stdout()).toContain('Status: error');
    expect(io.stdout()).toContain('Error: final artifact gates failed');
  });

  it('prints a clear first failure reason when query-history work units fail', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const rawReason =
      '{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)","error_uri":"https://support.google.com/a/answer/9368756","error_subtype":"invalid_rapt"}';
    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      const failedWorkUnit = {
        ...localFakeBundleReport('query-history-failed').body.workUnits[0],
        unitKey: 'historic-sql-table-orders',
        rawFiles: ['tables/orders.json'],
        status: 'failed' as const,
        reason: rawReason,
        actions: [],
        touchedSlSources: [],
      };
      const report = localFakeBundleReport('query-history-failed', {
        id: 'report-query-history-failed',
        runId: 'run-query-history-failed',
        connectionId: input.connectionId,
        sourceKey: 'historic-sql',
        body: {
          workUnits: [failedWorkUnit],
          failedWorkUnits: [failedWorkUnit.unitKey],
        },
      });
      return {
        result: {
          jobId: 'query-history-failed',
          runId: report.runId,
          syncId: report.body.syncId,
          diffSummary: report.body.diffSummary,
          workUnitCount: report.body.workUnits.length,
          failedWorkUnits: report.body.failedWorkUnits,
          artifactsWritten: report.body.provenanceRows.length,
          commitSha: report.body.commitSha,
        },
        report,
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
          jobIdFactory: () => 'query-history-failed',
        },
      ),
    ).resolves.toBe(1);

    expect(io.stdout()).toContain('Status: error\n');
    expect(io.stdout()).toContain('Failed tasks: 1\n');
    expect(io.stdout()).toContain(
      'Error: Query history failed for 1 task. First failure: Google Cloud authentication failed while analyzing query history: application-default credentials expired or require reauthentication (invalid_grant / invalid_rapt). Run `gcloud auth application-default login`, then retry.',
    );
    expect(io.stdout()).not.toContain('error_uri');
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

  it('supplies a scan-connector query executor to local ingest runs', async () => {
    const io = makeIo();
    const projectDir = join(tempDir, 'query-executor-project');
    await writeWarehouseConfig(projectDir);
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: [],
        rows: [],
        totalRows: 0,
        command: 'SELECT',
        rowCount: 0,
      })),
    };
    const runLocalIngest = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> =>
      completedLocalBundleRun(input, 'query-executor-run'),
    );

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          outputMode: 'json',
        },
        io.io,
        {
          runLocalIngest,
          createAdapters: () => [],
          createQueryExecutor: () => queryExecutor,
        },
      ),
    ).resolves.toBe(0);

    expect(runLocalIngest).toHaveBeenCalledWith(expect.objectContaining({ queryExecutor }));
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

  it('passes KTX daemon options to adapters and pull-config options when no explicit daemon URL is set', async () => {
    const projectDir = join(tempDir, 'managed-daemon-ingest-project');
    await initKtxProject({ projectDir });
    await writeWarehouseConfig(projectDir);
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const io = makeIo();
    const runtimeIo = makeIo({ isTTY: true });

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
          runtimeIo: runtimeIo.io,
        } as KtxIngestDeps & {
          runtimeIo: typeof runtimeIo.io;
        },
      ),
    ).resolves.toBe(0);

    const expectedManagedDaemon = {
      cliVersion: '0.2.0',
      projectDir,
      installPolicy: 'auto',
      io: runtimeIo.io,
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

  it('uses runtime IO when resolving managed embedding runtime', async () => {
    const projectDir = join(tempDir, 'managed-embedding-ingest-project');
    await initKtxProject({ projectDir });
    await writeWarehouseConfig(projectDir);
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const resolveEmbeddingProvider = vi.fn(async () => ({ kind: 'disabled' as const }));
    const io = makeIo();
    const runtimeIo = makeIo({ isTTY: true });

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
          runtimeIo: runtimeIo.io,
          resolveEmbeddingProvider,
        },
      ),
    ).resolves.toBe(0);

    expect(resolveEmbeddingProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        installPolicy: 'auto',
        io: runtimeIo.io,
      }),
    );
  });

  it('passes the target connection id when constructing local historic-sql adapters', async () => {
    const projectDir = join(tempDir, 'historic-sql-project');
    await writeWarehouseConfig(projectDir);
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        '        minExecutions: 2',
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
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        '        minExecutions: 2',
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
    expect(stderr).toContain('[45%] Planned 1 task');
    expect(stderr).toContain('[80%] Processed 1/1 tasks');
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
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        '        minExecutions: 2',
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
    expect(stderr).toContain('[45%] Planned 2 tasks');
    expect(stderr).toContain('[55%] Processing 1/2 tasks: historic-sql-table-public-orders');
    expect(stderr).toContain(
      '\r[58%] Processing tasks: 0/2 complete, 1 active; latest historic-sql-table-public-orders step 7/40\u001b[K',
    );
    expect(stderr).toContain('[68%] Processed 1/2 tasks');
  });

  it('renders concurrent WorkUnit step progress as transient aggregate status', async () => {
    const projectDir = join(tempDir, 'historic-sql-concurrent-progress-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        '        minExecutions: 2',
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
      '\r[56%] Processing tasks: 0/6 complete, 6 active; latest historic-sql-table-public-suppliers step 1/40\u001b[K',
    );
    expect(stderr).not.toContain(
      '\n[56%] Processing 6/6 tasks: historic-sql-table-public-suppliers step 1/40\n',
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
      '    backend: none',
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
    expect(io.stdout()).toContain('Source: Looker');
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
    expect(statusIo.stdout()).toContain('Source: Looker');
    expect(statusIo.stderr()).toBe('');
  });

});
