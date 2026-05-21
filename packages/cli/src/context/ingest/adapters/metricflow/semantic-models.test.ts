import { describe, expect, it } from 'vitest';
import { composeOverlay, type SemanticLayerSource } from '../../../sl/index.js';
import type { ParsedCrossModelMetric, ParsedMetricflowRelationship, ParsedSemanticModel } from './deep-parse.js';
import {
  buildMetricflowColumns,
  buildMetricflowJoinsForModel,
  buildMetricflowSemanticModelSource,
  countImportableMetricflowRelationships,
  findMatchingMetricflowTable,
  mapCrossModelMetricToSource,
  mapSemanticModelToSource,
  resolveMetricflowSemanticModelSourceName,
  rewriteMetricflowManifestJoins,
  toKebabCaseMetricflowName,
} from './semantic-models.js';

const ordersModel: ParsedSemanticModel = {
  name: 'orders',
  description: 'Order facts',
  modelRef: 'fct_orders',
  dimensions: [
    { name: 'status', column: 'status', type: 'string', label: 'Status', description: 'Order status' },
    { name: 'ordered_at', column: 'ordered_at', type: 'time', label: 'Ordered At' },
  ],
  measures: [
    {
      type: 'simple',
      name: 'total_revenue',
      column: 'amount',
      aggregation: 'sum',
      label: 'Total Revenue',
      description: 'Revenue',
      filter: "status = 'completed'",
    },
    {
      type: 'derived',
      name: 'average_revenue',
      expr: 'total_revenue / NULLIF(order_count, 0)',
      dependsOn: ['total_revenue', 'order_count'],
    },
  ],
  entities: [],
  defaultTimeDimension: 'ordered_at',
};

