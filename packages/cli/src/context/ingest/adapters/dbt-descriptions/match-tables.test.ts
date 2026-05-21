import { describe, expect, it } from 'vitest';
import type { DbtParsedTable } from './parse-schema.js';
import { findMatchingKtxTable, matchDbtTables, type DbtHostTableLite } from './match-tables.js';

const hostTables: DbtHostTableLite[] = [
  { id: '1', name: 'orders', catalog: 'warehouse', db: 'analytics', columns: [{ id: 'c1', name: 'id' }] },
  { id: '2', name: 'orders', catalog: 'warehouse', db: 'staging', columns: [{ id: 'c2', name: 'id' }] },
  { id: '3', name: 'customers', catalog: null, db: null, columns: [{ id: 'c3', name: 'id' }] },
];

function table(input: Partial<DbtParsedTable>): DbtParsedTable {
  return {
    name: 'orders',
    description: null,
    database: null,
    schema: null,
    columns: [],
    resourceType: 'model',
    ...input,
  };
}

describe('dbt descriptions table matching', () => {
  it('uses schema plus name first and checks catalog when dbt database is present', () => {
    expect(
      findMatchingKtxTable(table({ database: 'warehouse', schema: 'analytics' }), hostTables, null)?.id,
    ).toBe('1');
  });

  it('does not fall back to name-only for source tables', () => {
    expect(findMatchingKtxTable(table({ resourceType: 'source' }), hostTables, null)).toBeUndefined();
  });

  it('uses targetSchema for models and name-only only when unique', () => {
    expect(findMatchingKtxTable(table({ resourceType: 'model' }), hostTables, 'staging')?.id).toBe('2');
    expect(findMatchingKtxTable(table({ name: 'customers', resourceType: 'model' }), hostTables, null)?.id).toBe(
      '3',
    );
    expect(findMatchingKtxTable(table({ resourceType: 'model' }), hostTables, null)).toBeUndefined();
  });

  it('summarizes matched columns and descriptions', () => {
    const matches = matchDbtTables(
      [
        table({
          name: 'customers',
          description: 'Customers',
          columns: [
            { name: 'id', description: 'Primary key', dataType: null },
            { name: 'missing', description: 'Missing', dataType: null },
          ],
        }),
      ],
      hostTables,
      null,
    );

    expect(matches).toEqual([
      {
        dbtTable: 'customers',
        dbtSchema: null,
        dbtDatabase: null,
        hostTableId: '3',
        hostTableName: 'customers',
        matched: true,
        tableDescriptionAction: 'import',
        tableDescriptionFound: true,
        columnsToImport: 1,
        columnsMatched: 1,
        columnsTotal: 2,
        columnDescriptionsFound: 1,
      },
    ]);
  });
});
