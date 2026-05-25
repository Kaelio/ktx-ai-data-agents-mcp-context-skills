import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkMetabaseStagedDir } from '../../../../../src/context/ingest/adapters/metabase/chunk.js';
import { stagedSyncConfigSchema } from '../../../../../src/context/ingest/adapters/metabase/types.js';

const FIXTURES = resolve(__dirname, '../../../../fixtures/metabase');
const SIMPLE = join(FIXTURES, 'simple');
const MULTI = join(FIXTURES, 'multi-collection');
const CARD_REF = join(FIXTURES, 'card-ref');

describe('chunkMetabaseStagedDir — first run', () => {
  it('simple fixture emits one WU for collection 5 containing cards + collection file; shared control files in dependencyPaths', async () => {
    const result = await chunkMetabaseStagedDir(SIMPLE);
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.unitKey).toBe('metabase-col-5');
    expect(wu.rawFiles.sort()).toEqual(['cards/1.json', 'cards/2.json', 'collections/5.json']);
    expect(wu.dependencyPaths.sort()).toEqual(['databases/42.json', 'sync-config.json']);
    expect(wu.peerFileIndex).toEqual([]);
    expect(wu.notes).toContain('collection 5');
    expect(wu.notes).toContain('2 cards');
  });

  it('multi-collection fixture emits two WUs — one per collection — deterministic by id', async () => {
    const result = await chunkMetabaseStagedDir(MULTI);
    expect(result.workUnits).toHaveLength(2);
    expect(result.workUnits.map((wu) => wu.unitKey)).toEqual(['metabase-col-5', 'metabase-col-6']);
    expect(result.workUnits[0].rawFiles).toContain('cards/1.json');
    expect(result.workUnits[0].rawFiles).toContain('cards/2.json');
    expect(result.workUnits[0].rawFiles).not.toContain('cards/3.json');
    expect(result.workUnits[1].rawFiles).toContain('cards/3.json');
    expect(result.workUnits[1].rawFiles).not.toContain('cards/1.json');
    // Each WU's peerFileIndex contains the OTHER collection's card files.
    expect(result.workUnits[0].peerFileIndex).toContain('cards/3.json');
    expect(result.workUnits[1].peerFileIndex).toContain('cards/1.json');
  });

  it('card-ref fixture: cross-card reference inside the same collection lands in rawFiles, NOT dependencyPaths', async () => {
    const result = await chunkMetabaseStagedDir(CARD_REF);
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.rawFiles).toContain('cards/10.json');
    expect(wu.rawFiles).toContain('cards/11.json');
    expect(wu.dependencyPaths).not.toContain('cards/10.json');
    expect(wu.dependencyPaths).not.toContain('cards/11.json');
  });

  it('is deterministic: two identical invocations return structurally-equal WUs', async () => {
    const r1 = await chunkMetabaseStagedDir(SIMPLE);
    const r2 = await chunkMetabaseStagedDir(SIMPLE);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('DiffSet re-sync keeps only WUs with a changed card; unchanged siblings land in dependencyPaths', async () => {
    const result = await chunkMetabaseStagedDir(SIMPLE, {
      diffSet: {
        added: [],
        modified: ['cards/1.json'],
        deleted: [],
        unchanged: ['cards/2.json', 'collections/5.json', 'databases/42.json', 'sync-config.json'],
      },
    });
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0];
    expect(wu.rawFiles).toEqual(['cards/1.json']);
    expect(wu.dependencyPaths.sort()).toEqual([
      'cards/2.json',
      'collections/5.json',
      'databases/42.json',
      'sync-config.json',
    ]);
  });

  it('DiffSet re-sync: all-unchanged yields zero WUs and no eviction', async () => {
    const result = await chunkMetabaseStagedDir(SIMPLE, {
      diffSet: {
        added: [],
        modified: [],
        deleted: [],
        unchanged: ['cards/1.json', 'cards/2.json', 'collections/5.json', 'databases/42.json', 'sync-config.json'],
      },
    });
    expect(result.workUnits).toEqual([]);
    expect(result.eviction).toBeUndefined();
  });

  it('DiffSet re-sync: deleted card emits an EvictionUnit', async () => {
    const result = await chunkMetabaseStagedDir(SIMPLE, {
      diffSet: {
        added: [],
        modified: [],
        deleted: ['cards/1.json'],
        unchanged: ['cards/2.json', 'collections/5.json', 'databases/42.json', 'sync-config.json'],
      },
    });
    expect(result.workUnits).toEqual([]);
    expect(result.eviction).toEqual({ deletedRawPaths: ['cards/1.json'] });
  });

  it('DiffSet re-sync: sync-config.json change alone does NOT trigger any WU', async () => {
    const result = await chunkMetabaseStagedDir(SIMPLE, {
      diffSet: {
        added: [],
        modified: ['sync-config.json'],
        deleted: [],
        unchanged: ['cards/1.json', 'cards/2.json', 'collections/5.json', 'databases/42.json'],
      },
    });
    expect(result.workUnits).toEqual([]);
    expect(result.eviction).toBeUndefined();
  });

  it('DiffSet re-sync: databases/{id}.json change alone does NOT trigger any WU', async () => {
    const result = await chunkMetabaseStagedDir(SIMPLE, {
      diffSet: {
        added: [],
        modified: ['databases/42.json'],
        deleted: [],
        unchanged: ['cards/1.json', 'cards/2.json', 'collections/5.json', 'sync-config.json'],
      },
    });
    expect(result.workUnits).toEqual([]);
    expect(result.eviction).toBeUndefined();
  });
});

