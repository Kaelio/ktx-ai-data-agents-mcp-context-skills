import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkLookerStagedDir } from './chunk.js';
import { writeLookerEvidenceDocuments } from './evidence-documents.js';

async function writeJson(stagedDir: string, relPath: string, value: unknown): Promise<void> {
  const abs = join(stagedDir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeSmallFixture(stagedDir: string): Promise<void> {
  await writeJson(stagedDir, 'sync-config.json', {
    lookerConnectionId: '11111111-1111-4111-8111-111111111111',
    fetchedAt: '2026-04-30T12:30:00.000Z',
  });
  await writeJson(stagedDir, 'lookml_models.json', {
    models: [{ name: 'b2b', label: 'B2B', explores: [{ name: 'sales_pipeline', label: 'Sales Pipeline' }] }],
  });
  await writeJson(stagedDir, 'explores/b2b/sales_pipeline.json', {
    modelName: 'b2b',
    exploreName: 'sales_pipeline',
    label: 'Sales Pipeline',
    description: null,
    fields: { dimensions: [{ name: 'opportunities.id' }], measures: [{ name: 'opportunities.arr' }] },
    joins: [],
  });
  await writeJson(stagedDir, 'dashboards/10.json', {
    lookerId: '10',
    title: 'Sales Pipeline',
    description: null,
    folderId: '7',
    ownerId: '3',
    updatedAt: '2026-04-30T12:00:00.000Z',
    tiles: [{ id: '100', title: 'ARR', lookId: null, query: { model: 'b2b', view: 'sales_pipeline' } }],
  });
  await writeJson(stagedDir, 'looks/20.json', {
    lookerId: '20',
    title: 'Open Pipeline',
    description: null,
    folderId: '7',
    ownerId: '3',
    updatedAt: '2026-04-30T12:00:00.000Z',
    query: { model: 'b2b', view: 'sales_pipeline', fields: ['opportunities.arr'] },
  });
  await writeJson(stagedDir, 'folders/tree.json', {
    folders: [{ id: '7', name: 'Sandbox', parentId: null, path: ['Sandbox'] }],
  });
  await writeJson(stagedDir, 'users/3.json', { id: '3', displayName: 'Ada Lovelace', email: null });
  await writeJson(stagedDir, 'signals/dashboard_usage.json', [
    { contentId: '10', queryCount30d: 50, uniqueUsers30d: 8 },
  ]);
  await writeJson(stagedDir, 'signals/look_usage.json', [{ contentId: '20', queryCount30d: 20, uniqueUsers30d: 5 }]);
  await writeJson(stagedDir, 'signals/scheduled_plans.json', [
    { contentId: '10', contentType: 'dashboard', isScheduled: true, scheduleCount: 1, recipientCount: 3 },
  ]);
  await writeJson(stagedDir, 'signals/favorites.json', [
    { contentId: '10', contentType: 'dashboard', favoriteCount: 4 },
  ]);
  await writeLookerEvidenceDocuments(stagedDir);
}

describe('chunkLookerStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'looker-chunk-'));
    await writeSmallFixture(stagedDir);
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('emits one WU per explore, dashboard, and Look with readable dependencies', async () => {
    const result = await chunkLookerStagedDir(stagedDir);
    expect(result.reconcileNotes).toEqual([
      expect.stringContaining('emit_artifact_resolution with actionType="subsumed"'),
    ]);
    expect(result.workUnits.map((wu) => wu.unitKey).sort()).toEqual([
      'looker-dashboard-10',
      'looker-explore-b2b-sales_pipeline',
      'looker-look-20',
    ]);

    const dashboard = result.workUnits.find((wu) => wu.unitKey === 'looker-dashboard-10');
    expect(dashboard?.rawFiles).toEqual([
      'dashboards/10.json',
      'evidence/dashboards/10/metadata.json',
      'evidence/dashboards/10/page.md',
    ]);
    expect(dashboard?.notes).toContain('context_candidate_write');
    expect(dashboard?.notes).not.toContain('wiki_write');
    expect(dashboard?.dependencyPaths.sort()).toEqual([
      'explores/b2b/sales_pipeline.json',
      'folders/tree.json',
      'signals/dashboard_usage.json',
      'signals/favorites.json',
      'signals/scheduled_plans.json',
      'users/3.json',
    ]);

    const explore = result.workUnits.find((wu) => wu.unitKey === 'looker-explore-b2b-sales_pipeline');
    expect(explore?.rawFiles).toEqual([
      'explores/b2b/sales_pipeline.json',
      'evidence/explores/b2b/sales_pipeline/metadata.json',
      'evidence/explores/b2b/sales_pipeline/page.md',
    ]);
    expect(explore?.dependencyPaths).toEqual(['lookml_models.json']);
  });

  it('keeps downstream dashboard and Look WUs when an explore dependency changes', async () => {
    const result = await chunkLookerStagedDir(stagedDir, {
      added: [],
      modified: ['explores/b2b/sales_pipeline.json'],
      deleted: [],
      unchanged: [
        'dashboards/10.json',
        'looks/20.json',
        'lookml_models.json',
        'folders/tree.json',
        'users/3.json',
        'signals/dashboard_usage.json',
        'signals/look_usage.json',
        'signals/scheduled_plans.json',
        'signals/favorites.json',
      ],
    });

    expect(result.workUnits.map((wu) => wu.unitKey).sort()).toEqual([
      'looker-dashboard-10',
      'looker-explore-b2b-sales_pipeline',
      'looker-look-20',
    ]);
    expect(result.workUnits.find((wu) => wu.unitKey === 'looker-dashboard-10')?.rawFiles).toEqual([
      'dashboards/10.json',
      'evidence/dashboards/10/metadata.json',
      'evidence/dashboards/10/page.md',
    ]);
  });

  it('returns an EvictionUnit for deleted runtime entity raw paths', async () => {
    const result = await chunkLookerStagedDir(stagedDir, {
      added: [],
      modified: [],
      deleted: ['looks/20.json'],
      unchanged: ['dashboards/10.json', 'explores/b2b/sales_pipeline.json'],
    });

    expect(result.eviction).toEqual({ deletedRawPaths: ['looks/20.json'] });
  });
});
