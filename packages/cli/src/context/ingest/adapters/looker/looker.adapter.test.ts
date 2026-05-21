import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookerRuntimeClient } from './fetch.js';
import { LookerSourceAdapter } from './looker.adapter.js';

const connectionId = '11111111-1111-4111-8111-111111111111';

function makeClient(): LookerRuntimeClient {
  return {
    listDashboards: vi.fn().mockResolvedValue([]),
    getDashboard: vi.fn(),
    listLooks: vi.fn().mockResolvedValue([]),
    getLook: vi.fn(),
    listFolders: vi.fn().mockResolvedValue({ folders: [] }),
    listUsers: vi.fn().mockResolvedValue([]),
    listGroups: vi.fn().mockResolvedValue([]),
    listLookmlModels: vi.fn().mockResolvedValue({
      models: [{ name: 'b2b', label: 'B2B', explores: [{ name: 'sales_pipeline', label: 'Sales Pipeline' }] }],
    }),
    getExplore: vi.fn().mockResolvedValue({
      modelName: 'b2b',
      exploreName: 'sales_pipeline',
      label: 'Sales Pipeline',
      description: null,
      fields: { dimensions: [], measures: [] },
      joins: [],
    }),
  };
}

describe('LookerSourceAdapter', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'looker-adapter-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('exposes source="looker" and skillNames=["looker_ingest"]', () => {
    const adapter = new LookerSourceAdapter({ clientFactory: { createClient: () => makeClient() } });
    expect(adapter.source).toBe('looker');
    expect(adapter.skillNames).toEqual(['looker_ingest']);
  });

  it('enables context evidence indexing and delegates triage signals', async () => {
    const adapter = new LookerSourceAdapter({ clientFactory: { createClient: () => makeClient() } });

    expect(adapter.evidenceIndexing).toBe('documents');
    expect(adapter.triageSupported).toBe(true);
    await expect(adapter.getTriageSignals?.(stagedDir, 'looker:dashboard:10')).resolves.toMatchObject({
      objectType: 'looker_dashboard',
    });
  });

  it('fetches, detects, and chunks a runtime bundle through the composed adapter', async () => {
    const adapter = new LookerSourceAdapter({
      clientFactory: { createClient: vi.fn().mockResolvedValue(makeClient()) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    await mkdir(stagedDir, { recursive: true });
    await adapter.fetch({ lookerConnectionId: connectionId }, stagedDir, { connectionId, sourceKey: 'looker' });

    expect(await adapter.detect(stagedDir)).toBe(true);
    expect(await readFile(join(stagedDir, 'explores/b2b/sales_pipeline.json'), 'utf-8')).toContain('sales_pipeline');

    const result = await adapter.chunk(stagedDir);
    expect(result.workUnits.map((wu) => wu.unitKey)).toEqual(['looker-explore-b2b-sales_pipeline']);
  });

  it('passes pull success notifications to the server callback', async () => {
    const onPullSucceeded = vi.fn().mockResolvedValue(undefined);
    const adapter = new LookerSourceAdapter({
      clientFactory: { createClient: () => makeClient() },
      onPullSucceeded,
    });
    const completedAt = new Date('2026-04-30T12:00:00.000Z');

    await adapter.onPullSucceeded({
      connectionId,
      sourceKey: 'looker',
      syncId: 'sync-1',
      trigger: 'scheduled_pull',
      completedAt,
      stagedDir: '/tmp/staged',
    });

    expect(onPullSucceeded).toHaveBeenCalledWith({
      connectionId,
      sourceKey: 'looker',
      syncId: 'sync-1',
      trigger: 'scheduled_pull',
      completedAt,
      stagedDir: '/tmp/staged',
    });
  });

  it('describes incremental fetch scope from the staged scope file', async () => {
    await mkdir(join(stagedDir, 'dashboards'), { recursive: true });
    await writeFile(
      join(stagedDir, 'looker-scope.json'),
      JSON.stringify(
        {
          mode: 'incremental',
          knownCurrentRawPaths: ['dashboards/10.json', 'dashboards/11.json'],
          fetchedRawPaths: ['dashboards/11.json'],
        },
        null,
        2,
      ),
    );
    const adapter = new LookerSourceAdapter({ clientFactory: { createClient: () => makeClient() } });

    const scope = await adapter.describeScope(stagedDir);

    expect(scope.isPathInScope('dashboards/10.json')).toBe(false);
    expect(scope.isPathInScope('dashboards/11.json')).toBe(true);
    expect(scope.isPathInScope('dashboards/12.json')).toBe(true);
  });
});
