import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectLiveDatabaseStagedDir,
  LIVE_DATABASE_FOREIGN_KEYS_FILE,
  LIVE_DATABASE_META_FILE,
  liveDatabaseTablePath,
  readLiveDatabaseTableFiles,
  writeLiveDatabaseSnapshot,
} from './stage.js';
import type { KtxSchemaSnapshot } from '../../../scan/types.js';

function snapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'conn-1',
    driver: 'postgres',
    extractedAt: '2026-04-27T00:00:00.000Z',
    scope: { schemas: ['public'] },
    metadata: { dialect: 'postgres' },
    tables: [
      {
        name: 'orders',
        catalog: null,
        db: 'public',
        kind: 'table',
        comment: 'Orders placed by customers',
        estimatedRows: 200,
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
          {
            name: 'customer_id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
          {
            name: 'total',
            nativeType: 'numeric',
            normalizedType: 'numeric',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
        foreignKeys: [
          {
            fromColumn: 'customer_id',
            toCatalog: null,
            toDb: 'public',
            toTable: 'customers',
            toColumn: 'id',
            constraintName: null,
          },
        ],
      },
      {
        name: 'customers',
        catalog: null,
        db: 'public',
        kind: 'table',
        comment: null,
        estimatedRows: 50,
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

describe('live-database staged snapshot files', () => {
  it('writes deterministic metadata, table, and foreign-key files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-live-db-stage-'));
    await writeLiveDatabaseSnapshot(dir, snapshot());

    await expect(readFile(join(dir, LIVE_DATABASE_META_FILE), 'utf8')).resolves.toContain('"connectionId": "conn-1"');
    await expect(readFile(join(dir, LIVE_DATABASE_FOREIGN_KEYS_FILE), 'utf8')).resolves.toContain(
      '"fromTable": "orders"',
    );
    const connectionJson = await readFile(join(dir, LIVE_DATABASE_META_FILE), 'utf8');
    expect(connectionJson).toContain('"driver": "postgres"');
    expect(connectionJson).toContain('"schemas"');

    const ordersPath = liveDatabaseTablePath({ catalog: null, db: 'public', name: 'orders' });
    const customersPath = liveDatabaseTablePath({ catalog: null, db: 'public', name: 'customers' });
    expect(ordersPath).toMatch(/^tables\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.json$/);
    await expect(readFile(join(dir, ordersPath), 'utf8')).resolves.toContain('"name": "orders"');
    await expect(readFile(join(dir, customersPath), 'utf8')).resolves.toContain('"name": "customers"');
    const ordersJson = await readFile(join(dir, ordersPath), 'utf8');
    expect(ordersJson).toContain('"kind": "table"');
    expect(ordersJson).toContain('"estimatedRows": 200');
    expect(ordersJson).toContain('"nativeType": "integer"');
    expect(ordersJson).toContain('"normalizedType": "integer"');
    expect(ordersJson).not.toContain('"type": "integer"');

    const tableFiles = await readLiveDatabaseTableFiles(dir);
    expect(tableFiles.map((file) => file.table.name)).toEqual(['customers', 'orders']);
    expect(await detectLiveDatabaseStagedDir(dir)).toBe(true);
  });

  it('redacts sensitive snapshot metadata before writing connection metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-live-db-redacted-stage-'));
    await writeLiveDatabaseSnapshot(dir, {
      ...snapshot(),
      metadata: {
        dialect: 'postgres',
        url: 'postgres://reader:secret@example.test/db', // pragma: allowlist secret
        serviceAccountJson: {
          client_email: 'reader@example.test',
          private_key: 'pem-value', // pragma: allowlist secret
        },
      },
    });

    const connectionJson = await readFile(join(dir, LIVE_DATABASE_META_FILE), 'utf8');

    expect(connectionJson).toContain('"dialect": "postgres"');
    expect(connectionJson).toContain('"client_email": "reader@example.test"');
    expect(connectionJson).toContain('"url": "<redacted>"');
    expect(connectionJson).toContain('"private_key": "<redacted>"');
    expect(connectionJson).not.toContain('postgres://reader:secret@example.test/db'); // pragma: allowlist secret
    expect(connectionJson).not.toContain('pem-value');
  });

  it('returns false for a directory that is missing live database metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-live-db-empty-'));
    expect(await detectLiveDatabaseStagedDir(dir)).toBe(false);
  });
});
