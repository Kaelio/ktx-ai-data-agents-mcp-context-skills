import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig } from '../../../project/index.js';
import { KtxYamlMetabaseSourceStateReader, LocalMetabaseDiscoveryCache } from './local-source-state-store.js';

describe('Metabase YAML source state and discovery cache', () => {
  let tempDir: string;
  let discoveryCache: LocalMetabaseDiscoveryCache;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-metabase-cache-'));
    discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: join(tempDir, '.ktx', 'db.sqlite') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function projectWithMetabaseMappings(mappings: Record<string, unknown>) {
    return {
      config: {
        ...buildDefaultKtxProjectConfig(),
        connections: {
          'prod-metabase': {
            driver: 'metabase',
            mappings,
          },
        },
      },
    };
  }

  it('reads Metabase mapping intent from ktx.yaml config', async () => {
    const reader = new KtxYamlMetabaseSourceStateReader(
      projectWithMetabaseMappings({
        databaseMappings: { '2': 'warehouse' },
        syncEnabled: { '2': true },
        syncMode: 'ONLY',
        selections: { collections: [12], items: [99] },
        defaultTagNames: ['analytics'],
      }),
      { discoveryCache },
    );

    await expect(reader.getSourceState('prod-metabase')).resolves.toEqual({
      syncMode: 'ONLY',
      defaultTagNames: ['analytics'],
      selections: [
        { selectionType: 'collection', metabaseObjectId: 12 },
        { selectionType: 'item', metabaseObjectId: 99 },
      ],
      mappings: [
        {
          metabaseDatabaseId: 2,
          metabaseDatabaseName: null,
          metabaseEngine: null,
          metabaseHost: null,
          metabaseDbName: null,
          targetConnectionId: 'warehouse',
          syncEnabled: true,
        },
      ],
    });
  });

  it('enriches YAML mapping rows with recreatable discovery metadata', async () => {
    await discoveryCache.refreshDiscoveredDatabases({
      connectionId: 'prod-metabase',
      discovered: [{ id: 2, name: 'Analytics', engine: 'postgres', host: 'pg.internal', dbName: 'analytics' }],
    });
    const reader = new KtxYamlMetabaseSourceStateReader(
      projectWithMetabaseMappings({
        databaseMappings: { '2': 'warehouse' },
        syncEnabled: { '2': true },
      }),
      { discoveryCache },
    );

    await expect(reader.listDatabaseMappings('prod-metabase')).resolves.toMatchObject([
      {
        metabaseDatabaseId: 2,
        metabaseDatabaseName: 'Analytics',
        metabaseEngine: 'postgres',
        metabaseHost: 'pg.internal',
        metabaseDbName: 'analytics',
        targetConnectionId: 'warehouse',
        syncEnabled: true,
        source: 'ktx.yaml',
      },
    ]);
  });

  it('lists discovered-only rows as refresh cache data without turning them into config state', async () => {
    await discoveryCache.refreshDiscoveredDatabases({
      connectionId: 'prod-metabase',
      discovered: [{ id: 7, name: 'Unmapped', engine: 'mysql', host: 'mysql.internal', dbName: 'sales' }],
    });
    const reader = new KtxYamlMetabaseSourceStateReader(projectWithMetabaseMappings({}), { discoveryCache });

    await expect(reader.getSourceState('prod-metabase')).resolves.toMatchObject({ mappings: [] });
    await expect(reader.listDatabaseMappings('prod-metabase')).resolves.toMatchObject([
      {
        metabaseDatabaseId: 7,
        metabaseDatabaseName: 'Unmapped',
        targetConnectionId: null,
        syncEnabled: false,
        source: 'refresh',
      },
    ]);
  });
});
