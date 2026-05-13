import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteKnowledgeIndex, type SqliteKnowledgeIndexPage } from './sqlite-knowledge-index.js';

describe('SqliteKnowledgeIndex', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-sqlite-knowledge-index-'));
    dbPath = join(tempDir, 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function page(overrides: Partial<SqliteKnowledgeIndexPage> = {}): SqliteKnowledgeIndexPage {
    return {
      path: 'wiki/global/revenue.md',
      key: 'revenue',
      scope: 'GLOBAL',
      summary: 'Revenue definition',
      content: 'Revenue is the sum of paid order amounts.',
      tags: ['finance'],
      embedding: null,
      ...overrides,
    };
  }

  it('creates a SQLite FTS5 index and returns lexical lane candidates', async () => {
    const index = new SqliteKnowledgeIndex({ dbPath });

    index.sync([
      page(),
      page({
        path: 'wiki/global/support.md',
        key: 'support',
        summary: 'Support queue',
        content: 'Tickets are grouped by priority.',
        tags: ['operations'],
      }),
    ]);

    await expect(access(dbPath)).resolves.toBeUndefined();
    expect(index.searchLexicalCandidates({ queryText: 'paid order', limit: 10 })).toEqual([
      expect.objectContaining({
        id: 'wiki/global/revenue.md',
        path: 'wiki/global/revenue.md',
        rank: 1,
        rawScore: expect.any(Number),
      }),
    ]);
  });

  it('removes stale rows when the Markdown source list changes', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.rebuild([page(), page({ path: 'wiki/global/churn.md', key: 'churn', content: 'Churn risk.' })]);
    expect(index.search('churn', 10)).toHaveLength(1);

    index.rebuild([page()]);

    expect(index.search('churn', 10)).toEqual([]);
  });

  it('exposes existing search text and embedding state for incremental refresh', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([page({ path: 'wiki/global/revenue.md', key: 'revenue', embedding: [1, 0] })]);

    expect(index.getExistingPages()).toEqual(
      new Map([
        [
          'wiki/global/revenue.md',
          expect.objectContaining({
            searchText: expect.stringContaining('Revenue definition'),
            embedding: [1, 0],
          }),
        ],
      ]),
    );
  });

  it('does not treat empty embeddings as indexed semantic vectors', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([page({ path: 'wiki/global/revenue.md', key: 'revenue', embedding: [] })]);

    expect(index.getExistingPages().get('wiki/global/revenue.md')?.embedding).toBeNull();
    expect(index.searchSemanticCandidates({ queryEmbedding: [1, 0], limit: 10 })).toEqual([]);
  });

  it('returns semantic lane candidates from stored page embeddings', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([
      page({ path: 'wiki/global/revenue.md', key: 'revenue', embedding: [1, 0] }),
      page({ path: 'wiki/global/support.md', key: 'support', summary: 'Support queue', embedding: [0, 1] }),
    ]);

    expect(index.searchSemanticCandidates({ queryEmbedding: [1, 0], limit: 10 })).toEqual([
      expect.objectContaining({
        id: 'wiki/global/revenue.md',
        path: 'wiki/global/revenue.md',
        rank: 1,
        rawScore: 1,
      }),
      expect.objectContaining({
        id: 'wiki/global/support.md',
        path: 'wiki/global/support.md',
        rank: 2,
        rawScore: 0,
      }),
    ]);
  });

  it('returns an empty result for blank or punctuation-only queries', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.rebuild([page()]);

    expect(index.search('   ', 10)).toEqual([]);
    expect(index.search('---', 10)).toEqual([]);
  });
});