describe('metricflow semantic model mapping', () => {
  it('normalizes source names the same way the server importer did', () => {
    expect(toKebabCaseMetricflowName('Fct Orders!')).toBe('fct-orders');
  });

  it('maps a parsed semantic model to a SemanticLayerSource', () => {
    expect(mapSemanticModelToSource(ordersModel, 'analytics.orders')).toEqual({
      name: 'fct-orders',
      table: 'analytics.orders',
      grain: ['status', 'ordered_at'],
      columns: [
        { name: 'status', type: 'string', description: 'Order status' },
        { name: 'ordered_at', type: 'time' },
      ],
      measures: [
        {
          name: 'total_revenue',
          expr: 'sum(amount)',
          description: 'Revenue',
          filter: "status = 'completed'",
        },
        {
          name: 'average_revenue',
          expr: 'total_revenue / NULLIF(order_count, 0)',
        },
      ],
      joins: [],
      descriptions: { dbt: 'Order facts' },
    });
  });

  it('maps a cross-model metric to a SQL standalone source', () => {
    const metric: ParsedCrossModelMetric = {
      name: 'roas',
      label: 'ROAS',
      description: 'Return on ad spend',
      type: 'derived',
      expr: 'revenue / spend',
      dependsOn: [
        { metricName: 'orders', alias: 'revenue' },
        { metricName: 'campaigns', alias: 'spend' },
      ],
      filter: "channel = 'paid'",
    };

    expect(mapCrossModelMetricToSource(metric)).toEqual({
      name: 'roas',
      sql: 'revenue / spend',
      descriptions: { dbt: 'Return on ad spend' },
      grain: [],
      columns: [],
      measures: [
        {
          name: 'roas',
          expr: 'revenue / spend',
          description: 'Return on ad spend',
          filter: "channel = 'paid'",
        },
      ],
      joins: [],
    });
  });

  it('finds matching tables using target schema, exact name, dotted suffix, and underscore suffix', () => {
    const tables = [
      { id: '1', name: 'fct_orders', catalog: null, db: 'analytics', columns: [] },
      { id: '2', name: 'warehouse.marts.fct_orders', catalog: null, db: 'marts', columns: [] },
      { id: '3', name: 'warehouse_fct_customers', catalog: null, db: null, columns: [] },
    ];

    expect(findMatchingMetricflowTable('fct_orders', tables, 'analytics')?.id).toBe('1');
    expect(findMatchingMetricflowTable('fct_orders', [tables[1]], null)?.id).toBe('2');
    expect(findMatchingMetricflowTable('fct_customers', [tables[2]], null)?.id).toBe('3');
    expect(findMatchingMetricflowTable('missing', tables, null)).toBeUndefined();
  });

  it('counts only relationships whose tables and columns exist', () => {
    const relationships: ParsedMetricflowRelationship[] = [
      { fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' },
      { fromTable: 'orders', fromColumn: 'missing', toTable: 'customers', toColumn: 'id' },
      { fromTable: 'orders', fromColumn: 'customer_id', toTable: 'missing_table', toColumn: 'id' },
    ];
    const tables = [
      { id: '1', name: 'orders', catalog: null, db: null, columns: [{ id: 'c1', name: 'customer_id' }] },
      { id: '2', name: 'customers', catalog: null, db: null, columns: [{ id: 'c2', name: 'id' }] },
    ];

    expect(countImportableMetricflowRelationships(relationships, tables)).toBe(1);
  });

  it('resolves semantic-model source names to lowercase snake_case identifiers', () => {
    expect(
      resolveMetricflowSemanticModelSourceName(ordersModel, {
        id: '1',
        name: 'ANALYTICS.Fct Orders',
        catalog: null,
        db: 'analytics',
        columns: [],
      }),
    ).toBe('fct_orders');
    expect(resolveMetricflowSemanticModelSourceName({ ...ordersModel, modelRef: 'fallback_model' }, undefined)).toBe(
      'fallback_model',
    );
  });

  it('materializes entity join keys as hidden standalone columns', () => {
    expect(
      buildMetricflowColumns({
        ...ordersModel,
        entities: [{ name: 'customer', type: 'foreign', expr: 'customer_id', description: 'FK to customers' }],
      }),
    ).toContainEqual({ name: 'customer_id', type: 'string', visibility: 'hidden', description: 'FK to customers' });
  });

  it('builds standalone sources with semantic-model joins', () => {
    const orders: ParsedSemanticModel = {
      ...ordersModel,
      modelRef: 'orders',
      entities: [{ name: 'customer', type: 'foreign', expr: 'customer_id' }],
    };
    const customers: ParsedSemanticModel = {
      ...ordersModel,
      name: 'customers',
      modelRef: 'customers',
      dimensions: [{ name: 'id', column: 'id', type: 'string' }],
      measures: [],
      entities: [],
    };
    const sourceNameByModelRef = new Map([
      [orders.modelRef, 'orders'],
      [customers.modelRef, 'customers'],
    ]);
    const joins = buildMetricflowJoinsForModel(
      orders,
      [{ fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' }],
      sourceNameByModelRef,
    );

    expect(
      buildMetricflowSemanticModelSource(
        {
          model: orders,
          matchedTable: undefined,
          sourceName: 'orders',
          manifestSource: null,
        },
        joins,
        new Map(),
      ),
    ).toMatchObject({
      name: 'orders',
      table: 'orders',
      joins: [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }],
    });
  });

  it('builds overlays for exact manifest matches so scanned columns remain manifest-owned', () => {
    const manifestSource: SemanticLayerSource = {
      name: 'orders',
      table: 'analytics.orders',
      grain: ['id'],
      columns: [
        { name: 'id', type: 'string' },
        { name: 'customer_id', type: 'string' },
      ],
      joins: [],
      measures: [],
      descriptions: { db: 'Orders table from scan' },
    };
    const overlay = buildMetricflowSemanticModelSource(
      {
        model: { ...ordersModel, modelRef: 'orders', description: 'dbt-described orders' },
        matchedTable: undefined,
        sourceName: 'orders',
        manifestSource,
      },
      [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }],
      new Map(),
    );

    expect(overlay).not.toHaveProperty('table');
    expect(overlay).not.toHaveProperty('grain');
    expect(overlay).not.toHaveProperty('columns');
    expect(overlay).toMatchObject({
      name: 'orders',
      joins: [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }],
      descriptions: { dbt: 'dbt-described orders' },
    });

    const composed = composeOverlay(manifestSource, overlay);
    expect(composed.columns.map((column) => column.name)).toEqual(['id', 'customer_id']);
    expect(composed.joins).toHaveLength(1);
    expect(composed.descriptions).toEqual({ db: 'Orders table from scan', dbt: 'dbt-described orders' });
  });

  it('rewrites preserved manifest joins to synced bare source names', () => {
    expect(
      rewriteMetricflowManifestJoins(
        [
          {
            to: 'analytics.customers',
            on: 'analytics.orders.customer_id = analytics.customers.id',
            relationship: 'many_to_one',
          },
        ],
        new Map([
          ['analytics.orders', 'orders'],
          ['analytics.customers', 'customers'],
        ]),
      ),
    ).toEqual([{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }]);
  });
});
