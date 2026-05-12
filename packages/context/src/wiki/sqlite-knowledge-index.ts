import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { buildKnowledgeSearchText } from './knowledge-search-text.js';
import type { LocalKnowledgeScope } from './local-knowledge.js';

export interface SqliteKnowledgeIndexOptions {
  dbPath: string;
}

export interface SqliteKnowledgeIndexPage {
  path: string;
  key: string;
  scope: LocalKnowledgeScope;
  summary: string;
  content: string;
  tags: string[];
  embedding?: number[] | null;
}

export interface SqliteKnowledgeIndexSearchResult {
  path: string;
  score: number;
}

export interface WikiSqliteLaneCandidate {
  id: string;
  path: string;
  rank: number;
  rawScore: number;
}

export interface ExistingKnowledgeIndexPage {
  searchText: string;
  embedding: number[] | null;
}

interface SearchRow {
  path: string;
  rank: number;
}

type IndexedPageRow = {
  path: string;
  embedding_json: string | null;
};

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function scoreFromRank(rank: number): number {
  return Number((1 / (1 + Math.abs(rank))).toFixed(6));
}

function parseEmbedding(raw: string | null): number[] | null {
  if (!raw) {
    return null;
  }
  try {
    const embedding = JSON.parse(raw) as unknown;
    return Array.isArray(embedding) && embedding.length > 0 && embedding.every((value) => typeof value === 'number')
      ? embedding
      : null;
  } catch {
    return null;
  }
}

function normalizeFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((term) => term.trim())
    .filter(Boolean);

  return [...new Set(terms)].map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export class SqliteKnowledgeIndex {
  private readonly db: Database.Database;

  constructor(options: SqliteKnowledgeIndexOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_pages (
        path TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        search_text TEXT NOT NULL,
        embedding_json TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_pages_fts USING fts5(
        path UNINDEXED,
        key,
        summary,
        content,
        tags
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(knowledge_pages)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has('search_text')) {
      this.db.exec("ALTER TABLE knowledge_pages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
    }
    if (!columnNames.has('embedding_json')) {
      this.db.exec('ALTER TABLE knowledge_pages ADD COLUMN embedding_json TEXT');
    }
  }

  sync(pages: SqliteKnowledgeIndexPage[]): void {
    const keepPaths = pages.map((page) => page.path);
    const clearPages =
      keepPaths.length === 0
        ? this.db.prepare('DELETE FROM knowledge_pages')
        : this.db.prepare(`DELETE FROM knowledge_pages WHERE path NOT IN (${keepPaths.map(() => '?').join(', ')})`);
    const clearFts =
      keepPaths.length === 0
        ? this.db.prepare('DELETE FROM knowledge_pages_fts')
        : this.db.prepare(`DELETE FROM knowledge_pages_fts WHERE path NOT IN (${keepPaths.map(() => '?').join(', ')})`);
    const upsertPage = this.db.prepare(`
      INSERT INTO knowledge_pages (path, key, scope, summary, content, tags, search_text, embedding_json)
      VALUES (@path, @key, @scope, @summary, @content, @tags, @searchText, @embeddingJson)
      ON CONFLICT(path) DO UPDATE SET
        key = excluded.key,
        scope = excluded.scope,
        summary = excluded.summary,
        content = excluded.content,
        tags = excluded.tags,
        search_text = excluded.search_text,
        embedding_json = excluded.embedding_json
    `);
    const deleteFts = this.db.prepare('DELETE FROM knowledge_pages_fts WHERE path = @path');
    const insertFts = this.db.prepare(`
      INSERT INTO knowledge_pages_fts (path, key, summary, content, tags)
      VALUES (@path, @key, @summary, @content, @tags)
    `);

    const transaction = this.db.transaction((items: SqliteKnowledgeIndexPage[]) => {
      clearPages.run(...keepPaths);
      clearFts.run(...keepPaths);
      for (const page of items) {
        const searchText = buildKnowledgeSearchText(page.key, page.summary, page.content, page.tags);
        const row = {
          path: page.path,
          key: page.key,
          scope: page.scope,
          summary: page.summary,
          content: searchText,
          tags: page.tags.join(' '),
          searchText,
          embeddingJson: page.embedding && page.embedding.length > 0 ? JSON.stringify(page.embedding) : null,
        };
        upsertPage.run(row);
        deleteFts.run(row);
        insertFts.run(row);
      }
    });

    transaction(pages);
  }

  rebuild(pages: SqliteKnowledgeIndexPage[]): void {
    this.sync(pages);
  }

  getExistingPages(): Map<string, ExistingKnowledgeIndexPage> {
    const rows = this.db
      .prepare(
        `
        SELECT path, search_text, embedding_json
        FROM knowledge_pages
        ORDER BY path ASC
      `,
      )
      .all() as Array<{ path: string; search_text: string; embedding_json: string | null }>;

    return new Map(
      rows.map((row) => [
        row.path,
        {
          searchText: row.search_text,
          embedding: parseEmbedding(row.embedding_json),
        },
      ]),
    );
  }

  searchLexicalCandidates(input: { queryText: string; limit: number }): WikiSqliteLaneCandidate[] {
    const ftsQuery = normalizeFtsQuery(input.queryText);
    if (!ftsQuery) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
        SELECT path, bm25(knowledge_pages_fts) AS rank
        FROM knowledge_pages_fts
        WHERE knowledge_pages_fts MATCH ?
        ORDER BY rank ASC, path ASC
        LIMIT ?
      `,
      )
      .all(ftsQuery, Math.max(1, input.limit)) as SearchRow[];

    return rows.map((row, index) => ({
      id: row.path,
      path: row.path,
      rank: index + 1,
      rawScore: Number(row.rank),
    }));
  }

  searchSemanticCandidates(input: { queryEmbedding: number[]; limit: number }): WikiSqliteLaneCandidate[] {
    const rows = this.db
      .prepare(
        `
        SELECT path, embedding_json
        FROM knowledge_pages
        ORDER BY path ASC
      `,
      )
      .all() as IndexedPageRow[];

    return rows
      .flatMap((row) => {
        if (!row.embedding_json) {
          return [];
        }
        const embedding = parseEmbedding(row.embedding_json);
        if (!embedding) {
          return [];
        }
        return [
          {
            id: row.path,
            path: row.path,
            rank: 0,
            rawScore: cosineSimilarity(input.queryEmbedding, embedding),
          },
        ];
      })
      .sort((left, right) => right.rawScore - left.rawScore || left.path.localeCompare(right.path))
      .slice(0, Math.max(1, input.limit))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  search(query: string, limit: number): SqliteKnowledgeIndexSearchResult[] {
    return this.searchLexicalCandidates({ queryText: query, limit }).map((row) => ({
      path: row.path,
      score: scoreFromRank(row.rawScore),
    }));
  }
}
