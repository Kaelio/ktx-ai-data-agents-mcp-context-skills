import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunnerService } from '../agent/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import { LocalMetabaseDiscoveryCache } from './adapters/metabase/local-source-state-store.js';
import { getLocalIngestStatus, runLocalMetabaseIngest } from './local-ingest.js';
import type { ChunkResult, FetchContext, SourceAdapter } from './types.js';

class TestAgentRunner extends AgentRunnerService {
  override runLoop = vi.fn(async (params: Parameters<AgentRunnerService['runLoop']>[0]) => {
    if (params.userPrompt.includes('metabase-db-2')) {
      return { stopReason: 'error' as const, error: new Error('database 2 failed') };
    }
    return { stopReason: 'natural' as const };
  });

  constructor() {
    super({ llmProvider: { getModel: () => ({}) as never } as never });
  }
}

class FakeMetabaseSourceAdapter implements SourceAdapter {
  readonly source = 'metabase';
  readonly skillNames: string[] = [];

  detect(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    const config = pullConfig as { metabaseConnectionId: string; metabaseDatabaseId: number };
    await mkdir(join(stagedDir, 'cards'), { recursive: true });
    await mkdir(join(stagedDir, 'databases'), { recursive: true });
    await writeFile(
      join(stagedDir, 'cards', `${config.metabaseDatabaseId}.json`),
      JSON.stringify({ connectionId: ctx.connectionId, databaseId: config.metabaseDatabaseId }),
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'databases', `${config.metabaseDatabaseId}.json`),
      JSON.stringify({ metabaseConnectionId: config.metabaseConnectionId }),
      'utf-8',
    );
  }

  async chunk(stagedDir: string): Promise<ChunkResult> {
    const databaseId = Number(stagedDir.match(/metabase-child-(\d+)/)?.[1] ?? 1);
    return {
      workUnits: [
        {
          unitKey: `metabase-db-${databaseId}`,
          rawFiles: [`cards/${databaseId}.json`],
          peerFileIndex: [],
          dependencyPaths: [`databases/${databaseId}.json`],
        },
      ],
    };
  }
}

class ThrowingFetchMetabaseSourceAdapter extends FakeMetabaseSourceAdapter {
  override async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    const config = pullConfig as { metabaseConnectionId: string; metabaseDatabaseId: number };
    if (config.metabaseDatabaseId === 2) {
      throw new Error('Metabase fetch failed for database 2');
    }
    await super.fetch(pullConfig, stagedDir, ctx);
  }
}

