import { describe, expect, it } from 'vitest';
import type { DbtHostTableLite } from './match-tables.js';
import type { DbtSchemaParseResult } from './parse-schema.js';
import { toRelationshipUpdates } from './to-relationship-updates.js';

const DBT_SYSTEM_EMAIL = ['system@kae', 'lio.dev'].join('');

const hostTables: DbtHostTableLite[] = [
  {
    id: '1',
    name: 'orders',
    catalog: 'warehouse',
    db: 'analytics',
    columns: [{ id: 'c1', name: 'customer_id' }],
  },
  {
    id: '2',
    name: 'customers',
    catalog: 'warehouse',
    db: 'staging',
    columns: [{ id: 'c2', name: 'id' }],
  },
];

const parseResult: DbtSchemaParseResult = {
  projectName: null,
  dbtVersion: null,
  tables: [],
  relationships: [
    {
      fromTable: 'orders',
      fromColumn: 'customer_id',
      toTable: 'customers',
      toColumn: 'id',
      fromSchema: 'analytics',
      toSchema: 'analytics',
      description: 'schema intentionally differs from the host customers table',
    },
    { fromTable: 'orders', fromColumn: 'missing', toTable: 'customers', toColumn: 'id' },
    { fromTable: 'orders', fromColumn: 'customer_id', toTable: 'missing_table', toColumn: 'id' },
  ],
};

describe('dbt relationship update payloads', () => {
  it('validates relationships using the current name-only matching behavior and dbt provenance', () => {
    expect(toRelationshipUpdates({ connectionId: 'conn-1', parseResult, hostTables })).toEqual({
      joins: [
        {
          connectionId: 'conn-1',
          fromTable: 'orders',
          fromColumns: ['customer_id'],
          toTable: 'customers',
          toColumns: ['id'],
          relationship: 'many_to_one',
          author: 'dbt',
          authorEmail: DBT_SYSTEM_EMAIL,
        },
      ],
      skippedNoMatch: 2,
    });
  });
});
