import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KtxSemanticLayerComputePort } from '../daemon/index.js';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import { compileLocalSlQuery } from './local-query.js';

describe('compileLocalSlQuery', () => {
  let tempDir: string;
  let project: KtxLocalProject;
  let compute: KtxSemanticLayerComputePort;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-query-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
    project.config.connections.warehouse = { driver: 'postgres' };
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain:
  - id
columns:
  - name: id
    type: number
  - name: status
    type: string
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders_overlay.yaml',
      `name: orders_overlay
inherits_columns_from: orders
columns:
  - name: paid_at
    type: timestamp
joins: []
measures: []
grain: []
`,
      'ktx',
      'ktx@example.com',
      'Add overlay source',
    );

    compute = {
      query: vi.fn(async (input) => ({
        sql: 'select status, count(*) as order_count from public.orders group by status',
        dialect: input.dialect,
        columns: [{ name: 'orders.status' }, { name: 'orders.order_count' }],
        plan: { measures: input.query.measures, dimensions: input.query.dimensions },
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('compiles a local semantic-layer query with computable sources only', async () => {
    const result = await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        limit: 25,
      },
      compute,
    });

    expect(compute.query).toHaveBeenCalledWith({
      sources: [
        {
          name: 'orders',
          table: 'public.orders',
          grain: ['id'],
          columns: [
            { name: 'id', type: 'number' },
            { name: 'status', type: 'string' },
          ],
          measures: [{ name: 'order_count', expr: 'count(*)' }],
          joins: [],
        },
      ],
      dialect: 'postgres',
      query: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        limit: 25,
      },
    });
    expect(result).toEqual({
      connectionId: 'warehouse',
      dialect: 'postgres',
      sql: 'select status, count(*) as order_count from public.orders group by status',
      headers: ['orders.status', 'orders.order_count'],
      rows: [],
      totalRows: 0,
      plan: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        execution: {
          mode: 'compile_only',
          reason: 'Local semantic-layer query compiled SQL but no data-source execution adapter is configured.',
        },
      },
    });
  });

  it('compiles a local semantic-layer query from manifest-backed scan sources', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  payments:
    table: public.payments
    columns:
      - name: payment_id
        type: number
        pk: true
      - name: amount
        type: number
`,
      'ktx',
      'ktx@example.com',
      'Add manifest shard',
    );

    await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: {
        measures: ['sum(payments.amount)'],
        dimensions: [],
      },
      compute,
    });

    expect(compute.query).toHaveBeenLastCalledWith({
      sources: expect.arrayContaining([
        {
          name: 'payments',
          table: 'public.payments',
          grain: ['payment_id'],
          columns: [
            {
              name: 'payment_id',
              type: 'number',
              role: undefined,
              descriptions: undefined,
              constraints: undefined,
              enum_values: undefined,
              tests: undefined,
            },
            {
              name: 'amount',
              type: 'number',
              role: undefined,
              descriptions: undefined,
              constraints: undefined,
              enum_values: undefined,
              tests: undefined,
            },
          ],
          joins: [],
          measures: [],
        },
      ]),
      dialect: 'postgres',
      query: {
        measures: ['sum(payments.amount)'],
        dimensions: [],
      },
    });
  });

  it('resolves the only configured connection when connectionId is omitted', async () => {
    await compileLocalSlQuery(project, {
      query: { measures: ['orders.order_count'], dimensions: [] },
      compute,
    });

    expect(compute.query).toHaveBeenCalledWith(
      expect.objectContaining({
        dialect: 'postgres',
      }),
    );
  });

  it('executes compiled SQL through a local query executor when requested', async () => {
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['status', 'order_count'],
        rows: [['paid', 2]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };

    const result = await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        limit: 25,
      },
      compute,
      execute: true,
      maxRows: 10,
      queryExecutor,
    });

    expect(queryExecutor.execute).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      projectDir: project.projectDir,
      connection: { driver: 'postgres' },
      sql: 'select status, count(*) as order_count from public.orders group by status',
      maxRows: 10,
    });
    expect(result.rows).toEqual([['paid', 2]]);
    expect(result.totalRows).toBe(1);
    expect(result.plan.execution).toEqual({
      mode: 'executed',
      driver: 'postgres',
      maxRows: 10,
      rowCount: 1,
    });
  });

  it('requires a query executor for executed mode', async () => {
    await expect(
      compileLocalSlQuery(project, {
        connectionId: 'warehouse',
        query: { measures: ['orders.order_count'], dimensions: [] },
        compute,
        execute: true,
      }),
    ).rejects.toThrow('Local semantic-layer execution requires a query executor.');
  });

  it('requires connectionId when multiple connections are configured', async () => {
    project.config.connections.analytics = { driver: 'bigquery' };

    await expect(
      compileLocalSlQuery(project, {
        query: { measures: ['orders.order_count'], dimensions: [] },
        compute,
      }),
    ).rejects.toThrow('connectionId is required when the local project has zero or multiple connections.');
  });
});
