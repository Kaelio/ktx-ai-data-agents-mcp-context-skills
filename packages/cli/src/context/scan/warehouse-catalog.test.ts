import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import { WarehouseCatalogService } from './warehouse-catalog.js';

describe('WarehouseCatalogService', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-warehouse-catalog-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedLiveDatabaseScan(connectionId = 'warehouse', syncId = 'sync-2', driver = 'postgres') {
    const root = `raw-sources/${connectionId}/live-database/${syncId}`;
    const tableRef = {
      catalog: driver === 'bigquery' ? 'analytics' : null,
      db: driver === 'sqlite' ? null : 'public',
      name: 'orders',
    };
    await project.fileStore.writeFile(
      `${root}/connection.json`,
      JSON.stringify({ connectionId, driver, extractedAt: '2026-05-12T00:00:00.000Z' }, null, 2),
      'ktx',
      'ktx@example.com',
      'seed connection',
    );
    await project.fileStore.writeFile(
      `${root}/tables/orders.json`,
      JSON.stringify(
        {
          catalog: tableRef.catalog,
          db: tableRef.db,
          name: tableRef.name,
          kind: 'table',
          comment: 'Customer orders',
          estimatedRows: 12,
          columns: [
            {
              name: 'id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: 'Order id',
            },
            {
              name: 'status',
              nativeType: 'text',
              normalizedType: 'text',
              dimensionType: 'string',
              nullable: false,
              primaryKey: false,
              comment: 'Order status',
            },
          ],
          foreignKeys: [],
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed orders',
    );
    await project.fileStore.writeFile(
      `${root}/enrichment/relationship-profile.json`,
      JSON.stringify(
        {
          connectionId,
          driver,
          sqlAvailable: true,
          queryCount: 3,
          tables: [{ table: { catalog: tableRef.catalog, db: tableRef.db, name: tableRef.name }, rowCount: 12 }],
          columns: {
            'orders.status': {
              table: { catalog: tableRef.catalog, db: tableRef.db, name: tableRef.name },
              column: 'status',
              nativeType: 'text',
              normalizedType: 'text',
              rowCount: 12,
              nullCount: 0,
              distinctCount: 2,
              uniquenessRatio: 0.1667,
              nullRate: 0,
              sampleValues: ['paid', 'refunded'],
              minTextLength: 4,
              maxTextLength: 8,
            },
          },
          warnings: [],
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed profile',
    );
  }

  it('finds the latest sync and merges table schema with relationship profile values', async () => {
    await seedLiveDatabaseScan('warehouse', 'sync-1');
    await seedLiveDatabaseScan('warehouse', 'sync-2');
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.getLatestSyncId('warehouse')).resolves.toBe('sync-2');
    const detail = await catalog.getTable({ connectionId: 'warehouse', catalog: null, db: 'public', name: 'orders' });

    expect(detail).toMatchObject({
      connectionId: 'warehouse',
      display: 'public.orders',
      rowCount: 12,
      columns: [
        { name: 'id', nativeType: 'integer', primaryKey: true },
        { name: 'status', nativeType: 'text', sampleValues: ['paid', 'refunded'], distinctCount: 2 },
      ],
    });
    expect(detail).not.toHaveProperty(['connection', 'Name'].join(''));

    const hits = await catalog.searchByName('warehouse', 'orders', 5);
    expect(hits[0]).toMatchObject({
      kind: 'table',
      connectionId: 'warehouse',
      display: 'public.orders',
    });
    expect(hits[0]).not.toHaveProperty(['connection', 'Name'].join(''));
  });

  it('returns scanAvailable=false when no live-database scan exists', async () => {
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });
    await expect(catalog.getTable({ connectionId: 'missing', catalog: null, db: 'public', name: 'orders' })).resolves.toBeNull();
    await expect(catalog.hasScan('missing')).resolves.toBe(false);
  });

  it('resolves postgres display strings and returns closest candidates for missing tables', async () => {
    await seedLiveDatabaseScan();
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.resolveDisplay('warehouse', 'public.orders')).resolves.toMatchObject({
      resolved: { catalog: null, db: 'public', name: 'orders' },
      candidates: [],
      dialect: 'postgres',
    });
    await expect(catalog.resolveDisplay('warehouse', 'public.orderz')).resolves.toMatchObject({
      resolved: null,
      candidates: [{ name: 'orders' }],
    });
  });

  it('treats two-part BigQuery identifiers as ambiguous instead of guessing', async () => {
    await seedLiveDatabaseScan('warehouse', 'sync-bigquery', 'bigquery');
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.resolveDisplay('warehouse', 'public.orders')).resolves.toMatchObject({
      resolved: null,
      dialect: 'bigquery',
    });
  });

  it('resolves postgres column display strings without treating the column as a table', async () => {
    await seedLiveDatabaseScan();
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.resolveDisplayTarget('warehouse', 'public.orders.status')).resolves.toMatchObject({
      resolved: { catalog: null, db: 'public', name: 'orders', column: 'status' },
      candidates: [],
      dialect: 'postgres',
    });
  });

  it('resolves BigQuery column display strings with four parts', async () => {
    await seedLiveDatabaseScan('warehouse', 'sync-bigquery', 'bigquery');
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.resolveDisplayTarget('warehouse', 'analytics.public.orders.status')).resolves.toMatchObject({
      resolved: { catalog: 'analytics', db: 'public', name: 'orders', column: 'status' },
      candidates: [],
      dialect: 'bigquery',
    });
  });

  it('searches table names, column names, comments, and descriptions', async () => {
    await seedLiveDatabaseScan();
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.searchByName('warehouse', 'status', 10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'column',
          ref: expect.objectContaining({ db: 'public', name: 'orders', column: 'status' }),
          matchedOn: 'name',
        }),
      ]),
    );
  });
});
