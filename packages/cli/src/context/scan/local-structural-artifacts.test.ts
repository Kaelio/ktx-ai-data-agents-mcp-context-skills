import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../context/project/project.js';
import { readLocalScanStructuralSnapshot } from './local-structural-artifacts.js';

describe('readLocalScanStructuralSnapshot', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-structural-artifacts-'));
    project = await initKtxProject({
      projectDir: join(tempDir, 'project'),
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rebuilds a canonical snapshot from persisted live-database raw files', async () => {
    const rawRoot = 'raw-sources/warehouse/live-database/sync-1';
    await project.fileStore.writeFile(
      `${rawRoot}/connection.json`,
      `${JSON.stringify(
        {
          connectionId: 'warehouse',
          extractedAt: '2026-04-29T12:00:00.000Z',
          metadata: { source: 'sqlite-smoke' },
          tableCount: 2,
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed connection artifact',
    );
    await project.fileStore.writeFile(
      `${rawRoot}/tables/customers.json`,
      `${JSON.stringify(
        {
          name: 'customers',
          catalog: null,
          db: 'public',
          kind: 'table',
          comment: 'Customer table',
          estimatedRows: 12,
          columns: [
            {
              name: 'id',
              nativeType: 'INTEGER',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: 'Customer id',
            },
          ],
          foreignKeys: [],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed customers artifact',
    );
    await project.fileStore.writeFile(
      `${rawRoot}/tables/orders.json`,
      `${JSON.stringify(
        {
          name: 'orders',
          catalog: null,
          db: 'public',
          kind: 'table',
          comment: null,
          estimatedRows: 20,
          columns: [
            {
              name: 'id',
              nativeType: 'INTEGER',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: null,
            },
            {
              name: 'customer_id',
              nativeType: 'INTEGER',
              normalizedType: 'integer',
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
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed orders artifact',
    );

    const snapshot = await readLocalScanStructuralSnapshot({
      project,
      connectionId: 'warehouse',
      driver: 'sqlite',
      rawSourcesDir: rawRoot,
      extractedAtFallback: '2026-04-29T13:00:00.000Z',
    });

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'sqlite',
      extractedAt: '2026-04-29T12:00:00.000Z',
      metadata: { source: 'sqlite-smoke' },
      tables: [
        {
          db: 'public',
          name: 'customers',
          comment: 'Customer table',
          columns: [
            {
              name: 'id',
              nativeType: 'INTEGER',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: 'Customer id',
            },
          ],
        },
        {
          db: 'public',
          name: 'orders',
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
      ],
    });
  });

  it('rebuilds scan warnings from persisted live-database warning files', async () => {
    const rawRoot = 'raw-sources/warehouse/live-database/sync-warnings';
    await project.fileStore.writeFile(
      `${rawRoot}/connection.json`,
      '{"connectionId":"warehouse","metadata":{}}\n',
      'ktx',
      'ktx@example.com',
      'Seed connection artifact',
    );
    await project.fileStore.writeFile(
      `${rawRoot}/warnings.json`,
      `${JSON.stringify(
        {
          warnings: [
            {
              code: 'constraint_discovery_unauthorized',
              message: 'Skipped foreign-key discovery in public (insufficient grants on system catalogs)',
              recoverable: true,
              metadata: { schema: 'public', kind: 'foreign_key' },
            },
          ],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed warning artifact',
    );
    await project.fileStore.writeFile(
      `${rawRoot}/tables/orders.json`,
      '{"name":"orders","catalog":null,"db":"public","kind":"table","comment":null,"estimatedRows":null,"columns":[{"name":"id","nativeType":"integer","normalizedType":"integer","dimensionType":"number","nullable":false,"primaryKey":false,"comment":null}],"foreignKeys":[]}\n',
      'ktx',
      'ktx@example.com',
      'Seed orders artifact',
    );

    const snapshot = await readLocalScanStructuralSnapshot({
      project,
      connectionId: 'warehouse',
      driver: 'postgres',
      rawSourcesDir: rawRoot,
      extractedAtFallback: '2026-04-29T13:00:00.000Z',
    });

    expect(snapshot.warnings).toEqual([
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped foreign-key discovery in public (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'public', kind: 'foreign_key' },
      },
    ]);
  });

  it('uses the scan report timestamp when connection.json omits extractedAt', async () => {
    const rawRoot = 'raw-sources/warehouse/live-database/sync-2';
    await project.fileStore.writeFile(
      `${rawRoot}/connection.json`,
      '{"connectionId":"warehouse","metadata":{}}\n',
      'ktx',
      'ktx@example.com',
      'Seed connection artifact without extractedAt',
    );
    await project.fileStore.writeFile(
      `${rawRoot}/tables/orders.json`,
      '{"name":"orders","catalog":null,"db":null,"kind":"table","comment":null,"estimatedRows":null,"columns":[{"name":"id","nativeType":"integer","normalizedType":"integer","dimensionType":"number","nullable":false,"primaryKey":true,"comment":null}],"foreignKeys":[]}\n',
      'ktx',
      'ktx@example.com',
      'Seed orders artifact',
    );

    const snapshot = await readLocalScanStructuralSnapshot({
      project,
      connectionId: 'warehouse',
      driver: 'postgres',
      rawSourcesDir: rawRoot,
      extractedAtFallback: '2026-04-29T13:00:00.000Z',
    });

    expect(snapshot.extractedAt).toBe('2026-04-29T13:00:00.000Z');
  });

  it('tolerates older live-database staged directories without warnings.json', async () => {
    const rawRoot = 'raw-sources/warehouse/live-database/sync-no-warnings';
    await project.fileStore.writeFile(
      `${rawRoot}/connection.json`,
      '{"connectionId":"warehouse","metadata":{}}\n',
      'ktx',
      'ktx@example.com',
      'Seed connection artifact',
    );
    await project.fileStore.writeFile(
      `${rawRoot}/tables/orders.json`,
      '{"name":"orders","catalog":null,"db":null,"kind":"table","comment":null,"estimatedRows":null,"columns":[{"name":"id","nativeType":"integer","normalizedType":"integer","dimensionType":"number","nullable":false,"primaryKey":true,"comment":null}],"foreignKeys":[]}\n',
      'ktx',
      'ktx@example.com',
      'Seed orders artifact',
    );

    const snapshot = await readLocalScanStructuralSnapshot({
      project,
      connectionId: 'warehouse',
      driver: 'postgres',
      rawSourcesDir: rawRoot,
      extractedAtFallback: '2026-04-29T13:00:00.000Z',
    });

    expect(snapshot.warnings).toEqual([]);
  });
});
