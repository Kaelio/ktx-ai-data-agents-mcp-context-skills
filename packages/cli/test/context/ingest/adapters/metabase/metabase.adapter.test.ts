import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetabaseSourceAdapter } from '../../../../../src/context/ingest/adapters/metabase/metabase.adapter.js';

describe('MetabaseSourceAdapter', () => {
  let stagedDir: string;
  let adapter: MetabaseSourceAdapter;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'mb-adapter-'));
    adapter = new MetabaseSourceAdapter({} as any);
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('declares the expected source key and skill list', () => {
    expect(adapter.source).toBe('metabase');
    expect(adapter.skillNames).toEqual(['metabase_ingest']);
  });

  it('detect: true for a valid staged dir', async () => {
    await writeFile(join(stagedDir, 'sync-config.json'), '{}', 'utf-8');
    await mkdir(join(stagedDir, 'cards'), { recursive: true });
    await writeFile(join(stagedDir, 'cards/1.json'), '{}', 'utf-8');
    expect(await adapter.detect(stagedDir)).toBe(true);
  });

  it('detect: false for a random empty dir', async () => {
    expect(await adapter.detect(stagedDir)).toBe(false);
  });

  it('exposes a fetch() method (network-bound — real calls covered by fetch.spec.ts)', () => {
    expect(typeof adapter.fetch).toBe('function');
  });

  it('forwards fetch dependencies using the source-state reader port', async () => {
    const client = {
      getAllCards: vi.fn().mockResolvedValue([]),
      getCollectionTree: vi.fn().mockResolvedValue([]),
      getCollectionItems: vi.fn().mockResolvedValue([]),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
    const clientFactory = {
      createClient: vi.fn().mockResolvedValue(client),
    };
    const sourceStateReader = {
      getSourceState: vi.fn().mockResolvedValue({
        syncMode: 'ALL',
        selections: [],
        defaultTagNames: [],
        mappings: [
          {
            metabaseDatabaseId: 42,
            metabaseDatabaseName: 'Analytics',
            metabaseEngine: 'postgres',
            targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
            syncEnabled: true,
          },
        ],
      }),
    };
    const forwardingAdapter = new MetabaseSourceAdapter({ clientFactory, sourceStateReader });

    await forwardingAdapter.fetch(
      {
        metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
        metabaseDatabaseId: 42,
      },
      stagedDir,
      { connectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789', sourceKey: 'metabase' },
    );

    expect(sourceStateReader.getSourceState).toHaveBeenCalledWith('a1b2c3d4-e5f6-4789-9abc-def012345678');
    expect(clientFactory.createClient).toHaveBeenCalledWith(
      {
        metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
        metabaseDatabaseId: 42,
      },
      { connectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789', sourceKey: 'metabase' },
    );
  });
});

describe('MetabaseSourceAdapter.describeScope', () => {
  const adapter = new MetabaseSourceAdapter({} as any);
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mb-scope-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSyncConfig(cfg: unknown): Promise<void> {
    await writeFile(join(dir, 'sync-config.json'), JSON.stringify(cfg), 'utf-8');
  }

  const BASE = {
    metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
    metabaseDatabaseId: 42,
    defaultTagNames: [],
    mapping: {
      metabaseDatabaseId: 42,
      metabaseDatabaseName: 'Analytics',
      metabaseEngine: 'postgres',
      targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
    },
  };

  it('returns a fingerprint + predicate for ONLY-scope staged dir', async () => {
    await writeSyncConfig({
      ...BASE,
      syncMode: 'ONLY',
      selections: [{ selectionType: 'item', metabaseObjectId: 5 }],
    });
    const scope = await adapter.describeScope(dir);
    expect(scope.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.isPathInScope('cards/5.json')).toBe(true);
    expect(scope.isPathInScope('cards/99.json')).toBe(false);
    expect(scope.isPathInScope('sync-config.json')).toBe(true);
  });

  it('fingerprint is stable across invocations', async () => {
    await writeSyncConfig({
      ...BASE,
      syncMode: 'ONLY',
      selections: [
        { selectionType: 'item', metabaseObjectId: 1 },
        { selectionType: 'item', metabaseObjectId: 2 },
      ],
    });
    const a = await adapter.describeScope(dir);
    const b = await adapter.describeScope(dir);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('different syncMode produces different fingerprint', async () => {
    await writeSyncConfig({ ...BASE, syncMode: 'ALL', selections: [] });
    const all = await adapter.describeScope(dir);
    await writeSyncConfig({
      ...BASE,
      syncMode: 'ONLY',
      selections: [{ selectionType: 'item', metabaseObjectId: 1 }],
    });
    const only = await adapter.describeScope(dir);
    expect(all.fingerprint).not.toBe(only.fingerprint);
  });
});
