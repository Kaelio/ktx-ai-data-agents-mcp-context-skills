import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject, type KtxLocalProject, loadKtxProject } from '../project/index.js';
import { FakeSourceAdapter } from './adapters/fake/fake.adapter.js';
import { createDefaultLocalIngestAdapters } from './local-adapters.js';
import {
  getLocalStageOnlyIngestStatus,
  runLocalStageOnlyIngest,
} from './local-stage-ingest.js';
import { createMemoryFlowLiveBuffer } from './memory-flow/live-buffer.js';
import type { MemoryFlowReplayInput } from './memory-flow/types.js';
import type { SourceAdapter } from './types.js';

async function writeWarehouseConfig(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      'ingest:',
      '  adapters:',
      '    - fake',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function writeLiveDatabaseConfig(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      '    url: postgres://localhost:5432/warehouse',
      'ingest:',
      '  adapters:',
      '    - live-database',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function fetchOnlyAdapter(): SourceAdapter {
  return {
    source: 'live-database',
    skillNames: ['live_database_ingest'],
    async fetch(_pullConfig, stagedDir) {
      await mkdir(join(stagedDir, 'tables'), { recursive: true });
      await writeFile(join(stagedDir, 'connection.json'), '{"connectionId":"warehouse"}\n', 'utf-8');
      await writeFile(join(stagedDir, 'foreign-keys.json'), '{"foreignKeys":[]}\n', 'utf-8');
      await writeFile(
        join(stagedDir, 'tables', 'orders.json'),
        '{"name":"orders","db":"public","columns":[{"name":"id","type":"integer","nullable":false,"primaryKey":true}]}\n',
        'utf-8',
      );
    },
    async detect(stagedDir) {
      await readFile(join(stagedDir, 'connection.json'), 'utf-8');
      return true;
    },
    async chunk() {
      return {
        workUnits: [
          {
            unitKey: 'live-database-public-orders',
            rawFiles: ['tables/orders.json'],
            dependencyPaths: ['connection.json', 'foreign-keys.json'],
            peerFileIndex: [],
          },
        ],
      };
    },
  };
}

describe('local ingest', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-ingest-'));
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    project = await loadKtxProject({ projectDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stages a source directory, chunks it, records status, and commits raw files', async () => {
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const result = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-job-1',
      now: () => new Date('2026-04-27T12:00:00.000Z'),
    });

    expect(result).toMatchObject({
      runId: 'local-job-1',
      jobId: 'local-job-1',
      status: 'done',
      adapter: 'fake',
      connectionId: 'warehouse',
      progress: 1,
      done: true,
      previousRunId: null,
      workUnitCount: 1,
      rawFileCount: 1,
      evictionDeletedRawPaths: [],
      errors: [],
    });
    expect(result.syncId).toBe('2026-04-27-120000-local-job-1');
    expect(result.diffSummary).toEqual({ added: 1, modified: 0, deleted: 0, unchanged: 0 });
    expect(result.diffPaths).toEqual({
      added: ['orders/orders.json'],
      modified: [],
      deleted: [],
      unchanged: [],
    });
    expect(result.workUnits).toEqual([
      {
        unitKey: 'fake-orders',
        rawFiles: ['orders/orders.json'],
        dependencyPaths: [],
        peerFileIndex: [],
      },
    ]);

    const rawPath = join(
      project.projectDir,
      'raw-sources',
      'warehouse',
      'fake',
      '2026-04-27-120000-local-job-1',
      'orders',
      'orders.json',
    );
    await expect(readFile(rawPath, 'utf-8')).resolves.toBe('{"name":"orders"}\n');

    const status = await getLocalStageOnlyIngestStatus(project, 'local-job-1');
    expect(status).toEqual(result);

    await expect(access(join(project.projectDir, '.ktx', 'db.sqlite'))).resolves.toBeUndefined();
    await expect(
      readFile(join(project.projectDir, '.ktx', 'ingest-runs', 'local-job-1.json'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(join(project.projectDir, '.ktx', 'ingest-reports', 'local-job-1.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('emits memory-flow events while staging and planning a local ingest', async () => {
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const snapshots: MemoryFlowReplayInput[] = [];
    const memoryFlow = createMemoryFlowLiveBuffer(
      {
        runId: 'local-flow-1',
        connectionId: 'warehouse',
        adapter: 'fake',
        status: 'running',
        sourceDir,
        syncId: 'pending',
        errors: [],
        events: [],
        plannedWorkUnits: [],
        details: { actions: [], provenance: [], transcripts: [] },
      },
      { onChange: (snapshot) => snapshots.push(snapshot) },
    );

    const result = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-flow-1',
      now: () => new Date('2026-04-30T13:00:00.000Z'),
      memoryFlow,
    });

    expect(result.status).toBe('done');
    expect(memoryFlow.snapshot()).toMatchObject({
      runId: 'local-flow-1',
      status: 'done',
      syncId: '2026-04-30-130000-local-flow-1',
      plannedWorkUnits: [{ unitKey: 'fake-orders', rawFiles: ['orders/orders.json'] }],
    });
    expect(memoryFlow.snapshot().events.map(({ emittedAt: _emittedAt, ...event }) => event)).toEqual([
      { type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 1 },
      { type: 'scope_detected', fingerprint: null },
      { type: 'raw_snapshot_written', syncId: '2026-04-30-130000-local-flow-1', rawFileCount: 1 },
      { type: 'diff_computed', added: 1, modified: 0, deleted: 0, unchanged: 0 },
      { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
      { type: 'report_created', runId: 'local-flow-1' },
    ]);
    expect(snapshots.at(-1)?.status).toBe('done');
  });

  it('marks the memory-flow buffer as error when local ingest fails', async () => {
    const memoryFlow = createMemoryFlowLiveBuffer({
      runId: 'local-flow-error',
      connectionId: 'warehouse',
      adapter: 'fake',
      status: 'running',
      sourceDir: null,
      syncId: 'pending',
      errors: [],
      events: [],
      plannedWorkUnits: [],
      details: { actions: [], provenance: [], transcripts: [] },
    });

    await expect(
      runLocalStageOnlyIngest({
        project,
        adapters: [new FakeSourceAdapter()],
        adapter: 'fake',
        connectionId: 'warehouse',
        jobId: 'local-flow-error',
        now: () => new Date('2026-04-30T13:05:00.000Z'),
        memoryFlow,
      }),
    ).rejects.toThrow('Local ingest adapter "fake" requires sourceDir because it does not implement fetch().');

    expect(memoryFlow.snapshot()).toMatchObject({
      status: 'error',
      errors: ['Local ingest adapter "fake" requires sourceDir because it does not implement fetch().'],
    });
  });

  it('returns null for missing local ingest status records', async () => {
    await expect(getLocalStageOnlyIngestStatus(project, 'missing-run')).resolves.toBeNull();
  });

  it('diffs local reruns against the latest completed report for the same connection and adapter', async () => {
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders","version":1}\n', 'utf-8');
    await writeFile(join(sourceDir, 'orders', 'customers.json'), '{"name":"customers","version":1}\n', 'utf-8');

    const first = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-job-1',
      now: () => new Date('2026-04-27T12:00:00.000Z'),
    });

    expect(first.previousRunId).toBeNull();
    expect(first.diffSummary).toEqual({ added: 2, modified: 0, deleted: 0, unchanged: 0 });
    expect(first.workUnitCount).toBe(1);
    expect(first.evictionDeletedRawPaths).toEqual([]);

    const unchanged = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-job-2',
      now: () => new Date('2026-04-27T12:05:00.000Z'),
    });

    expect(unchanged.previousRunId).toBe('local-job-1');
    expect(unchanged.syncId).toBe(first.syncId);
    expect(unchanged.diffSummary).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 2 });
    expect(unchanged.workUnitCount).toBe(0);
    expect(unchanged.workUnits).toEqual([]);

    const rawWriteSpy = vi.spyOn(project.fileStore, 'writeFile');
    const commitSpy = vi.spyOn(project.git, 'commitFiles');

    const secondUnchanged = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-job-unchanged-2',
      now: () => new Date('2026-04-27T12:06:00.000Z'),
    });

    expect(secondUnchanged.previousRunId).toBe('local-job-2');
    expect(secondUnchanged.syncId).toBe(first.syncId);
    expect(secondUnchanged.diffSummary).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 2 });
    expect(rawWriteSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();

    const unchangedFiles = await project.fileStore.listFiles('raw-sources/warehouse/fake');
    expect(unchangedFiles.files.every((file) => file.includes(first.syncId))).toBe(true);

    rawWriteSpy.mockRestore();
    commitSpy.mockRestore();

    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders","version":2}\n', 'utf-8');
    await writeFile(join(sourceDir, 'orders', 'payments.json'), '{"name":"payments","version":1}\n', 'utf-8');
    await rm(join(sourceDir, 'orders', 'customers.json'));

    const changed = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-job-3',
      now: () => new Date('2026-04-27T12:10:00.000Z'),
    });

    expect(changed.previousRunId).toBe('local-job-unchanged-2');
    expect(changed.diffSummary).toEqual({ added: 1, modified: 1, deleted: 1, unchanged: 0 });
    expect(changed.evictionDeletedRawPaths).toEqual(['orders/customers.json']);
    expect(changed.workUnits).toEqual([
      {
        unitKey: 'fake-orders',
        rawFiles: ['orders/orders.json', 'orders/payments.json'],
        dependencyPaths: [],
        peerFileIndex: [],
      },
    ]);

    const status = await getLocalStageOnlyIngestStatus(project, 'local-job-3');
    expect(status).toEqual(changed);

    await expect(access(join(project.projectDir, '.ktx', 'db.sqlite'))).resolves.toBeUndefined();
    await expect(
      readFile(join(project.projectDir, '.ktx', 'ingest-runs', 'local-job-3.json'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(join(project.projectDir, '.ktx', 'ingest-reports', 'local-job-3.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('reuses the existing sync id when the same local run id is retried', async () => {
    const sourceDir = join(tempDir, 'idempotent-source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders","version":1}\n', 'utf-8');

    const first = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-idempotent-run',
      now: () => new Date('2026-04-27T12:30:00.000Z'),
    });

    const retry = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-idempotent-run',
      now: () => new Date('2026-04-27T13:30:00.000Z'),
    });

    expect(retry.runId).toBe(first.runId);
    expect(retry.syncId).toBe(first.syncId);
    expect(retry.previousRunId).toBeNull();
    expect(retry.diffSummary).toEqual(first.diffSummary);

    const status = await getLocalStageOnlyIngestStatus(project, 'local-idempotent-run');
    expect(status?.syncId).toBe(first.syncId);

    const files = await project.fileStore.listFiles('raw-sources/warehouse/fake');
    expect(files.files).toEqual(['raw-sources/warehouse/fake/2026-04-27-123000-local-idempotent-run/orders/orders.json']);
  });

  it('prunes stale raw files when retrying the same local run id with a smaller snapshot', async () => {
    const sourceDir = join(tempDir, 'idempotent-prune-source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders","version":1}\n', 'utf-8');
    await writeFile(join(sourceDir, 'orders', 'customers.json'), '{"name":"customers","version":1}\n', 'utf-8');

    const first = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-idempotent-prune',
      now: () => new Date('2026-04-27T12:40:00.000Z'),
    });

    await rm(join(sourceDir, 'orders', 'customers.json'));

    const retry = await runLocalStageOnlyIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'local-idempotent-prune',
      now: () => new Date('2026-04-27T13:40:00.000Z'),
    });

    expect(retry.syncId).toBe(first.syncId);

    const files = await project.fileStore.listFiles(`raw-sources/warehouse/fake/${first.syncId}`);
    expect(files.files).toEqual([`raw-sources/warehouse/fake/${first.syncId}/orders/orders.json`]);
    await expect(
      readFile(join(project.projectDir, 'raw-sources/warehouse/fake', first.syncId, 'orders', 'customers.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('runs fetch-capable adapters without a source directory', async () => {
    await writeLiveDatabaseConfig(project.projectDir);
    project = await loadKtxProject({ projectDir: project.projectDir });

    const result = await runLocalStageOnlyIngest({
      project,
      adapters: [fetchOnlyAdapter()],
      adapter: 'live-database',
      connectionId: 'warehouse',
      jobId: 'local-live-db-1',
      now: () => new Date('2026-04-27T12:00:00.000Z'),
    });

    expect(result).toMatchObject({
      runId: 'local-live-db-1',
      status: 'done',
      adapter: 'live-database',
      connectionId: 'warehouse',
      sourceDir: null,
      rawFileCount: 3,
      workUnitCount: 1,
    });
    expect(result.diffSummary).toEqual({ added: 3, modified: 0, deleted: 0, unchanged: 0 });

    await expect(
      readFile(
        join(
          project.projectDir,
          'raw-sources',
          'warehouse',
          'live-database',
          '2026-04-27-120000-local-live-db-1',
          'tables',
          'orders.json',
        ),
        'utf-8',
      ),
    ).resolves.toContain('"orders"');
  });

  it('supports dry-run planning without writing raw files, status, or commits', async () => {
    await writeLiveDatabaseConfig(project.projectDir);
    project = await loadKtxProject({ projectDir: project.projectDir });

    const result = await runLocalStageOnlyIngest({
      project,
      adapters: [fetchOnlyAdapter()],
      adapter: 'live-database',
      connectionId: 'warehouse',
      jobId: 'local-live-db-dry-run-1',
      now: () => new Date('2026-04-29T08:00:00.000Z'),
      dryRun: true,
    });

    expect(result).toMatchObject({
      runId: 'local-live-db-dry-run-1',
      status: 'done',
      adapter: 'live-database',
      connectionId: 'warehouse',
      syncId: '2026-04-29-080000-local-live-db-dry-run-1',
      rawFileCount: 3,
      workUnitCount: 1,
      diffPaths: {
        added: ['connection.json', 'foreign-keys.json', expect.stringMatching(/^tables\//)],
        modified: [],
        deleted: [],
        unchanged: [],
      },
    });

    await expect(
      readFile(
        join(
          project.projectDir,
          'raw-sources',
          'warehouse',
          'live-database',
          '2026-04-29-080000-local-live-db-dry-run-1',
          'connection.json',
        ),
        'utf-8',
      ),
    ).rejects.toThrow();
    await expect(getLocalStageOnlyIngestStatus(project, 'local-live-db-dry-run-1')).resolves.toBeNull();
  });

  it('uses daemon-backed live-database introspection in default local adapters', async () => {
    await writeLiveDatabaseConfig(project.projectDir);
    project = await loadKtxProject({ projectDir: project.projectDir });
    const runJson = vi.fn(async () => ({
      connection_id: 'warehouse',
      extracted_at: '2026-04-28T10:00:00+00:00',
      metadata: { driver: 'postgres', schemas: ['public'] },
      tables: [
        {
          catalog: 'warehouse',
          db: 'public',
          name: 'orders',
          comment: null,
          columns: [{ name: 'id', type: 'integer', nullable: false, primary_key: true, comment: null }],
          foreign_keys: [],
        },
      ],
    }));

    const result = await runLocalStageOnlyIngest({
      project,
      adapters: createDefaultLocalIngestAdapters(project, {
        databaseIntrospection: { runJson },
      }),
      adapter: 'live-database',
      connectionId: 'warehouse',
      jobId: 'local-live-db-daemon-1',
      now: () => new Date('2026-04-28T10:00:00.000Z'),
    });

    expect(runJson).toHaveBeenCalledWith('database-introspect', {
      connection_id: 'warehouse',
      driver: 'postgres',
      url: 'postgres://localhost:5432/warehouse',
      schemas: ['public'],
      statement_timeout_ms: 30_000,
      connection_timeout_seconds: 5,
    });
    expect(result).toMatchObject({
      runId: 'local-live-db-daemon-1',
      status: 'done',
      adapter: 'live-database',
      connectionId: 'warehouse',
      rawFileCount: 3,
      workUnitCount: 1,
    });
  });

  it('includes upload-capable KTX adapters in default local ingest adapters', () => {
    expect(createDefaultLocalIngestAdapters(project).map((adapter) => adapter.source)).toEqual(
      expect.arrayContaining(['dbt', 'metricflow', 'notion']),
    );
  });

  it('passes resolved standalone Notion config into fetch adapters', async () => {
    const priorToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = 'ntn_local_test_token';
    try {
      await writeFile(
        join(project.projectDir, 'ktx.yaml'),
        [
          'project: warehouse',
          'connections:',
          '  notion-main:',
          '    driver: notion',
          '    auth_token_ref: env:NOTION_TOKEN',
          '    crawl_mode: selected_roots',
          '    root_page_ids:',
          '      - page-1',
          'ingest:',
          '  adapters:',
          '    - notion',
          '',
        ].join('\n'),
        'utf-8',
      );
      project = await loadKtxProject({ projectDir: project.projectDir });

      const fetch = vi.fn(async (_pullConfig: unknown, stagedDir: string) => {
        await mkdir(join(stagedDir, 'pages', 'page-1'), { recursive: true });
        await writeFile(
          join(stagedDir, 'manifest.json'),
          JSON.stringify({
            source: 'notion',
            apiVersion: '2026-03-11',
            crawlMode: 'selected_roots',
            rootPageIds: ['page-1'],
            rootDatabaseIds: [],
            rootDataSourceIds: [],
            fetchedAt: '2026-04-30T00:00:00.000Z',
            pageCount: 1,
            databaseCount: 0,
            dataSourceCount: 0,
            capped: false,
            continuedFromCursor: false,
            partialSnapshot: false,
            maxPagesPerRun: 1000,
            maxKnowledgeCreatesPerRun: 25,
            maxKnowledgeUpdatesPerRun: 20,
            nextSuccessfulCursor: null,
            skipped: [],
            warnings: [],
          }),
          'utf-8',
        );
        await writeFile(
          join(stagedDir, 'pages', 'page-1', 'metadata.json'),
          JSON.stringify({
            objectType: 'page',
            id: 'page-1',
            title: 'Revenue Policy',
            path: 'Revenue Policy',
          }),
          'utf-8',
        );
        await writeFile(join(stagedDir, 'pages', 'page-1', 'page.md'), '# Revenue Policy\n\nDurable rule.\n', 'utf-8');
      });
      const adapter: SourceAdapter = {
        source: 'notion',
        skillNames: ['notion_synthesize'],
        detect: async () => true,
        fetch,
        chunk: async () => ({ workUnits: [] }),
      };

      const result = await runLocalStageOnlyIngest({
        project,
        adapters: [adapter],
        adapter: 'notion',
        connectionId: 'notion-main',
        jobId: 'local-notion-fetch-1',
        now: () => new Date('2026-04-30T00:00:00.000Z'),
      });

      expect(fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: 'ntn_local_test_token',
          crawlMode: 'selected_roots',
          rootPageIds: ['page-1'],
          maxPagesPerRun: 1000,
          maxKnowledgeCreatesPerRun: 25,
        }),
        expect.any(String),
        { connectionId: 'notion-main', sourceKey: 'notion' },
      );
      expect(result).toMatchObject({
        status: 'done',
        adapter: 'notion',
        connectionId: 'notion-main',
        rawFileCount: 3,
      });
    } finally {
      if (priorToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = priorToken;
      }
    }
  });

  it('keeps requiring sourceDir for adapters without fetch', async () => {
    await expect(
      runLocalStageOnlyIngest({
        project,
        adapters: [new FakeSourceAdapter()],
        adapter: 'fake',
        connectionId: 'warehouse',
        jobId: 'local-job-no-source',
        now: () => new Date('2026-04-27T12:00:00.000Z'),
      }),
    ).rejects.toThrow('Local ingest adapter "fake" requires sourceDir because it does not implement fetch().');
  });

  it('rejects adapters that are not enabled in ktx.yaml', async () => {
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await expect(
      runLocalStageOnlyIngest({
        project,
        adapters: [new FakeSourceAdapter()],
        adapter: 'metricflow',
        connectionId: 'warehouse',
        sourceDir,
        jobId: 'local-job-2',
        now: () => new Date('2026-04-27T12:00:00.000Z'),
      }),
    ).rejects.toThrow('Adapter "metricflow" is not enabled in ktx.yaml');
  });
});
