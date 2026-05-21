import { describe, expect, it } from 'vitest';
import type { KtxSchemaSnapshot } from '../../../scan/types.js';
import { buildLiveDatabaseTableNaturalKey, ktxSchemaSnapshotToExtractedSchema } from './extracted-schema.js';

function snapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'conn-1',
    driver: 'postgres',
    extractedAt: '2026-04-27T00:00:00.000Z',
    scope: { schemas: ['public'] },
    metadata: { driver: 'postgres' },
    tables: [
      {
        name: 'orders',
        catalog: null,
        db: 'public',
        kind: 'table',
        comment: 'Orders placed by customers',
        estimatedRows: null,
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: 'Primary key',
          },
          {
            name: 'customer_id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
        foreignKeys: [
          {
            fromColumn: 'customer_id',
            toCatalog: null,
            toDb: 'public',
            toTable: 'customers',
            toColumn: 'id',
            constraintName: 'orders_customer_id_fkey',
          },
        ],
      },
      {
        name: 'customers',
        catalog: null,
        db: 'public',
        kind: 'table',
        comment: null,
        estimatedRows: null,
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: null,
          },
        ],
        foreignKeys: [],
      },
    ],
  };
}

describe('ktxSchemaSnapshotToExtractedSchema', () => {
  it('preserves structural table, column, comment, and key metadata', () => {
    const extracted = ktxSchemaSnapshotToExtractedSchema(snapshot());

    expect(extracted.tables).toEqual([
      {
        name: 'orders',
        catalog: null,
        db: 'public',
        dbComment: 'Orders placed by customers',
        columns: [
          {
            name: 'id',
            type: 'integer',
            nullable: false,
            primaryKey: true,
            dbComment: 'Primary key',
          },
          {
            name: 'customer_id',
            type: 'integer',
            nullable: false,
            primaryKey: false,
            dbComment: null,
          },
        ],
        foreignKeys: [
          {
            fromTable: 'orders',
            fromColumn: 'customer_id',
            toTable: 'customers',
            toColumn: 'id',
            constraintName: 'orders_customer_id_fkey',
          },
        ],
      },
      {
        name: 'customers',
        catalog: null,
        db: 'public',
        dbComment: null,
        columns: [
          {
            name: 'id',
            type: 'integer',
            nullable: false,
            primaryKey: true,
            dbComment: null,
          },
        ],
        foreignKeys: [],
      },
    ]);
  });

  it('builds the same natural key shape used by schema sync', () => {
    expect(buildLiveDatabaseTableNaturalKey({ catalog: null, db: 'public', name: 'orders' })).toBe('|public|orders');
    expect(buildLiveDatabaseTableNaturalKey({ catalog: 'warehouse', db: 'analytics', name: 'events' })).toBe(
      'warehouse|analytics|events',
    );
  });
});
