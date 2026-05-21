import { describe, expect, it } from 'vitest';
import { type DbtHostTableLite, matchDbtTables } from './dbt-descriptions/match-tables.js';
import { mergeSemanticModelTables } from './dbt-descriptions/merge-semantic-model-tables.js';
import { parseDbtSchemaFiles } from './dbt-descriptions/parse-schema.js';
import { toDescriptionUpdates } from './dbt-descriptions/to-description-updates.js';
import { toRelationshipUpdates } from './dbt-descriptions/to-relationship-updates.js';
import { parseMetricflowFiles } from './metricflow/deep-parse.js';
import { mapCrossModelMetricToSource, mapSemanticModelToSource } from './metricflow/semantic-models.js';

const DBT_SYSTEM_EMAIL = ['system@kae', 'lio.dev'].join('');

const metricflowYaml = `
semantic_models:
  - name: orders_semantic
    description: MetricFlow order facts
    model: ref('fct_orders')
    defaults:
      agg_time_dimension: ordered_at
    entities:
      - name: customer
        type: foreign
        expr: customer_id
        description: Customer relationship
    dimensions:
      - name: status
        type: categorical
        expr: status
        description: Order status
      - name: ordered_at
        type: time
        expr: ordered_at
    measures:
      - name: total_revenue
        agg: sum
        expr: amount
        description: Revenue
  - name: customers_semantic
    description: Customer dimension
    model: ref('dim_customers')
    entities:
      - name: customer
        type: primary
        expr: id
    dimensions:
      - name: country
        type: categorical
        expr: country
        description: Customer country
    measures:
      - name: customer_count
        agg: count
        expr: id
        description: Customer count
metrics:
  - name: total_revenue
    type: simple
    type_params:
      measure: total_revenue
  - name: customer_count
    type: simple
    type_params:
      measure: customer_count
  - name: revenue_per_customer
    description: Revenue per customer
    type: derived
    type_params:
      expr: total_revenue / NULLIF(customer_count, 0)
      metrics:
        - name: total_revenue
          alias: total_revenue
        - name: customer_count
          alias: customer_count
`;

const schemaYaml = `
version: 2
sources:
  - name: raw
    database: warehouse
    schema: landing
    tables:
      - name: customers
        identifier: dim_customers
        description: Raw customer dimension
        columns:
          - name: id
            description: Customer primary key
          - name: country
            description: Country name
models:
  - name: "{{ var('orders_model', 'fct_orders') }}"
    schema: "{{ var('mart_schema', 'analytics') }}"
    description: Modeled orders
    columns:
      - name: customer_id
        description: Linked customer id
        tests:
          - relationships:
              to: ref('dim_customers')
              field: id
      - name: status
        description: Order status
      - name: amount
        description: Gross amount
`;

const hostTables: DbtHostTableLite[] = [
  {
    id: 'orders-table',
    name: 'fct_orders',
    catalog: 'warehouse',
    db: 'analytics',
    columns: [
      { id: 'orders-customer-id', name: 'customer_id' },
      { id: 'orders-status', name: 'status' },
      { id: 'orders-amount', name: 'amount' },
      { id: 'orders-ordered-at', name: 'ordered_at' },
    ],
  },
  {
    id: 'customers-table',
    name: 'dim_customers',
    catalog: 'warehouse',
    db: 'landing',
    columns: [
      { id: 'customers-id', name: 'id' },
      { id: 'customers-country', name: 'country' },
    ],
  },
];

