import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KtxSchemaSnapshot } from '../../../../../src/context/scan/types.js';
import { chunkLiveDatabaseStagedDir } from '../../../../../src/context/ingest/adapters/live-database/chunk.js';
import { liveDatabaseTablePath, writeLiveDatabaseSnapshot } from '../../../../../src/context/ingest/adapters/live-database/stage.js';

function snapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'conn-1',
    driver: 'postgres',
    extractedAt: '2026-04-27T00:00:00.000Z',
    scope: { schemas: ['public'] },
    metadata: {},
    tables: [
      {
        name: 'orders',
        catalog: null,
        db: 'public',
        kind: 'table',
        comment: null,
        estimatedRows: null,
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: null,
          },
        ],
        foreignKeys: [],
      },
      {
        name: 'customers',
        catalog: null,
        db: 'public',
        kind: 'table',
        comment: null,
        estimatedRows: null,
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: null,
          },
        ],
        foreignKeys: [],
      },
    ],
  };
}

describe('chunkLiveDatabaseStagedDir', () => {
  it('emits one work unit per table on the first run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-live-db-chunk-'));
    await writeLiveDatabaseSnapshot(dir, snapshot());

    const result = await chunkLiveDatabaseStagedDir(dir);
    expect(result.workUnits.map((wu) => wu.unitKey)).toEqual([
      'live-database-public-customers',
      'live-database-public-orders',
    ]);
    expect(result.workUnits[0]?.dependencyPaths).toEqual(['connection.json', 'foreign-keys.json']);
    expect(result.workUnits[0]?.peerFileIndex).toContain(
      liveDatabaseTablePath({ catalog: null, db: 'public', name: 'orders' }),
    );
  });

  it('keeps only changed tables during incremental syncs and records table evictions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-live-db-diff-'));
    await writeLiveDatabaseSnapshot(dir, snapshot());
    const ordersPath = liveDatabaseTablePath({ catalog: null, db: 'public', name: 'orders' });
    const customersPath = liveDatabaseTablePath({ catalog: null, db: 'public', name: 'customers' });

    const result = await chunkLiveDatabaseStagedDir(dir, {
      added: [],
      modified: [ordersPath],
      deleted: [customersPath],
      unchanged: ['connection.json', 'foreign-keys.json'],
    });

    expect(result.workUnits.map((wu) => wu.unitKey)).toEqual(['live-database-public-orders']);
    expect(result.eviction?.deletedRawPaths).toEqual([customersPath]);
  });

  it('fans out all table work units when the foreign-key index changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-live-db-fk-'));
    await writeLiveDatabaseSnapshot(dir, snapshot());

    const result = await chunkLiveDatabaseStagedDir(dir, {
      added: [],
      modified: ['foreign-keys.json'],
      deleted: [],
      unchanged: [],
    });

    expect(result.workUnits).toHaveLength(2);
  });
});
