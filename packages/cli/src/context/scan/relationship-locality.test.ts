import { describe, expect, it } from 'vitest';
import type { KtxEnrichedColumn, KtxEnrichedTable } from './enrichment-types.js';
import { localCandidateTables } from './relationship-locality.js';

function column(
  tableId: string,
  id: string,
  name: string,
  options: Partial<KtxEnrichedColumn> = {},
): KtxEnrichedColumn {
  const tableRef = options.tableRef ?? { catalog: null, db: 'public', name: tableId };
  return {
    id,
    tableId,
    tableRef,
    name,
    nativeType: options.nativeType ?? 'INTEGER',
    normalizedType: options.normalizedType ?? 'integer',
    dimensionType: options.dimensionType ?? 'number',
    nullable: options.nullable ?? true,
    primaryKey: options.primaryKey ?? false,
    parentColumnId: options.parentColumnId ?? null,
    descriptions: options.descriptions ?? {},
    embedding: options.embedding ?? null,
    sampleValues: options.sampleValues ?? null,
    cardinality: options.cardinality ?? null,
  };
}

function table(id: string, name: string, columns: KtxEnrichedColumn[]): KtxEnrichedTable {
  const ref = { catalog: null, db: 'public', name };
  return {
    id,
    ref,
    enabled: true,
    descriptions: {},
    columns: columns.map((item) => ({ ...item, tableId: id, tableRef: ref })),
  };
}

describe('relationship locality', () => {
  it('ranks the referenced parent table ahead of the child table for id-like source columns', () => {
    const artists = table('artist-id', 'Artist', [column('artist-id', 'artist-pk', 'ArtistId')]);
    const albums = table('album-id', 'Album', [
      column('album-id', 'album-pk', 'AlbumId'),
      column('album-id', 'artist-fk', 'ArtistId'),
    ]);
    const unrelated = table('invoice-id', 'Invoice', [column('invoice-id', 'invoice-pk', 'InvoiceId')]);

    const ranked = localCandidateTables({
      childTable: albums,
      childColumn: albums.columns[1]!,
      parentTables: [albums, unrelated, artists],
      maxParentTables: 1,
    });

    expect(ranked.map((item) => item.table.ref.name)).toEqual(['Artist']);
    expect(ranked[0]).toMatchObject({
      score: expect.any(Number),
      tokenScore: expect.any(Number),
      embeddingScore: 0,
      reasons: expect.arrayContaining(['column_table_token_overlap']),
    });
  });

  it('uses singular and plural variants so plan_code can rank stg_plans', () => {
    const plans = table('plans-id', 'stg_plans', [column('plans-id', 'plan-code', 'plan_code')]);
    const segments = table('segments-id', 'mart_account_segments', [
      column('segments-id', 'current-plan-code', 'current_plan_code', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
      }),
    ]);
    const accounts = table('accounts-id', 'accounts', [column('accounts-id', 'account-id', 'id')]);

    const ranked = localCandidateTables({
      childTable: segments,
      childColumn: segments.columns[0]!,
      parentTables: [accounts, segments, plans],
      maxParentTables: 1,
    });

    expect(ranked.map((item) => item.table.ref.name)).toEqual(['stg_plans']);
    expect(ranked[0]?.tokenScore).toBeGreaterThan(0);
  });

  it('returns all tables when the schema is smaller than the default locality cap', () => {
    const accounts = table('accounts-id', 'accounts', [column('accounts-id', 'account-id', 'id')]);
    const invoices = table('invoices-id', 'invoices', [
      column('invoices-id', 'invoice-id', 'id'),
      column('invoices-id', 'account-id', 'account_id'),
    ]);

    const ranked = localCandidateTables({
      childTable: invoices,
      childColumn: invoices.columns[1]!,
      parentTables: [invoices, accounts],
    });

    expect(ranked.map((item) => item.table.ref.name).sort()).toEqual(['accounts', 'invoices']);
  });

  it('supports an explicit zero cap for deterministic tests', () => {
    const accounts = table('accounts-id', 'accounts', [column('accounts-id', 'account-id', 'id')]);
    const invoices = table('invoices-id', 'invoices', [
      column('invoices-id', 'invoice-id', 'id'),
      column('invoices-id', 'account-id', 'account_id'),
    ]);

    const ranked = localCandidateTables({
      childTable: invoices,
      childColumn: invoices.columns[1]!,
      parentTables: [invoices, accounts],
      maxParentTables: 0,
    });

    expect(ranked).toEqual([]);
  });

  it('uses parent-column embeddings when token locality is weak', () => {
    const customers = table('customers-id', 'customers', [
      column('customers-id', 'customers-id-col', 'id', { embedding: [1, 0, 0] }),
      column('customers-id', 'customers-name-col', 'name', {
        nativeType: 'TEXT',
        normalizedType: 'text',
        dimensionType: 'string',
        embedding: [0, 1, 0],
      }),
    ]);
    const orders = table('orders-id', 'orders', [
      column('orders-id', 'orders-id-col', 'id', { embedding: [0, 0, 1] }),
      column('orders-id', 'buyer-ref-col', 'buyer_ref', { embedding: [0.995, 0.005, 0] }),
    ]);
    const invoices = table('invoices-id', 'invoices', [column('invoices-id', 'invoice-id', 'id')]);

    const ranked = localCandidateTables({
      childTable: orders,
      childColumn: orders.columns[1]!,
      parentTables: [invoices, customers],
      maxParentTables: 1,
    });

    expect(ranked.map((item) => item.table.ref.name)).toEqual(['customers']);
    expect(ranked[0]).toMatchObject({
      embeddingScore: expect.any(Number),
      reasons: expect.arrayContaining(['embedding_similarity']),
    });
    expect(ranked[0]!.embeddingScore).toBeGreaterThan(0.99);
  });
});
