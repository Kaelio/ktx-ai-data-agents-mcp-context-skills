import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalLookerRuntimeStore } from './local-runtime-store.js';

describe('LocalLookerRuntimeStore', () => {
  async function store() {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-looker-store-'));
    return new LocalLookerRuntimeStore({
      dbPath: join(dir, 'db.sqlite'),
      now: () => new Date('2026-05-05T12:00:00.000Z'),
    });
  }

  it('stores cursors and connection mappings', async () => {
    const local = await store();

    await local.setCursors('prod-looker', {
      dashboardsLastSyncedAt: '2026-05-01T00:00:00.000Z',
      looksLastSyncedAt: null,
    });
    await local.upsertConnectionMapping({
      lookerConnectionId: 'prod-looker',
      lookerConnectionName: 'bq_reporting',
      ktxConnectionId: 'prod-warehouse',
      source: 'cli',
    });

    await expect(local.readCursors('prod-looker')).resolves.toEqual({
      dashboardsLastSyncedAt: '2026-05-01T00:00:00.000Z',
      looksLastSyncedAt: null,
    });
    await expect(local.readMappings('prod-looker')).resolves.toEqual([
      {
        lookerConnectionName: 'bq_reporting',
        ktxConnectionId: 'prod-warehouse',
        lookerHost: null,
        lookerDatabase: null,
        lookerDialect: null,
      },
    ]);
  });

  it('refreshes discovered metadata without dropping local targets', async () => {
    const local = await store();
    await local.upsertConnectionMapping({
      lookerConnectionId: 'prod-looker',
      lookerConnectionName: 'bq_reporting',
      ktxConnectionId: 'prod-warehouse',
      source: 'cli',
    });

    await local.refreshDiscoveredConnections({
      lookerConnectionId: 'prod-looker',
      discovered: [
        {
          name: 'bq_reporting',
          host: 'bigquery.googleapis.com',
          database: 'analytics',
          schema: null,
          dialect: 'bigquery_standard_sql',
        },
      ],
    });

    await expect(local.listConnectionMappings('prod-looker')).resolves.toEqual([
      {
        lookerConnectionName: 'bq_reporting',
        ktxConnectionId: 'prod-warehouse',
        lookerHost: 'bigquery.googleapis.com',
        lookerDatabase: 'analytics',
        lookerDialect: 'bigquery_standard_sql',
        source: 'refresh',
      },
    ]);
  });

  it('applies yaml mapping intent while preserving refresh metadata and cli overrides', async () => {
    const local = await store();
    await local.refreshDiscoveredConnections({
      lookerConnectionId: 'prod-looker',
      discovered: [{ name: 'analytics', host: 'looker-db.test', database: 'warehouse', schema: null, dialect: 'postgres' }],
    });
    await local.upsertConnectionMapping({
      lookerConnectionId: 'prod-looker',
      lookerConnectionName: 'manual',
      ktxConnectionId: 'cli-warehouse',
      source: 'cli',
    });

    await local.applyYamlBootstrap({
      lookerConnectionId: 'prod-looker',
      mappings: [
        { lookerConnectionName: 'analytics', ktxConnectionId: 'yaml-warehouse' },
        { lookerConnectionName: 'manual', ktxConnectionId: 'yaml-warehouse' },
      ],
    });

    await expect(local.listConnectionMappings('prod-looker')).resolves.toMatchObject([
      {
        lookerConnectionName: 'analytics',
        ktxConnectionId: 'yaml-warehouse',
        lookerHost: 'looker-db.test',
        lookerDatabase: 'warehouse',
        lookerDialect: 'postgres',
        source: 'ktx.yaml',
      },
      {
        lookerConnectionName: 'manual',
        ktxConnectionId: 'cli-warehouse',
        source: 'cli',
      },
    ]);
  });
});
