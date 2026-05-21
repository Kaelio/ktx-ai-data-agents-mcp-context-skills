import { describe, expect, it } from 'vitest';
import type { DbtSchemaParseResult } from './parse-schema.js';
import { toDescriptionUpdates } from './to-description-updates.js';
import type { DbtHostTableLite } from './match-tables.js';

const hostTables: DbtHostTableLite[] = [
  {
    id: '1',
    name: 'orders',
    catalog: 'warehouse',
    db: 'analytics',
    columns: [
      { id: 'c1', name: 'id' },
      { id: 'c2', name: 'amount' },
    ],
  },
];

function parseResult(description: string | null, columnDescription: string | null): DbtSchemaParseResult {
  return {
    projectName: null,
    dbtVersion: null,
    relationships: [],
    tables: [
      {
        name: 'orders',
        description,
        database: 'warehouse',
        schema: 'analytics',
        resourceType: 'model',
        columns: [
          { name: 'id', description: columnDescription, dataType: null },
          { name: 'missing', description: 'not imported', dataType: null },
        ],
      },
    ],
  };
}

describe('dbt descriptions update payloads', () => {
  it('emits dbt writes and matching ai invalidations when descriptions exist', () => {
    expect(
      toDescriptionUpdates({
        connectionId: 'conn-1',
        parseResult: parseResult('Orders table', 'Primary key'),
        hostTables,
        targetSchema: null,
      }),
    ).toEqual({
      dbt: [
        {
          connectionId: 'conn-1',
          table: { catalog: 'warehouse', db: 'analytics', name: 'orders' },
          source: 'dbt',
          tableDescription: 'Orders table',
          columnDescriptions: { id: 'Primary key' },
        },
      ],
      aiInvalidations: [
        {
          connectionId: 'conn-1',
          table: { catalog: 'warehouse', db: 'analytics', name: 'orders' },
          source: 'ai',
        },
      ],
    });
  });

  it('does not emit spurious dbt writes or ai invalidations when no descriptions exist', () => {
    expect(
      toDescriptionUpdates({
        connectionId: 'conn-1',
        parseResult: parseResult(null, null),
        hostTables,
        targetSchema: null,
      }),
    ).toEqual({ dbt: [], aiInvalidations: [] });
  });

  it('emits ai invalidation without a dbt description write when only structural metadata exists', () => {
    const result = parseResult(null, null);
    result.tables[0]!.tagsDbt = ['finance'];

    expect(
      toDescriptionUpdates({
        connectionId: 'conn-1',
        parseResult: result,
        hostTables,
        targetSchema: null,
      }),
    ).toEqual({
      dbt: [],
      aiInvalidations: [
        {
          connectionId: 'conn-1',
          table: { catalog: 'warehouse', db: 'analytics', name: 'orders' },
          source: 'ai',
        },
      ],
    });
  });
});
