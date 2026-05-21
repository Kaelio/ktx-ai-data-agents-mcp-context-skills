import { describe, expect, it } from 'vitest';
import type { KtxEnrichedRelationship, KtxEnrichedSchema } from './enrichment-types.js';
import { collectKtxFormalMetadataRelationships } from './relationship-formal-metadata.js';

function schema(relationships: KtxEnrichedRelationship[]): KtxEnrichedSchema {
  return {
    connectionId: 'warehouse',
    tables: [
      {
        id: 'accounts',
        ref: { catalog: null, db: null, name: 'accounts' },
        enabled: true,
        descriptions: {},
        columns: [
          {
            id: 'accounts.id',
            tableId: 'accounts',
            tableRef: { catalog: null, db: null, name: 'accounts' },
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            parentColumnId: null,
            descriptions: {},
            embedding: null,
            sampleValues: null,
            cardinality: null,
          },
        ],
      },
      {
        id: 'orders',
        ref: { catalog: null, db: null, name: 'orders' },
        enabled: true,
        descriptions: {},
        columns: [
          {
            id: 'orders.account_id',
            tableId: 'orders',
            tableRef: { catalog: null, db: null, name: 'orders' },
            name: 'account_id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            parentColumnId: null,
            descriptions: {},
            embedding: null,
            sampleValues: null,
            cardinality: null,
          },
        ],
      },
    ],
    relationships,
  };
}

function formalRelationship(overrides: Partial<KtxEnrichedRelationship> = {}): KtxEnrichedRelationship {
  return {
    id: 'orders:orders.account_id->accounts:accounts.id',
    source: 'formal',
    from: {
      tableId: 'orders',
      columnIds: ['orders.account_id'],
      table: { catalog: null, db: null, name: 'orders' },
      columns: ['account_id'],
    },
    to: {
      tableId: 'accounts',
      columnIds: ['accounts.id'],
      table: { catalog: null, db: null, name: 'accounts' },
      columns: ['id'],
    },
    relationshipType: 'many_to_one',
    confidence: 0.6,
    isPrimaryKeyReference: false,
    ...overrides,
  };
}

describe('formal metadata relationship collection', () => {
  it('accepts valid formal relationships with ground-truth confidence', () => {
    const result = collectKtxFormalMetadataRelationships(schema([formalRelationship()]));

    expect(result.accepted).toEqual([
      expect.objectContaining({
        id: 'orders:orders.account_id->accounts:accounts.id',
        source: 'formal',
        confidence: 1,
        isPrimaryKeyReference: true,
      }),
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.acceptedIds).toEqual(new Set(['orders:orders.account_id->accounts:accounts.id']));
  });

  it('skips duplicate and invalid formal relationships with reasons', () => {
    const result = collectKtxFormalMetadataRelationships(
      schema([
        formalRelationship(),
        formalRelationship(),
        formalRelationship({
          id: 'orders:orders.missing_account_id->accounts:accounts.id',
          from: {
            tableId: 'orders',
            columnIds: ['orders.missing_account_id'],
            table: { catalog: null, db: null, name: 'orders' },
            columns: ['missing_account_id'],
          },
        }),
        formalRelationship({
          id: 'manual-edge',
          source: 'manual',
        }),
      ]),
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.skipped).toEqual([
      {
        relationshipId: 'orders:orders.account_id->accounts:accounts.id',
        reason: 'formal_metadata_duplicate',
      },
      {
        relationshipId: 'orders:orders.missing_account_id->accounts:accounts.id',
        reason: 'formal_metadata_endpoint_not_found',
      },
    ]);
  });
});