async function writeInline(stagedDir: string, rel: string, body: object): Promise<void> {
  const abs = join(stagedDir, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, JSON.stringify(body), 'utf-8');
}

describe('chunkMetabaseStagedDir — selected mode filters non-matching cards', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mb-chunk-select-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('cards outside selected collections are NOT in any WU', async () => {
    await writeInline(dir, 'sync-config.json', {
      metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
      metabaseDatabaseId: 42,
      syncMode: 'ONLY',
      selections: [{ selectionType: 'collection', metabaseObjectId: 5 }],
      defaultTagNames: [],
      mapping: {
        metabaseDatabaseId: 42,
        metabaseDatabaseName: 'Analytics',
        metabaseEngine: 'postgres',
        targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
      },
    });
    await writeInline(dir, 'databases/42.json', {
      metabaseDatabaseId: 42,
      metabaseDatabaseName: 'Analytics',
      metabaseEngine: 'postgres',
      targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
    });
    await writeInline(dir, 'collections/5.json', { metabaseId: 5, name: 'A', parentId: 'root' });
    await writeInline(dir, 'collections/6.json', { metabaseId: 6, name: 'B', parentId: 'root' });
    await writeInline(dir, 'cards/100.json', {
      metabaseId: 100,
      name: 'In',
      description: null,
      type: 'model',
      databaseId: 42,
      collectionId: 5,
      archived: false,
      resolvedSql: 'SELECT 1',
      templateTags: [],
      resultMetadata: [],
      collectionPath: ['A'],
      referencedCardIds: [],
      resolutionStatus: 'resolved',
    });
    await writeInline(dir, 'cards/200.json', {
      metabaseId: 200,
      name: 'Out',
      description: null,
      type: 'model',
      databaseId: 42,
      collectionId: 6,
      archived: false,
      resolvedSql: 'SELECT 1',
      templateTags: [],
      resultMetadata: [],
      collectionPath: ['B'],
      referencedCardIds: [],
      resolutionStatus: 'resolved',
    });
    const result = await chunkMetabaseStagedDir(dir);
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].unitKey).toBe('metabase-col-5');
    expect(result.workUnits[0].rawFiles).toContain('cards/100.json');
    expect(result.workUnits[0].rawFiles).not.toContain('cards/200.json');
  });
});

