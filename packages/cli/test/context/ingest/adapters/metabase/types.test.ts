import { describe, expect, it } from 'vitest';
import {
  metabasePullConfigSchema,
  parseMetabasePullConfig,
  stagedCardFileSchema,
  stagedSyncConfigSchema,
} from '../../../../../src/context/ingest/adapters/metabase/types.js';

describe('metabase adapter types', () => {
  it('parses a valid MetabasePullConfig', () => {
    const parsed = parseMetabasePullConfig({
      metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
      metabaseDatabaseId: 42,
    });
    expect(parsed.metabaseConnectionId).toBe('a1b2c3d4-e5f6-4789-9abc-def012345678');
    expect(parsed.metabaseDatabaseId).toBe(42);
  });

  it('parses local-safe Metabase connection IDs for standalone projects', () => {
    const parsed = parseMetabasePullConfig({ metabaseConnectionId: 'prod-metabase', metabaseDatabaseId: 42 });
    expect(parsed.metabaseConnectionId).toBe('prod-metabase');
  });

  it('rejects unsafe metabaseConnectionId values', () => {
    expect(() => parseMetabasePullConfig({ metabaseConnectionId: '../prod', metabaseDatabaseId: 42 })).toThrow();
  });

  it('rejects missing metabaseDatabaseId', () => {
    const parsed = metabasePullConfigSchema.safeParse({ metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678' });
    expect(parsed.success).toBe(false);
  });

  it('stagedCardFileSchema accepts a minimal card', () => {
    const parsed = stagedCardFileSchema.parse({
      metabaseId: 1,
      name: 'Orders',
      description: null,
      type: 'model',
      databaseId: 42,
      collectionId: 5,
      archived: false,
      resolvedSql: 'SELECT * FROM orders',
      templateTags: [],
      resultMetadata: [],
      collectionPath: ['Data', 'Orders'],
      referencedCardIds: [],
      resolutionStatus: 'resolved',
    });
    expect(parsed.metabaseId).toBe(1);
    expect(parsed.collectionPath).toEqual(['Data', 'Orders']);
  });

  it('stagedSyncConfigSchema accepts selections + mappings snapshot', () => {
    const parsed = stagedSyncConfigSchema.parse({
      metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
      metabaseDatabaseId: 42,
      syncMode: 'ALL',
      selections: [],
      defaultTagNames: [],
      mapping: {
        metabaseDatabaseId: 42,
        metabaseDatabaseName: 'Analytics',
        metabaseEngine: 'postgres',
        targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
      },
    });
    expect(parsed.syncMode).toBe('ALL');
  });

  it('stagedSyncConfigSchema accepts local-safe connection IDs', () => {
    const parsed = stagedSyncConfigSchema.parse({
      metabaseConnectionId: 'prod-metabase',
      metabaseDatabaseId: 42,
      syncMode: 'ALL',
      selections: [],
      defaultTagNames: [],
      mapping: {
        metabaseDatabaseId: 42,
        metabaseDatabaseName: 'Analytics',
        metabaseEngine: 'postgres',
        targetConnectionId: 'warehouse_a',
      },
    });
    expect(parsed.metabaseConnectionId).toBe('prod-metabase');
    expect(parsed.mapping.targetConnectionId).toBe('warehouse_a');
  });
});
