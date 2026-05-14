import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import { writeLocalKnowledgePage } from '../wiki/local-knowledge.js';
import { createKtxDiscoverDataService } from './discover.js';

describe('createKtxDiscoverDataService', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-discover-data-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
    project.config.connections.warehouse = { driver: 'postgres', url: 'env:DATABASE_URL' };
    project.config.connections.billing = { driver: 'postgres', url: 'env:BILLING_DATABASE_URL' };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedWiki(): Promise<void> {
    await writeLocalKnowledgePage(project, {
      key: 'orders-playbook',
      scope: 'GLOBAL',
      summary: 'Paid order operations',
      content: 'Use paid orders and order_count to inspect monthly customer activity for Acme Corp.',
      tags: ['orders'],
    });
  }

  async function seedSl(): Promise<void> {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      [
        'name: orders',
        'descriptions:',
        '  user: Paid order facts',
        'table: public.orders',
        'grain: [id]',
        'columns:',
        '  - name: status',
        '    type: string',
        '    descriptions:',
        '      user: Payment status for the order',
        '  - name: ordered_at',
        '    type: time',
        'measures:',
        '  - name: order_count',
        '    expr: count(*)',
        '    description: Number of paid orders',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'seed sl source',
    );
  }

  async function seedScan(input: {
    connectionId?: string;
    syncId: string;
    tableName?: string;
    comment?: string;
    sampleValues?: string[];
  }): Promise<void> {
    const connectionId = input.connectionId ?? 'warehouse';
    const root = `raw-sources/${connectionId}/live-database/${input.syncId}`;
    const tableName = input.tableName ?? 'orders';
    await project.fileStore.writeFile(
      `${root}/connection.json`,
      JSON.stringify(
        {
          connectionId,
          driver: 'postgres',
          extractedAt: `2026-05-14T09:00:00.000Z`,
          scope: { schemas: ['public'] },
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed scan connection',
    );
    await project.fileStore.writeFile(
      `${root}/tables/public-${tableName}.json`,
      JSON.stringify(
        {
          catalog: null,
          db: 'public',
          name: tableName,
          kind: 'table',
          comment: input.comment ?? 'Orders table from warehouse',
          estimatedRows: 123,
          descriptions: { db: input.comment ?? 'Orders table from warehouse' },
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
              sampleValues: input.sampleValues ?? ['paid', 'pending'],
            },
          ],
          foreignKeys: [],
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed table',
    );
    await project.fileStore.writeFile(
      `${root}/scan-report.json`,
      JSON.stringify(
        {
          connectionId,
          driver: 'postgres',
          syncId: input.syncId,
          runId: `scan-${input.syncId}`,
          trigger: 'mcp',
          mode: 'enriched',
          dryRun: false,
          artifactPaths: {
            rawSourcesDir: root,
            reportPath: `${root}/scan-report.json`,
            manifestShards: [],
            enrichmentArtifacts: [],
          },
          diffSummary: {
            tablesAdded: 1,
            tablesModified: 0,
            tablesDeleted: 0,
            tablesUnchanged: 0,
            columnsAdded: 0,
            columnsModified: 0,
            columnsDeleted: 0,
          },
          manifestShardsWritten: 0,
          structuralSyncStats: {
            tablesCreated: 0,
            tablesUpdated: 0,
            tablesDeleted: 0,
            columnsCreated: 0,
            columnsUpdated: 0,
            columnsDeleted: 0,
          },
          enrichment: {
            dataDictionary: 'completed',
            tableDescriptions: 'completed',
            columnDescriptions: 'completed',
            embeddings: 'skipped',
            deterministicRelationships: 'skipped',
            llmRelationshipValidation: 'skipped',
            statisticalValidation: 'skipped',
          },
          capabilityGaps: [],
          warnings: [],
          relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
          enrichmentState: { resumedStages: [], completedStages: [], failedStages: [] },
          createdAt: '2026-05-14T09:00:00.000Z',
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed scan report',
    );
  }

  it('returns unified ranked refs across wiki, semantic-layer, and raw schema', async () => {
    await seedWiki();
    await seedSl();
    await seedScan({ syncId: 'sync-1', sampleValues: ['paid', 'refunded'] });
    const service = createKtxDiscoverDataService(project, { userId: 'local-user' });

    const results = await service.search({ query: 'paid orders', connectionId: 'warehouse', limit: 10 });

    expect(results.map((result) => result.kind)).toEqual(
      expect.arrayContaining(['wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column']),
    );
    expect(results.every((result) => result.score >= 0 && result.score <= 1)).toBe(true);
    expect(results.every((result) => result.snippet === null || result.snippet.length <= 200)).toBe(true);
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: 'table',
        id: 'public.orders',
        connectionId: 'warehouse',
        tableRef: { catalog: null, db: 'public', name: 'orders' },
        matchedOn: expect.stringMatching(/name|description|comment|display/),
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: 'column',
        id: 'public.orders.status',
        connectionId: 'warehouse',
        columnName: 'status',
        matchedOn: expect.stringMatching(/name|comment|description|sample_value/),
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: 'sl_measure',
        id: 'orders.order_count',
        connectionId: 'warehouse',
        summary: 'Number of paid orders',
        snippet: 'count(*)',
        matchedOn: expect.stringMatching(/name|description|expr/),
      }),
    );
  });

  it('honors kind filters and connection scope', async () => {
    await seedWiki();
    await seedSl();
    await seedScan({ syncId: 'sync-1', connectionId: 'warehouse', tableName: 'orders' });
    await seedScan({ syncId: 'sync-2', connectionId: 'billing', tableName: 'invoices', comment: 'Billing invoices' });
    const service = createKtxDiscoverDataService(project);

    const results = await service.search({
      query: 'orders',
      connectionId: 'warehouse',
      kinds: ['table', 'column'],
      limit: 10,
    });

    expect(results.every((result) => result.kind === 'table' || result.kind === 'column')).toBe(true);
    expect(results.every((result) => result.connectionId === 'warehouse')).toBe(true);
    expect(results.some((result) => result.id.includes('invoices'))).toBe(false);
    expect(results.some((result) => result.kind === 'wiki')).toBe(false);
  });

  it('re-reads the latest scan artifacts on each call', async () => {
    await seedScan({ syncId: 'sync-1', tableName: 'orders', comment: 'Old orders table' });
    const service = createKtxDiscoverDataService(project);
    await expect(
      service.search({ query: 'orders', connectionId: 'warehouse', kinds: ['table'], limit: 10 }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'public.orders' })]));

    await seedScan({ syncId: 'sync-2', tableName: 'invoices', comment: 'Invoice facts' });
    const fresh = await service.search({ query: 'invoice', connectionId: 'warehouse', kinds: ['table'], limit: 10 });

    expect(fresh).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'public.invoices' })]));
    expect(fresh.some((result) => result.id === 'public.orders')).toBe(false);
  });
});
