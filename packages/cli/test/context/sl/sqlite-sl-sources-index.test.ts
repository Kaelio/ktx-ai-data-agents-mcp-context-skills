import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSlSourcesIndex } from '../../../src/context/sl/sqlite-sl-sources-index.js';

describe('SqliteSlSourcesIndex', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-sqlite-sl-index-'));
    dbPath = join(tempDir, 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates SQLite tables and searches indexed source text with FTS snippets', async () => {
    const index = new SqliteSlSourcesIndex({ dbPath });

    await index.upsertSources('warehouse', [
      {
        sourceName: 'orders',
        searchText: 'orders table: public.orders measure: total_revenue sum(revenue) gross revenue',
        embedding: null,
      },
      {
        sourceName: 'tickets',
        searchText: 'tickets table: public.tickets measure: ticket_count count(*) support queue',
        embedding: null,
      },
    ]);

    await expect(access(dbPath)).resolves.toBeUndefined();

    const directResults = await index.search('warehouse', null, 'gross revenue', 10);
    expect(directResults).toEqual([
      expect.objectContaining({
        sourceName: 'orders',
        rrfScore: expect.any(Number),
        snippet: expect.stringContaining('<mark>'),
      }),
    ]);
    expect(directResults[0]?.snippet).toContain('revenue');

    const lexicalCandidates = await index.searchLexicalCandidates({ queryText: 'gross revenue', limit: 10 });
    expect(lexicalCandidates).toEqual([
      expect.objectContaining({
        id: 'warehouse/orders',
        connectionId: 'warehouse',
        sourceName: 'orders',
        snippet: expect.stringContaining('<mark>'),
      }),
    ]);
  });

  it('reports existing search text and embedding presence', async () => {
    const index = new SqliteSlSourcesIndex({ dbPath });

    await index.upsertSources('warehouse', [
      {
        sourceName: 'orders',
        searchText: 'orders gross revenue',
        embedding: [0.1, 0.2, 0.3],
      },
      {
        sourceName: 'tickets',
        searchText: 'tickets support queue',
        embedding: null,
      },
    ]);

    await expect(index.getExistingSearchTexts('warehouse')).resolves.toEqual(
      new Map([
        ['orders', { searchText: 'orders gross revenue', hasEmbedding: true }],
        ['tickets', { searchText: 'tickets support queue', hasEmbedding: false }],
      ]),
    );
  });

  it('deletes stale, named, and connection-scoped rows from the FTS index', async () => {
    const index = new SqliteSlSourcesIndex({ dbPath });

    await index.upsertSources('warehouse', [
      { sourceName: 'orders', searchText: 'orders revenue', embedding: null },
      { sourceName: 'tickets', searchText: 'tickets support', embedding: null },
    ]);
    await index.upsertSources('finance', [{ sourceName: 'invoices', searchText: 'invoices revenue', embedding: null }]);

    await index.deleteStale('warehouse', ['orders']);
    expect(await index.search('warehouse', null, 'support', 10)).toEqual([]);
    expect(await index.search('warehouse', null, 'revenue', 10)).toEqual([
      expect.objectContaining({ sourceName: 'orders' }),
    ]);
    expect(await index.search('finance', null, 'revenue', 10)).toEqual([
      expect.objectContaining({ sourceName: 'invoices' }),
    ]);

    await index.deleteByConnectionAndName('warehouse', 'orders');
    expect(await index.search('warehouse', null, 'revenue', 10)).toEqual([]);

    await index.deleteByConnection('finance');
    expect(await index.search('finance', null, 'revenue', 10)).toEqual([]);
  });

  it('clear removes sources and dictionary rows for one connection only', async () => {
    const index = new SqliteSlSourcesIndex({ dbPath });
    await index.upsertSources('warehouse', [
      { sourceName: 'orders', searchText: 'orders revenue paid', embedding: null },
    ]);
    await index.upsertSources('finance', [
      { sourceName: 'invoices', searchText: 'invoices revenue paid', embedding: null },
    ]);
    await index.replaceDictionaryEntries('warehouse', [
      { connectionId: 'warehouse', sourceName: 'orders', columnName: 'status', value: 'paid', cardinality: 1 },
    ]);
    await index.replaceDictionaryEntries('finance', [
      { connectionId: 'finance', sourceName: 'invoices', columnName: 'status', value: 'paid', cardinality: 1 },
    ]);

    await expect(index.clear('warehouse')).resolves.toBe(1);

    expect(await index.search('warehouse', null, 'revenue', 10)).toEqual([]);
    expect(await index.search('finance', null, 'revenue', 10)).toEqual([
      expect.objectContaining({ sourceName: 'invoices' }),
    ]);
    await expect(index.searchDictionaryCandidates({ connectionIds: ['warehouse'], queryText: 'paid', limit: 10 }))
      .resolves.toEqual([]);
    await expect(index.searchDictionaryCandidates({ connectionIds: ['finance'], queryText: 'paid', limit: 10 }))
      .resolves.toEqual([expect.objectContaining({ connectionId: 'finance', sourceName: 'invoices' })]);
  });

  it('returns lane candidates with stable connection-scoped IDs', async () => {
    const index = new SqliteSlSourcesIndex({ dbPath });

    await index.upsertSources('warehouse', [
      { sourceName: 'orders', searchText: 'orders gross revenue paid status', embedding: [1, 0] },
    ]);
    await index.upsertSources('finance', [
      { sourceName: 'orders', searchText: 'finance orders invoices', embedding: [0, 1] },
    ]);

    await expect(index.searchLexicalCandidates({ queryText: 'gross revenue', limit: 25 })).resolves.toEqual([
      expect.objectContaining({
        id: 'warehouse/orders',
        connectionId: 'warehouse',
        sourceName: 'orders',
        rank: 1,
        rawScore: expect.any(Number),
      }),
    ]);

    await expect(index.searchSemanticCandidates({ queryEmbedding: [0, 1], limit: 25 })).resolves.toEqual([
      expect.objectContaining({ id: 'finance/orders', connectionId: 'finance', sourceName: 'orders', rank: 1 }),
      expect.objectContaining({ id: 'warehouse/orders', connectionId: 'warehouse', sourceName: 'orders', rank: 2 }),
    ]);
  });

  it('aggregates dictionary matches to one source-level lane candidate', async () => {
    const index = new SqliteSlSourcesIndex({ dbPath });

    await index.replaceDictionaryEntries('warehouse', [
      { connectionId: 'warehouse', sourceName: 'orders', columnName: 'status', value: 'paid', cardinality: 3 },
      { connectionId: 'warehouse', sourceName: 'orders', columnName: 'status', value: 'refunded', cardinality: 3 },
      { connectionId: 'warehouse', sourceName: 'orders', columnName: 'channel', value: 'paid search', cardinality: 4 },
      {
        connectionId: 'warehouse',
        sourceName: 'tickets',
        columnName: 'priority',
        value: 'paid support',
        cardinality: 5,
      },
    ]);

    await expect(index.searchDictionaryCandidates({ queryText: 'paid', limit: 25 })).resolves.toEqual([
      expect.objectContaining({
        id: 'warehouse/orders',
        connectionId: 'warehouse',
        sourceName: 'orders',
        rank: 1,
        matches: [
          { column: 'channel', values: ['paid search'] },
          { column: 'status', values: ['paid'] },
        ],
      }),
      expect.objectContaining({
        id: 'warehouse/tickets',
        connectionId: 'warehouse',
        sourceName: 'tickets',
        rank: 2,
        matches: [{ column: 'priority', values: ['paid support'] }],
      }),
    ]);
  });

  it('returns an empty result for blank or punctuation-only queries', async () => {
    const index = new SqliteSlSourcesIndex({ dbPath });
    await index.upsertSources('warehouse', [{ sourceName: 'orders', searchText: 'orders revenue', embedding: null }]);

    expect(await index.search('warehouse', null, '   ', 10)).toEqual([]);
    expect(await index.search('warehouse', null, '---', 10)).toEqual([]);
  });
});