describe('dbt extraction golden parity fixture', () => {
  it('freezes the relocated MetricFlow and dbt-description contract together', () => {
    const metricflow = parseMetricflowFiles([{ path: 'semantic_models/orders.yml', content: metricflowYaml }]);

    expect(metricflow).toEqual({
      semanticModels: [
        {
          name: 'orders_semantic',
          description: 'MetricFlow order facts',
          modelRef: 'fct_orders',
          dimensions: [
            {
              name: 'status',
              column: 'status',
              type: 'string',
              label: 'Status',
              description: 'Order status',
            },
            {
              name: 'ordered_at',
              column: 'ordered_at',
              type: 'time',
              label: 'Ordered At',
              description: undefined,
            },
          ],
          measures: [
            {
              type: 'simple',
              name: 'total_revenue',
              column: 'amount',
              aggregation: 'sum',
              label: 'Total Revenue',
              description: 'Revenue',
            },
          ],
          entities: [{ name: 'customer', type: 'foreign', expr: 'customer_id', description: 'Customer relationship' }],
          defaultTimeDimension: 'ordered_at',
        },
        {
          name: 'customers_semantic',
          description: 'Customer dimension',
          modelRef: 'dim_customers',
          dimensions: [
            {
              name: 'country',
              column: 'country',
              type: 'string',
              label: 'Country',
              description: 'Customer country',
            },
          ],
          measures: [
            {
              type: 'simple',
              name: 'customer_count',
              column: 'id',
              aggregation: 'count',
              label: 'Customer Count',
              description: 'Customer count',
            },
          ],
          entities: [{ name: 'customer', type: 'primary', expr: 'id' }],
          defaultTimeDimension: null,
        },
      ],
      crossModelMetrics: [
        {
          name: 'revenue_per_customer',
          label: null,
          description: 'Revenue per customer',
          type: 'derived',
          expr: 'total_revenue / NULLIF(customer_count, 0)',
          dependsOn: [
            { metricName: 'orders_semantic', alias: 'total_revenue' },
            { metricName: 'customers_semantic', alias: 'customer_count' },
          ],
          filter: null,
        },
      ],
      relationships: [
        {
          fromTable: 'fct_orders',
          fromColumn: 'customer_id',
          toTable: 'dim_customers',
          toColumn: 'id',
          description: 'Customer relationship',
        },
      ],
      warnings: [],
    });

    expect(mapSemanticModelToSource(metricflow.semanticModels[0], 'analytics.fct_orders')).toEqual({
      name: 'fct-orders',
      table: 'analytics.fct_orders',
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
        },
      ],
      joins: [],
      descriptions: { dbt: 'MetricFlow order facts' },
    });

    expect(mapCrossModelMetricToSource(metricflow.crossModelMetrics[0])).toEqual({
      name: 'revenue-per-customer',
      sql: 'total_revenue / NULLIF(customer_count, 0)',
      descriptions: { dbt: 'Revenue per customer' },
      grain: [],
      columns: [],
      measures: [
        {
          name: 'revenue_per_customer',
          expr: 'total_revenue / NULLIF(customer_count, 0)',
          description: 'Revenue per customer',
        },
      ],
      joins: [],
    });

    const schema = parseDbtSchemaFiles(
      [{ path: 'models/schema.yml', content: schemaYaml }],
      new Map([
        ['orders_model', 'fct_orders'],
        ['mart_schema', 'analytics'],
      ]),
    );
    const merged = mergeSemanticModelTables(schema, metricflow.semanticModels);

    expect(merged).toEqual({
      projectName: null,
      dbtVersion: null,
      tables: [
        {
          name: 'dim_customers',
          description: 'Raw customer dimension',
          database: 'warehouse',
          schema: 'landing',
          columns: [
            { name: 'id', description: 'Customer primary key', dataType: null },
            { name: 'country', description: 'Country name', dataType: null },
          ],
          resourceType: 'source',
        },
        {
          name: 'fct_orders',
          description: 'Modeled orders',
          database: null,
          schema: 'analytics',
          columns: [
            {
              name: 'customer_id',
              description: 'Linked customer id',
              dataType: null,
              dataTests: [
                {
                  name: 'relationships',
                  package: 'dbt',
                  kwargs: { to: "ref('dim_customers')", field: 'id' },
                },
              ],
            },
            { name: 'status', description: 'Order status', dataType: null },
            { name: 'amount', description: 'Gross amount', dataType: null },
          ],
          resourceType: 'model',
        },
      ],
      relationships: [
        {
          fromTable: 'fct_orders',
          fromColumn: 'customer_id',
          toTable: 'dim_customers',
          toColumn: 'id',
          fromSchema: 'analytics',
        },
      ],
    });

    expect(matchDbtTables(merged.tables, hostTables, 'analytics')).toEqual([
      {
        dbtTable: 'dim_customers',
        dbtSchema: 'landing',
        dbtDatabase: 'warehouse',
        hostTableId: 'customers-table',
        hostTableName: 'dim_customers',
        matched: true,
        tableDescriptionAction: 'import',
        tableDescriptionFound: true,
        columnsToImport: 2,
        columnsMatched: 2,
        columnsTotal: 2,
        columnDescriptionsFound: 2,
      },
      {
        dbtTable: 'fct_orders',
        dbtSchema: 'analytics',
        dbtDatabase: null,
        hostTableId: 'orders-table',
        hostTableName: 'fct_orders',
        matched: true,
        tableDescriptionAction: 'import',
        tableDescriptionFound: true,
        columnsToImport: 3,
        columnsMatched: 3,
        columnsTotal: 3,
        columnDescriptionsFound: 3,
      },
    ]);

    expect(
      toDescriptionUpdates({
        connectionId: 'warehouse-1',
        parseResult: merged,
        hostTables,
        targetSchema: 'analytics',
      }),
    ).toEqual({
      dbt: [
        {
          connectionId: 'warehouse-1',
          table: { catalog: 'warehouse', db: 'landing', name: 'dim_customers' },
          source: 'dbt',
          tableDescription: 'Raw customer dimension',
          columnDescriptions: {
            id: 'Customer primary key',
            country: 'Country name',
          },
        },
        {
          connectionId: 'warehouse-1',
          table: { catalog: 'warehouse', db: 'analytics', name: 'fct_orders' },
          source: 'dbt',
          tableDescription: 'Modeled orders',
          columnDescriptions: {
            customer_id: 'Linked customer id',
            status: 'Order status',
            amount: 'Gross amount',
          },
        },
      ],
      aiInvalidations: [
        {
          connectionId: 'warehouse-1',
          table: { catalog: 'warehouse', db: 'landing', name: 'dim_customers' },
          source: 'ai',
        },
        {
          connectionId: 'warehouse-1',
          table: { catalog: 'warehouse', db: 'analytics', name: 'fct_orders' },
          source: 'ai',
        },
      ],
    });

    expect(toRelationshipUpdates({ connectionId: 'warehouse-1', parseResult: merged, hostTables })).toEqual({
      joins: [
        {
          connectionId: 'warehouse-1',
          fromTable: 'fct_orders',
          fromColumns: ['customer_id'],
          toTable: 'dim_customers',
          toColumns: ['id'],
          relationship: 'many_to_one',
          author: 'dbt',
          authorEmail: DBT_SYSTEM_EMAIL,
        },
      ],
      skippedNoMatch: 0,
    });
  });
});
