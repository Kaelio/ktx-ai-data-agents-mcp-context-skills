import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../context/project/project.js';
import { createKtxEntityDetailsService } from './entity-details.js';
import type { KtxConnectionDriver, KtxScanReport, KtxSchemaTable } from './types.js';

describe('createKtxEntityDetailsService', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-entity-details-service-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function scanReport(input: {
    connectionId: string;
    syncId: string;
    runId: string;
    driver?: KtxConnectionDriver;
    createdAt?: string;
  }): KtxScanReport {
    const rawSourcesDir = `raw-sources/${input.connectionId}/live-database/${input.syncId}`;
    return {
      connectionId: input.connectionId,
      driver: input.driver ?? 'postgres',
      syncId: input.syncId,
      runId: input.runId,
      trigger: 'mcp',
      mode: 'structural',
      dryRun: false,
      artifactPaths: {
        rawSourcesDir,
        reportPath: `${rawSourcesDir}/scan-report.json`,
        manifestShards: [],
        enrichmentArtifacts: [],
      },
      diffSummary: {
        tablesAdded: 0,
        tablesModified: 0,
        tablesDeleted: 0,
        tablesUnchanged: 1,
        columnsAdded: 0,
        columnsModified: 0,
        columnsDeleted: 0,
      },
      manifestShardsWritten: 0,
      structuralSyncStats: {
        tablesCreated: 1,
        tablesUpdated: 0,
        tablesDeleted: 0,
        columnsCreated: 0,
        columnsUpdated: 0,
        columnsDeleted: 0,
      },
      enrichment: {
        dataDictionary: 'skipped',
        tableDescriptions: 'skipped',
        columnDescriptions: 'skipped',
        embeddings: 'skipped',
        deterministicRelationships: 'skipped',
        llmRelationshipValidation: 'skipped',
        statisticalValidation: 'skipped',
      },
      capabilityGaps: [],
      warnings: [],
      relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
      enrichmentState: { resumedStages: [], completedStages: [], failedStages: [] },
      createdAt: input.createdAt ?? '2026-05-14T09:00:00.000Z',
    };
  }

  function ordersTable(input: { db?: string | null; estimatedRows?: number | null } = {}): KtxSchemaTable {
    return {
      catalog: null,
      db: input.db ?? 'public',
      name: 'orders',
      kind: 'table',
      comment: 'Customer orders',
      estimatedRows: input.estimatedRows ?? 12,
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
      foreignKeys: [
        {
          fromColumn: 'customer_id',
          toCatalog: null,
          toDb: 'public',
          toTable: 'customers',
          toColumn: 'id',
          constraintName: 'orders_customer_id_fkey',
        },
      ],
    };
  }

  async function seedScan(input: {
    connectionId?: string;
    syncId: string;
    runId: string;
    driver?: KtxConnectionDriver;
    extractedAt?: string;
    tables?: KtxSchemaTable[];
  }): Promise<void> {
    const connectionId = input.connectionId ?? 'warehouse';
    const report = scanReport({
      connectionId,
      syncId: input.syncId,
      runId: input.runId,
      driver: input.driver,
      createdAt: input.extractedAt,
    });
    const root = report.artifactPaths.rawSourcesDir;
    await project.fileStore.writeFile(
      `${root}/connection.json`,
      JSON.stringify(
        {
          connectionId,
          driver: report.driver,
          extractedAt: input.extractedAt ?? report.createdAt,
          scope: { schemas: ['public'] },
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed connection',
    );
    for (const table of input.tables ?? [ordersTable()]) {
      await project.fileStore.writeFile(
        `${root}/tables/${table.db ?? 'default'}-${table.name}.json`,
        JSON.stringify(table, null, 2),
        'ktx',
        'ktx@example.com',
        `seed ${table.name}`,
      );
    }
    await project.fileStore.writeFile(
      `${root}/scan-report.json`,
      JSON.stringify(report, null, 2),
      'ktx',
      'ktx@example.com',
      'seed scan report',
    );
  }

  it('returns the latest scan snapshot table details for a display string', async () => {
    await seedScan({ syncId: 'sync-1', runId: 'scan-old', extractedAt: '2026-05-14T08:00:00.000Z' });
    await seedScan({
      syncId: 'sync-2',
      runId: 'scan-new',
      extractedAt: '2026-05-14T09:00:00.000Z',
      tables: [ordersTable({ estimatedRows: 99 })],
    });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders' }],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      ok: true,
      connectionId: 'warehouse',
      display: 'public.orders',
      estimatedRows: 99,
      snapshot: {
        syncId: 'sync-2',
        scanRunId: 'scan-new',
        extractedAt: '2026-05-14T09:00:00.000Z',
      },
      columns: [
        { name: 'id', nativeType: 'integer', primaryKey: true },
        { name: 'status', nativeType: 'text', nullable: false },
      ],
    });
  });

  it('resolves quoted qualified display strings through the dialect parser', async () => {
    await seedScan({ syncId: 'sync-1', runId: 'scan-1' });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: '"public"."orders"' }],
    });

    expect(result.results[0]).toMatchObject({
      ok: true,
      display: 'public.orders',
      tableRef: { catalog: null, db: 'public', name: 'orders' },
    });
  });

  it('filters requested columns while keeping full-table foreign keys', async () => {
    await seedScan({ syncId: 'sync-1', runId: 'scan-1' });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: { catalog: null, db: 'public', name: 'orders' }, columns: ['status'] }],
    });

    expect(result.results[0]).toMatchObject({
      ok: true,
      columns: [{ name: 'status' }],
      foreignKeys: [
        {
          fromColumn: 'customer_id',
          toDb: 'public',
          toTable: 'customers',
          toColumn: 'id',
        },
      ],
    });
  });

  it('returns a structured missing-scan error', async () => {
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders' }],
    });

    expect(result.results).toEqual([
      {
        ok: false,
        connectionId: 'warehouse',
        table: 'public.orders',
        error: {
          code: 'scan_missing',
          message: 'No live-database scan found for connection "warehouse"; run `ktx ingest warehouse` or `ktx scan warehouse`.',
        },
      },
    ]);
  });

  it('reports ambiguous bare table names across schemas', async () => {
    await seedScan({
      syncId: 'sync-1',
      runId: 'scan-1',
      tables: [ordersTable({ db: 'public' }), ordersTable({ db: 'archive' })],
    });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: 'orders' }],
    });

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: {
        code: 'ambiguous_table',
        candidates: [
          { tableRef: { catalog: null, db: 'archive', name: 'orders' }, display: 'archive.orders' },
          { tableRef: { catalog: null, db: 'public', name: 'orders' }, display: 'public.orders' },
        ],
      },
    });
  });

  it('reports missing requested columns with available column candidates', async () => {
    await seedScan({ syncId: 'sync-1', runId: 'scan-1' });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders', columns: ['status', 'plan_tier'] }],
    });

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: {
        code: 'column_not_found',
        message: 'Column(s) not found on public.orders: plan_tier',
        candidates: ['id', 'status'],
      },
    });
  });
});