describe('chunkMetabaseStagedDir — syncMode enum coverage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mb-chunk-enum-'));
    await writeInline(dir, 'databases/42.json', {
      metabaseDatabaseId: 42,
      metabaseDatabaseName: 'Analytics',
      metabaseEngine: 'postgres',
      targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
    });
    await writeInline(dir, 'collections/5.json', { metabaseId: 5, name: 'A', parentId: 'root' });
    await writeInline(dir, 'collections/6.json', { metabaseId: 6, name: 'B', parentId: 'root' });
    await writeInline(dir, 'cards/100.json', {
      metabaseId: 100,
      name: 'In',
      description: null,
      type: 'model',
      databaseId: 42,
      collectionId: 5,
      archived: false,
      resolvedSql: 'SELECT 1',
      templateTags: [],
      resultMetadata: [],
      collectionPath: ['A'],
      referencedCardIds: [],
      resolutionStatus: 'resolved',
    });
    await writeInline(dir, 'cards/200.json', {
      metabaseId: 200,
      name: 'Out',
      description: null,
      type: 'model',
      databaseId: 42,
      collectionId: 6,
      archived: false,
      resolvedSql: 'SELECT 1',
      templateTags: [],
      resultMetadata: [],
      collectionPath: ['B'],
      referencedCardIds: [],
      resolutionStatus: 'resolved',
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const BASE_SYNC = {
    metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
    metabaseDatabaseId: 42,
    defaultTagNames: [] as string[],
    mapping: {
      metabaseDatabaseId: 42,
      metabaseDatabaseName: 'Analytics',
      metabaseEngine: 'postgres',
      targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
    },
  };

  it('ALL includes every non-archived card on the matching database', async () => {
    await writeInline(dir, 'sync-config.json', {
      ...BASE_SYNC,
      syncMode: 'ALL',
      selections: [],
    });
    const result = await chunkMetabaseStagedDir(dir);
    const allRawFiles = result.workUnits.flatMap((wu) => wu.rawFiles);
    expect(allRawFiles).toContain('cards/100.json');
    expect(allRawFiles).toContain('cards/200.json');
  });

  it('ONLY includes cards in selected collections; excludes the rest', async () => {
    await writeInline(dir, 'sync-config.json', {
      ...BASE_SYNC,
      syncMode: 'ONLY',
      selections: [{ selectionType: 'collection', metabaseObjectId: 5 }],
    });
    const result = await chunkMetabaseStagedDir(dir);
    const allRawFiles = result.workUnits.flatMap((wu) => wu.rawFiles);
    expect(allRawFiles).toContain('cards/100.json');
    expect(allRawFiles).not.toContain('cards/200.json');
  });

  it('ONLY with no selections includes every matching card for old generated configs', async () => {
    await writeInline(dir, 'sync-config.json', {
      ...BASE_SYNC,
      syncMode: 'ONLY',
      selections: [],
    });
    const result = await chunkMetabaseStagedDir(dir);
    const allRawFiles = result.workUnits.flatMap((wu) => wu.rawFiles);
    expect(allRawFiles).toContain('cards/100.json');
    expect(allRawFiles).toContain('cards/200.json');
  });

  it('EXCEPT excludes cards in selected collections; includes the rest', async () => {
    await writeInline(dir, 'sync-config.json', {
      ...BASE_SYNC,
      syncMode: 'EXCEPT',
      selections: [{ selectionType: 'collection', metabaseObjectId: 5 }],
    });
    const result = await chunkMetabaseStagedDir(dir);
    const allRawFiles = result.workUnits.flatMap((wu) => wu.rawFiles);
    expect(allRawFiles).not.toContain('cards/100.json');
    expect(allRawFiles).toContain('cards/200.json');
  });

  it('lowercase syncMode is rejected at parse time', () => {
    const parsed = stagedSyncConfigSchema.safeParse({
      ...BASE_SYNC,
      syncMode: 'all',
      selections: [],
    });
    expect(parsed.success).toBe(false);
  });
});
