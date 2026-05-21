import { describe, expect, it } from 'vitest';
import { parseDbtSchemaFile, parseDbtSchemaFiles } from './parse-schema.js';

describe('dbt descriptions schema parser', () => {
  it('resolves shared dbt vars and defaults before parsing schema YAML', () => {
    const result = parseDbtSchemaFile(
      `
version: 2
sources:
  - name: raw
    database: "{{ var('database') }}"
    schema: "{{ var('schema', 'fallback_schema') }}"
    tables:
      - name: orders
        identifier: fct_orders
        description: "Orders from {{ var('database') }}"
        columns:
          - name: customer_id
            description: "Customer id"
            tests:
              - relationships:
                  to: ref('customers')
                  field: id
models:
  - name: "{{ var('model_name', 'orders_model') }}"
    schema: "{{ var('model_schema') }}"
    columns:
      - name: id
        description: "Order id"
`,
      { path: 'models/schema.yml', variables: new Map([['database', 'analytics'], ['model_schema', 'mart']]) },
    );

    expect(result.tables).toEqual([
      {
        name: 'fct_orders',
        description: 'Orders from analytics',
        database: 'analytics',
        schema: 'fallback_schema',
        columns: [
          {
            name: 'customer_id',
            description: 'Customer id',
            dataType: null,
            dataTests: [{ name: 'relationships', package: 'dbt', kwargs: { to: "ref('customers')", field: 'id' } }],
          },
        ],
        resourceType: 'source',
      },
      {
        name: 'orders_model',
        description: null,
        database: null,
        schema: 'mart',
        columns: [{ name: 'id', description: 'Order id', dataType: null }],
        resourceType: 'model',
      },
    ]);
    expect(result.relationships).toEqual([
      {
        fromTable: 'fct_orders',
        fromColumn: 'customer_id',
        toTable: 'customers',
        toColumn: 'id',
        fromSchema: 'fallback_schema',
      },
    ]);
  });

  it('deduplicates tables by database schema and name while merging columns', () => {
    const result = parseDbtSchemaFiles([
      {
        path: 'models/a.yml',
        content: `
version: 2
models:
  - name: orders
    description: Orders
    columns:
      - name: id
        description: Primary key
`,
      },
      {
        path: 'models/b.yml',
        content: `
version: 2
models:
  - name: orders
    columns:
      - name: status
        description: Status
      - name: id
        data_type: integer
`,
      },
    ]);

    expect(result.tables).toEqual([
      {
        name: 'orders',
        description: 'Orders',
        database: null,
        schema: null,
        resourceType: 'model',
        columns: [
          { name: 'id', description: 'Primary key', dataType: 'integer' },
          { name: 'status', description: 'Status', dataType: null },
        ],
      },
    ]);
  });

  it('returns an empty result for malformed YAML and preserves unresolved Jinja text', () => {
    expect(parseDbtSchemaFile('{{{{ invalid yaml', { path: 'broken.yml' })).toEqual({
      projectName: null,
      dbtVersion: null,
      tables: [],
      relationships: [],
    });

    const unresolved = parseDbtSchemaFile(
      `
version: 2
models:
  - name: "{{ var('missing_model') }}"
`,
      { variables: new Map() },
    );
    expect(unresolved.tables[0]?.name).toBe("{{ var('missing_model') }}");
  });

  it('extracts data tests, constraints, enum values, tags, and freshness', () => {
    const result = parseDbtSchemaFile(`
version: 2
sources:
  - name: raw
    schema: jaffle
    tags: ["raw"]
    tables:
      - name: customers
        tags: ["core"]
        loaded_at_field: updated_at
        freshness:
          warn_after: { count: 12, period: hour }
        columns:
          - name: id
            tests:
              - not_null
              - unique
          - name: status
            data_tests:
              - accepted_values:
                  values: ['active', 'inactive']
models:
  - name: orders
    tags: ["finance"]
    loaded_at_field: run_at
    columns:
      - name: status
        data_tests:
          - dbt_utils.expression_is_true:
              expression: "status is not null"
          - accepted_values: ['placed', 'shipped']
`);

    const customers = result.tables.find((table) => table.name === 'customers');
    expect(customers?.tagsDbt).toEqual(['raw', 'core']);
    expect(customers?.freshnessDbt?.loadedAtField).toBe('updated_at');
    expect(customers?.freshnessDbt?.raw).toBeDefined();
    const id = customers?.columns.find((column) => column.name === 'id');
    expect(id?.constraints?.dbt).toEqual({ not_null: true, unique: true });
    const status = customers?.columns.find((column) => column.name === 'status');
    expect(status?.enumValuesDbt).toEqual(['active', 'inactive']);

    const orders = result.tables.find((table) => table.name === 'orders');
    expect(orders?.tagsDbt).toEqual(['finance']);
    expect(orders?.freshnessDbt?.loadedAtField).toBe('run_at');
    const ordersStatus = orders?.columns.find((column) => column.name === 'status');
    expect(ordersStatus?.enumValuesDbt).toEqual(['placed', 'shipped']);
    expect(ordersStatus?.dataTests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package: 'dbt_utils', name: 'expression_is_true' }),
        expect.objectContaining({ package: 'dbt', name: 'accepted_values' }),
      ]),
    );
  });

  it('parses relationships from model column data tests', () => {
    const result = parseDbtSchemaFile(`
version: 2
models:
  - name: orders
    schema: public
    columns:
      - name: customer_id
        data_tests:
          - relationships:
              arguments:
                to: "ref('customers')"
                field: id
`);

    expect(result.relationships).toEqual([
      {
        fromTable: 'orders',
        fromColumn: 'customer_id',
        toTable: 'customers',
        toColumn: 'id',
        fromSchema: 'public',
      },
    ]);
  });
});