describe('runLocalMetabaseIngest', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-metabase-fanout-'));
    project = await initKtxProject({ projectDir: tempDir, force: true });
    project.config.connections = {
      'prod-metabase': {
        driver: 'metabase',
        api_url: 'https://metabase.example.com',
        api_key: 'literal-test-key', // pragma: allowlist secret
      },
      warehouse_a: { driver: 'postgres', url: 'postgres://localhost/a' },
      warehouse_b: { driver: 'postgres', url: 'postgres://localhost/b' },
    };
    project.config.ingest.adapters = ['metabase'];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedMetabaseState(): Promise<void> {
    project.config.connections['prod-metabase'].mappings = {
      databaseMappings: { '1': 'warehouse_a', '2': 'warehouse_b' },
      syncEnabled: { '1': true, '2': true },
      syncMode: 'ALL',
      defaultTagNames: ['ktx'],
      selections: { collections: [], items: [] },
    };
    const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: join(tempDir, '.ktx', 'db.sqlite') });
    await discoveryCache.refreshDiscoveredDatabases({
      connectionId: 'prod-metabase',
      discovered: [
        { id: 1, name: 'Warehouse A', engine: 'postgres', host: 'localhost', dbName: 'a' },
        { id: 2, name: 'Warehouse B', engine: 'postgres', host: 'localhost', dbName: 'b' },
      ],
    });
  }

  it('runs one child job per sync-enabled Metabase mapping', async () => {
    await seedMetabaseState();
    const agentRunner = new TestAgentRunner();
    const ids = ['metabase-child-1', 'metabase-child-3'];

    const result = await runLocalMetabaseIngest({
      project,
      adapters: [new FakeMetabaseSourceAdapter()],
      metabaseConnectionId: 'prod-metabase',
      agentRunner,
      jobIdFactory: () => ids.shift() ?? 'metabase-child-extra',
    });

    expect(result.metabaseConnectionId).toBe('prod-metabase');
    expect(result.status).toBe('all_succeeded');
    expect(result.children.map((child) => child.targetConnectionId)).toEqual(['warehouse_a', 'warehouse_b']);
    expect(result.children.map((child) => child.metabaseDatabaseId)).toEqual([1, 2]);
    expect(new Set(result.children.map((child) => child.jobId)).size).toBe(2);
    await expect(getLocalIngestStatus(project, result.children[0].jobId)).resolves.toMatchObject({
      jobId: result.children[0].jobId,
      connectionId: 'warehouse_a',
      sourceKey: 'metabase',
    });
  });

  it('throws before runner work when there are no sync-enabled mapped rows', async () => {
    project.config.connections['prod-metabase'].mappings = {
      databaseMappings: { '1': null },
      syncEnabled: { '1': true },
    };

    await expect(
      runLocalMetabaseIngest({
        project,
        adapters: [new FakeMetabaseSourceAdapter()],
        metabaseConnectionId: 'prod-metabase',
        agentRunner: new TestAgentRunner(),
      }),
    ).rejects.toThrow('no sync-enabled mappings with a target connection');
  });

  it('seeds yaml-only Metabase mappings before the unhydrated fan-out preflight', async () => {
    project.config.connections['prod-metabase'].mappings = {
      databaseMappings: { '1': 'warehouse_a' },
      syncEnabled: { '1': true },
    };

    const result = await runLocalMetabaseIngest({
      project,
      adapters: [new FakeMetabaseSourceAdapter()],
      metabaseConnectionId: 'prod-metabase',
      agentRunner: new TestAgentRunner(),
      jobIdFactory: () => 'metabase-child-1',
    });

    expect(result.status).toBe('all_succeeded');
    expect(result.children).toMatchObject([
      {
        metabaseConnectionId: 'prod-metabase',
        metabaseDatabaseId: 1,
        targetConnectionId: 'warehouse_a',
      },
    ]);
  });

  it('rejects source-dir uploads through the Metabase fan-out runner', async () => {
    await expect(
      runLocalMetabaseIngest({
        project,
        adapters: [new FakeMetabaseSourceAdapter()],
        metabaseConnectionId: 'prod-metabase',
        agentRunner: new TestAgentRunner(),
        sourceDir: tempDir,
      } as Parameters<typeof runLocalMetabaseIngest>[0] & { sourceDir: string }),
    ).rejects.toThrow('source-dir uploads are not supported for the Metabase fan-out adapter');
  });

  it('reports partial failure when a child job fails', async () => {
    await seedMetabaseState();
    const agentRunner = new TestAgentRunner();
    const ids = ['metabase-child-1', 'metabase-child-2'];

    const result = await runLocalMetabaseIngest({
      project,
      adapters: [new FakeMetabaseSourceAdapter()],
      metabaseConnectionId: 'prod-metabase',
      agentRunner,
      jobIdFactory: () => ids.shift() ?? 'metabase-child-extra',
    });

    expect(result.status).toBe('partial_failure');
    expect(result.totals).toEqual({ workUnits: 2, failedWorkUnits: 1 });
    expect(result.children[1]?.report.body.failedWorkUnits).toEqual(['metabase-db-2']);
  });

  it('captures fetch-time child failures and continues later mappings', async () => {
    await seedMetabaseState();
    project.config.connections.warehouse_c = { driver: 'postgres', url: 'postgres://localhost/c' };
    project.config.connections['prod-metabase'].mappings = {
      databaseMappings: { '1': 'warehouse_a', '2': 'warehouse_b', '3': 'warehouse_c' },
      syncEnabled: { '1': true, '2': true, '3': true },
      syncMode: 'ALL',
      defaultTagNames: ['ktx'],
      selections: { collections: [], items: [] },
    };
    const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: join(tempDir, '.ktx', 'db.sqlite') });
    await discoveryCache.refreshDiscoveredDatabases({
      connectionId: 'prod-metabase',
      discovered: [
        { id: 1, name: 'Warehouse A', engine: 'postgres', host: 'localhost', dbName: 'a' },
        { id: 2, name: 'Warehouse B', engine: 'postgres', host: 'localhost', dbName: 'b' },
        { id: 3, name: 'Warehouse C', engine: 'postgres', host: 'localhost', dbName: 'c' },
      ],
    });

    const ids = ['metabase-child-1', 'metabase-child-2', 'metabase-child-3'];
    const result = await runLocalMetabaseIngest({
      project,
      adapters: [new ThrowingFetchMetabaseSourceAdapter()],
      metabaseConnectionId: 'prod-metabase',
      agentRunner: new TestAgentRunner(),
      jobIdFactory: () => ids.shift() ?? 'metabase-child-extra',
    });

    expect(result.status).toBe('partial_failure');
    expect(result.children.map((child) => child.jobId)).toEqual([
      'metabase-child-1',
      'metabase-child-2',
      'metabase-child-3',
    ]);
    expect(result.children.map((child) => child.metabaseDatabaseId)).toEqual([1, 2, 3]);
    expect(result.children.map((child) => child.targetConnectionId)).toEqual(['warehouse_a', 'warehouse_b', 'warehouse_c']);
    expect(result.totals).toEqual({ workUnits: 3, failedWorkUnits: 1 });

    const failed = result.children[1];
    expect(failed.result).toMatchObject({
      jobId: 'metabase-child-2',
      failedWorkUnits: ['metabase-fetch'],
      artifactsWritten: 0,
      commitSha: null,
    });
    expect(failed.report.body.workUnits).toMatchObject([
      {
        unitKey: 'metabase-fetch',
        status: 'failed',
        reason: 'Metabase fetch failed for database 2',
      },
    ]);
    await expect(getLocalIngestStatus(project, failed.jobId)).resolves.toMatchObject({
      jobId: 'metabase-child-2',
      connectionId: 'warehouse_b',
      sourceKey: 'metabase',
      body: {
        failedWorkUnits: ['metabase-fetch'],
      },
    });
  });
});
