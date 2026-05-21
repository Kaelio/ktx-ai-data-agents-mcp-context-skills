import { describe, expect, it } from 'vitest';
import { toMetadataUpdates } from './to-metadata-updates.js';

describe('toMetadataUpdates', () => {
  it('emits source-keyed dbt metadata updates for matched tables and columns', () => {
    const updates = toMetadataUpdates({
      connectionId: 'conn_1',
      targetSchema: 'analytics',
      hostTables: [
        {
          id: 'orders-id',
          name: 'orders',
          catalog: 'warehouse',
          db: 'analytics',
          columns: [
            { id: 'status-id', name: 'status' },
            { id: 'created-id', name: 'created_at' },
          ],
        },
      ],
      parseResult: {
        projectName: null,
        dbtVersion: null,
        relationships: [],
        tables: [
          {
            name: 'orders',
            description: null,
            database: 'warehouse',
            schema: 'analytics',
            resourceType: 'model',
            tagsDbt: ['finance'],
            freshnessDbt: { loadedAtField: 'created_at' },
            columns: [
              {
                name: 'status',
                description: null,
                dataType: null,
                enumValuesDbt: ['placed', 'shipped'],
                constraints: { dbt: { not_null: true } },
                dataTests: [{ name: 'accepted_values', package: 'dbt', kwargs: { values: ['placed', 'shipped'] } }],
              },
            ],
          },
        ],
      },
    });

    expect(updates).toEqual([
      {
        connectionId: 'conn_1',
        table: { catalog: 'warehouse', db: 'analytics', name: 'orders' },
        source: 'dbt',
        tableFields: {
          tags: ['finance'],
          freshness: { loaded_at_field: 'created_at' },
        },
        columnFields: {
          status: {
            constraints: { not_null: true },
            enum_values: ['placed', 'shipped'],
            tests: [
              { name: 'accepted_values', package: 'dbt', kwargs: { values: ['placed', 'shipped'] } },
            ],
          },
        },
      },
    ]);
  });
});
