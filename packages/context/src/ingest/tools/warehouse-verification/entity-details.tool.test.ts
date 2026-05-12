import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../../project/index.js';
import type { ToolContext } from '../../../tools/index.js';
import { EntityDetailsTool } from './entity-details.tool.js';
import { WarehouseCatalogService } from './warehouse-catalog.service.js';

describe('EntityDetailsTool', () => {
  let tempDir: string;
  let project: KtxLocalProject;
  let tool: EntityDetailsTool;
  let context: ToolContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-entity-details-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
    await seedLiveDatabaseScan();
    tool = new EntityDetailsTool(() => new WarehouseCatalogService({ fileStore: project.fileStore }));
    context = {
      sourceId: 'ingest',
      messageId: 'm1',
      userId: 'system',
      session: {
        allowedConnectionNames: new Set(['warehouse']),
      } as any,
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedLiveDatabaseScan(connectionName = 'warehouse', syncId = 'sync-1') {
    const root = `raw-sources/${connectionName}/live-database/${syncId}`;
    await project.fileStore.writeFile(
      `${root}/connection.json`,
      JSON.stringify({ connectionId: connectionName, driver: 'postgres', extractedAt: '2026-05-12T00:00:00.000Z' }, null, 2),
      'ktx',
      'ktx@example.com',
      'seed connection',
    );
    await project.fileStore.writeFile(
      `${root}/tables/orders.json`,
      JSON.stringify(
        {
          catalog: null,
          db: 'public',
          name: 'orders',
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
          connectionId: connectionName,
          driver: 'postgres',
          tables: [{ table: { catalog: null, db: 'public', name: 'orders' }, rowCount: 12 }],
          columns: {
            'orders.status': {
              table: { catalog: null, db: 'public', name: 'orders' },
              column: 'status',
              rowCount: 12,
              nullCount: 0,
              distinctCount: 2,
              nullRate: 0,
              sampleValues: ['paid', 'refunded'],
            },
          },
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed profile',
    );
  }

  it('returns scoped table detail for a display target', async () => {
    const result = await tool.call({ connectionName: 'warehouse', targets: [{ display: 'public.orders' }] }, context);

    expect(result.markdown).toContain('### public.orders');
    expect(result.markdown).toContain('- status (text, nullable=false)');
    expect(result.markdown).toContain('sample: ["paid","refunded"]');
    expect(result.structured.scanAvailable).toBe(true);
    expect(result.structured.resolved).toHaveLength(1);
  });

  it('resolves display targets that include a column name', async () => {
    const result = await tool.call(
      { connectionName: 'warehouse', targets: [{ display: 'public.orders.status' }] },
      context,
    );

    expect(result.markdown).toContain('### public.orders');
    expect(result.markdown).toContain('- status (text, nullable=false)');
    expect(result.markdown).not.toContain('- id (integer');
    expect(result.structured.resolved).toHaveLength(1);
    expect(result.structured.resolved[0]?.columns.map((column) => column.name)).toEqual(['status']);
  });

  it('reports missing explicit columns instead of returning an empty column list', async () => {
    const result = await tool.call(
      { connectionName: 'warehouse', targets: [{ display: 'public.orders.plan_tier' }] },
      context,
    );

    expect(result.markdown).toContain('Column not found in scan: public.orders.plan_tier');
    expect(result.markdown).toContain('Available columns: id, status');
    expect(result.structured.resolved).toHaveLength(0);
    expect(result.structured.missing).toHaveLength(1);
  });

  it('returns a no-scan state distinct from not found', async () => {
    const result = await tool.call(
      { connectionName: 'empty', targets: [{ display: 'public.orders' }] },
      { ...context, session: { ...context.session!, allowedConnectionNames: new Set(['empty']) } },
    );

    expect(result.markdown).toContain('No live-database scan available for connection "empty"; run `ktx scan` first.');
    expect(result.structured.scanAvailable).toBe(false);
  });

  it('refuses out-of-scope connections', async () => {
    const result = await tool.call({ connectionName: 'billing', targets: [{ display: 'public.orders' }] }, context);

    expect(result.markdown).toContain('Connection "billing" is not available to this ingest stage.');
    expect(result.structured.scanAvailable).toBe(false);
  });
});
