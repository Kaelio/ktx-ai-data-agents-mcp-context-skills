import { describe, expect, it } from 'vitest';
import { buildKtxColumnEmbeddingText } from './embedding-text.js';

describe('KTX scan embedding text', () => {
  it('builds column embedding text with table, description, FK, and sample-value context', () => {
    expect(
      buildKtxColumnEmbeddingText({
        tableName: 'orders',
        columnName: 'status',
        columnType: 'varchar',
        resolvedDescription: 'Payment lifecycle state',
        sampleValues: ['paid', 'refunded', 'pending'],
        resolvedTableDescription: 'Customer orders',
        foreignKeys: {
          outgoing: [{ toTable: 'customers', toColumn: 'id' }],
          incoming: [{ fromTable: 'refunds', fromColumn: 'order_status' }],
        },
        maxSampleValues: 2,
      }),
    ).toBe(
      'orders.status (varchar). Table: Customer orders. Payment lifecycle state. FK -> customers.id. FK <- refunds.order_status. Values: paid, refunded',
    );
  });

  it('omits optional sections when the scan has no enrichment context yet', () => {
    expect(
      buildKtxColumnEmbeddingText({
        tableName: 'orders',
        columnName: 'id',
        columnType: 'integer',
        resolvedDescription: null,
      }),
    ).toBe('orders.id (integer)');
  });

  it('keeps all available sample values when no explicit max is supplied', () => {
    expect(
      buildKtxColumnEmbeddingText({
        tableName: 'orders',
        columnName: 'status',
        columnType: 'varchar',
        resolvedDescription: null,
        sampleValues: ['paid', 'refunded'],
      }),
    ).toBe('orders.status (varchar). Values: paid, refunded');
  });
});
