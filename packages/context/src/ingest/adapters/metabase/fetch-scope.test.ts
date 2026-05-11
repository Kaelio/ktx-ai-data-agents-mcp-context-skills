import { describe, expect, it } from 'vitest';
import { computeFetchScope, type FetchScope, hashScope, isPathInMetabaseScope } from './fetch-scope.js';
import type { StagedSyncConfig } from './types.js';

const BASE_CONFIG = {
  metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
  metabaseDatabaseId: 42,
  defaultTagNames: [] as string[],
  mapping: {
    metabaseDatabaseId: 42,
    metabaseDatabaseName: 'Analytics',
    metabaseEngine: 'postgres',
    targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
  },
} satisfies Omit<StagedSyncConfig, 'syncMode' | 'selections'>;

describe('computeFetchScope', () => {
  it('returns { kind: "all" } for syncMode ALL', () => {
    const scope = computeFetchScope({
      ...BASE_CONFIG,
      syncMode: 'ALL',
      selections: [{ selectionType: 'item', metabaseObjectId: 5 }],
    });
    expect(scope).toEqual({ kind: 'all' });
  });

  it('returns { kind: "all-except", ... } for syncMode EXCEPT', () => {
    const scope = computeFetchScope({
      ...BASE_CONFIG,
      syncMode: 'EXCEPT',
      selections: [
        { selectionType: 'item', metabaseObjectId: 5 },
        { selectionType: 'collection', metabaseObjectId: 7 },
      ],
    });
    expect(scope).toEqual({
      kind: 'all-except',
      excludeCardIds: new Set([5]),
      excludeCollectionIds: new Set([7]),
    });
  });

  it('returns { kind: "explicit", ... } for syncMode ONLY', () => {
    const scope = computeFetchScope({
      ...BASE_CONFIG,
      syncMode: 'ONLY',
      selections: [
        { selectionType: 'item', metabaseObjectId: 5 },
        { selectionType: 'item', metabaseObjectId: 11 },
        { selectionType: 'collection', metabaseObjectId: 7 },
      ],
    });
    expect(scope).toEqual({
      kind: 'explicit',
      includeCardIds: new Set([5, 11]),
      includeCollectionIds: new Set([7]),
    });
  });

  it('treats generated ONLY with no selections as all', () => {
    const scope = computeFetchScope({ ...BASE_CONFIG, syncMode: 'ONLY', selections: [] });
    expect(scope).toEqual({ kind: 'all' });
  });
});

describe('hashScope', () => {
  it('produces the same hash for identical inputs', () => {
    const a = hashScope({
      kind: 'explicit',
      includeCardIds: new Set([1, 2, 3]),
      includeCollectionIds: new Set([7]),
    });
    const b = hashScope({
      kind: 'explicit',
      includeCardIds: new Set([3, 2, 1]),
      includeCollectionIds: new Set([7]),
    });
    expect(a).toBe(b);
  });

  it('produces different hashes for different scopes', () => {
    const a = hashScope({ kind: 'all' });
    const b = hashScope({
      kind: 'explicit',
      includeCardIds: new Set([1]),
      includeCollectionIds: new Set(),
    });
    expect(a).not.toBe(b);
  });

  it('produces a 64-char hex string', () => {
    const fp = hashScope({ kind: 'all' });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isPathInMetabaseScope', () => {
  const allScope: FetchScope = { kind: 'all' };
  const exceptScope: FetchScope = {
    kind: 'all-except',
    excludeCardIds: new Set([100]),
    excludeCollectionIds: new Set([5]),
  };
  const explicitScope: FetchScope = {
    kind: 'explicit',
    includeCardIds: new Set([1, 2]),
    includeCollectionIds: new Set([7]),
  };

  it('always includes sync-config.json', () => {
    expect(isPathInMetabaseScope('sync-config.json', allScope)).toBe(true);
    expect(isPathInMetabaseScope('sync-config.json', exceptScope)).toBe(true);
    expect(isPathInMetabaseScope('sync-config.json', explicitScope)).toBe(true);
  });

  it('always includes collections/* and databases/*', () => {
    expect(isPathInMetabaseScope('collections/5.json', explicitScope)).toBe(true);
    expect(isPathInMetabaseScope('databases/42.json', explicitScope)).toBe(true);
  });

  it('for `all` scope, every cards/<id>.json is in scope', () => {
    expect(isPathInMetabaseScope('cards/1.json', allScope)).toBe(true);
    expect(isPathInMetabaseScope('cards/999.json', allScope)).toBe(true);
  });

  it('for `all-except` scope, excluded card ids are out of scope', () => {
    expect(isPathInMetabaseScope('cards/100.json', exceptScope)).toBe(false);
    expect(isPathInMetabaseScope('cards/101.json', exceptScope)).toBe(true);
  });

  it('for `explicit` scope, only include-set card ids are in scope', () => {
    expect(isPathInMetabaseScope('cards/1.json', explicitScope)).toBe(true);
    expect(isPathInMetabaseScope('cards/2.json', explicitScope)).toBe(true);
    expect(isPathInMetabaseScope('cards/3.json', explicitScope)).toBe(false);
  });

  it('unknown path shapes default to in-scope (conservative)', () => {
    expect(isPathInMetabaseScope('some-new-dir/whatever.json', explicitScope)).toBe(true);
  });
});
