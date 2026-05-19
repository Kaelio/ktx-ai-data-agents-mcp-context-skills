import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { SlSourcesIndexPort } from './ports.js';
import type { SlDictionaryEntry } from './sl-dictionary-profile.js';
import type { SlDictionaryMatch } from './types.js';

export interface SqliteSlSourcesIndexOptions {
  dbPath: string;
}

type ExistingRow = {
  source_name: string;
  search_text: string;
  embedding_json: string | null;
};

type SearchRow = {
  connection_id?: string;
  source_name: string;
  rank: number;
  snippet?: string | null;
};

export interface SlSqliteLaneCandidate {
  id: string;
  connectionId: string;
  sourceName: string;
  rank: number;
  rawScore: number;
  snippet?: string;
}

export interface SlSqliteDictionaryCandidate extends SlSqliteLaneCandidate {
  matches: SlDictionaryMatch[];
}

type IndexedSourceRow = {
  connection_id: string;
  source_name: string;
  embedding_json: string | null;
};

type DictionarySearchRow = {
  connection_id: string;
  source_name: string;
  column_name: string;
  value: string;
  rank: number | null;
};

function candidateId(connectionId: string, sourceName: string): string {
  return `${connectionId}/${sourceName}`;
}

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

function normalizeFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((term) => term.trim())
    .filter(Boolean);

  return [...new Set(terms)].map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

function scoreFromRank(rank: number): number {
  return Number((1 / (1 + Math.abs(rank))).toFixed(6));
}

export class SqliteSlSourcesIndex implements SlSourcesIndexPort {
  private readonly db: Database.Database;

  constructor(options: SqliteSlSourcesIndexOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_sl_sources (
        connection_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        search_text TEXT NOT NULL,
        embedding_json TEXT,
        content_hash TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, source_name)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS local_sl_sources_fts USING fts5(
        connection_id UNINDEXED,
        source_name UNINDEXED,
        search_text
      );

      CREATE TABLE IF NOT EXISTS local_sl_dictionary_values (
        connection_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        value TEXT NOT NULL,
        value_lower TEXT NOT NULL,
        cardinality INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, source_name, column_name, value)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS local_sl_dictionary_values_fts USING fts5(
        connection_id UNINDEXED,
        source_name UNINDEXED,
        column_name UNINDEXED,
        value
      );
    `);
  }

  async upsertSources(
    connectionId: string,
    sources: Array<{ sourceName: string; searchText: string; embedding: number[] | null; contentHash?: string | null }>,
  ): Promise<void> {
    if (sources.length === 0) {
      return;
    }

    const upsertRow = this.db.prepare(`
      INSERT INTO local_sl_sources (
        connection_id,
        source_name,
        search_text,
        embedding_json,
        content_hash,
        updated_at
      )
      VALUES (
        @connectionId,
        @sourceName,
        @searchText,
        @embeddingJson,
        @contentHash,
        @updatedAt
      )
      ON CONFLICT(connection_id, source_name) DO UPDATE SET
        search_text = excluded.search_text,
        embedding_json = excluded.embedding_json,
        content_hash = COALESCE(excluded.content_hash, local_sl_sources.content_hash),
        updated_at = excluded.updated_at
    `);
    const deleteFts = this.db.prepare(`
      DELETE FROM local_sl_sources_fts
      WHERE connection_id = @connectionId
        AND source_name = @sourceName
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO local_sl_sources_fts (connection_id, source_name, search_text)
      VALUES (@connectionId, @sourceName, @searchText)
    `);

    const transaction = this.db.transaction(
      (
        rows: Array<{
          sourceName: string;
          searchText: string;
          embedding: number[] | null;
          contentHash?: string | null;
        }>,
      ) => {
        const updatedAt = new Date().toISOString();
        for (const source of rows) {
          const row = {
            connectionId,
            sourceName: source.sourceName,
            searchText: source.searchText,
            embeddingJson: source.embedding ? JSON.stringify(source.embedding) : null,
            contentHash: source.contentHash ?? null,
            updatedAt,
          };
          upsertRow.run(row);
          deleteFts.run(row);
          insertFts.run(row);
        }
      },
    );

    transaction(sources);
  }

  async getExistingSearchTexts(
    connectionId: string,
  ): Promise<Map<string, { searchText: string; hasEmbedding: boolean }>> {
    const rows = this.db
      .prepare(
        `
        SELECT source_name, search_text, embedding_json
        FROM local_sl_sources
        WHERE connection_id = ?
        ORDER BY source_name ASC
      `,
      )
      .all(connectionId) as ExistingRow[];

    return new Map(
      rows.map((row) => [row.source_name, { searchText: row.search_text, hasEmbedding: row.embedding_json !== null }]),
    );
  }

  async deleteStale(connectionId: string, keepNames: string[]): Promise<number> {
    if (keepNames.length === 0) {
      return this.deleteByConnection(connectionId);
    }

    const placeholders = keepNames.map(() => '?').join(', ');
    const stale = this.db
      .prepare(
        `
        SELECT source_name
        FROM local_sl_sources
        WHERE connection_id = ?
          AND source_name NOT IN (${placeholders})
      `,
      )
      .all(connectionId, ...keepNames) as Array<{ source_name: string }>;

    const deleteFts = this.db.prepare(`
      DELETE FROM local_sl_sources_fts
      WHERE connection_id = ?
        AND source_name = ?
    `);
    const deleteRow = this.db.prepare(`
      DELETE FROM local_sl_sources
      WHERE connection_id = ?
        AND source_name = ?
    `);
    const remove = this.db.transaction((sourceNames: string[]) => {
      for (const sourceName of sourceNames) {
        deleteFts.run(connectionId, sourceName);
        deleteRow.run(connectionId, sourceName);
      }
    });

    remove(stale.map((row) => row.source_name));
    return stale.length;
  }

  async deleteByConnection(connectionId: string): Promise<number> {
    return this.clear(connectionId);
  }

  async clear(connectionId: string): Promise<number> {
    const rows = this.db
      .prepare('SELECT source_name FROM local_sl_sources WHERE connection_id = ?')
      .all(connectionId) as Array<{ source_name: string }>;
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM local_sl_sources_fts WHERE connection_id = ?').run(connectionId);
      this.db.prepare('DELETE FROM local_sl_sources WHERE connection_id = ?').run(connectionId);
      this.db.prepare('DELETE FROM local_sl_dictionary_values_fts WHERE connection_id = ?').run(connectionId);
      this.db.prepare('DELETE FROM local_sl_dictionary_values WHERE connection_id = ?').run(connectionId);
    });
    remove();
    return rows.length;
  }

  async deleteByConnectionAndName(connectionId: string, sourceName: string): Promise<number> {
    return this.deleteByConnectionAndNameSync(connectionId, sourceName);
  }

  async replaceDictionaryEntries(connectionId: string, entries: SlDictionaryEntry[]): Promise<void> {
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM local_sl_dictionary_values_fts WHERE connection_id = ?').run(connectionId);
      this.db.prepare('DELETE FROM local_sl_dictionary_values WHERE connection_id = ?').run(connectionId);
    });
    const insertRow = this.db.prepare(`
      INSERT INTO local_sl_dictionary_values (
        connection_id,
        source_name,
        column_name,
        value,
        value_lower,
        cardinality,
        updated_at
      )
      VALUES (
        @connectionId,
        @sourceName,
        @columnName,
        @value,
        @valueLower,
        @cardinality,
        @updatedAt
      )
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO local_sl_dictionary_values_fts (connection_id, source_name, column_name, value)
      VALUES (@connectionId, @sourceName, @columnName, @value)
    `);
    const write = this.db.transaction((rows: SlDictionaryEntry[]) => {
      const updatedAt = new Date().toISOString();
      for (const entry of rows.filter((candidate) => candidate.connectionId === connectionId)) {
        const row = {
          connectionId: entry.connectionId,
          sourceName: entry.sourceName,
          columnName: entry.columnName,
          value: entry.value,
          valueLower: entry.value.toLowerCase(),
          cardinality: entry.cardinality,
          updatedAt,
        };
        insertRow.run(row);
        insertFts.run(row);
      }
    });

    remove();
    write(entries);
  }

  async searchLexicalCandidates(input: {
    connectionIds?: readonly string[];
    queryText: string;
    limit: number;
  }): Promise<SlSqliteLaneCandidate[]> {
    const ftsQuery = normalizeFtsQuery(input.queryText);
    if (!ftsQuery) {
      return [];
    }
    const connectionIds = [...new Set(input.connectionIds ?? [])].sort();
    const connectionPredicate =
      connectionIds.length > 0 ? `AND connection_id IN (${connectionIds.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(
        `
        SELECT
          connection_id,
          source_name,
          bm25(local_sl_sources_fts) AS rank,
          snippet(local_sl_sources_fts, 2, '<mark>', '</mark>', '...', 12) AS snippet
        FROM local_sl_sources_fts
        WHERE local_sl_sources_fts MATCH ?
          ${connectionPredicate}
        ORDER BY rank ASC, connection_id ASC, source_name ASC
        LIMIT ?
      `,
      )
      .all(ftsQuery, ...connectionIds, Math.max(1, input.limit)) as Array<SearchRow & { connection_id: string }>;

    return rows.map((row, index) => ({
      id: candidateId(row.connection_id, row.source_name),
      connectionId: row.connection_id,
      sourceName: row.source_name,
      rank: index + 1,
      rawScore: Number(row.rank),
      ...(typeof row.snippet === 'string' && row.snippet.length > 0 ? { snippet: row.snippet } : {}),
    }));
  }

  async searchSemanticCandidates(input: {
    connectionIds?: readonly string[];
    queryEmbedding: number[];
    limit: number;
  }): Promise<SlSqliteLaneCandidate[]> {
    const connectionIds = [...new Set(input.connectionIds ?? [])].sort();
    const connectionPredicate =
      connectionIds.length > 0 ? `WHERE connection_id IN (${connectionIds.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(
        `
        SELECT connection_id, source_name, embedding_json
        FROM local_sl_sources
        ${connectionPredicate}
        ORDER BY connection_id ASC, source_name ASC
      `,
      )
      .all(...connectionIds) as IndexedSourceRow[];

    return rows
      .flatMap((row) => {
        if (!row.embedding_json) {
          return [];
        }
        try {
          const embedding = JSON.parse(row.embedding_json) as unknown;
          if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) {
            return [];
          }
          return [
            {
              id: candidateId(row.connection_id, row.source_name),
              connectionId: row.connection_id,
              sourceName: row.source_name,
              rank: 0,
              rawScore: cosineSimilarity(input.queryEmbedding, embedding),
            },
          ];
        } catch {
          return [];
        }
      })
      .sort(
        (left, right) =>
          right.rawScore - left.rawScore ||
          left.connectionId.localeCompare(right.connectionId) ||
          left.sourceName.localeCompare(right.sourceName),
      )
      .slice(0, Math.max(1, input.limit))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  async searchDictionaryCandidates(input: {
    connectionIds?: readonly string[];
    queryText: string;
    limit: number;
  }): Promise<SlSqliteDictionaryCandidate[]> {
    const ftsQuery = normalizeFtsQuery(input.queryText);
    const normalizedQuery = input.queryText.trim().toLowerCase();
    if (!ftsQuery && !normalizedQuery) {
      return [];
    }

    const connectionIds = [...new Set(input.connectionIds ?? [])].sort();
    const connectionPredicate =
      connectionIds.length > 0 ? `AND connection_id IN (${connectionIds.map(() => '?').join(', ')})` : '';
    const ftsRows = ftsQuery
      ? (this.db
          .prepare(
            `
            SELECT connection_id, source_name, column_name, value, bm25(local_sl_dictionary_values_fts) AS rank
            FROM local_sl_dictionary_values_fts
            WHERE local_sl_dictionary_values_fts MATCH ?
              ${connectionPredicate}
            ORDER BY rank ASC, connection_id ASC, source_name ASC, column_name ASC, value ASC
            LIMIT ?
          `,
          )
          .all(ftsQuery, ...connectionIds, Math.max(25, input.limit * 4)) as DictionarySearchRow[])
      : [];

    const substringRows = normalizedQuery
      ? (this.db
          .prepare(
            `
            SELECT connection_id, source_name, column_name, value, NULL AS rank
            FROM local_sl_dictionary_values
            WHERE value_lower LIKE ?
              ${connectionPredicate}
            ORDER BY connection_id ASC, source_name ASC, column_name ASC, value ASC
            LIMIT ?
          `,
          )
          .all(`%${normalizedQuery}%`, ...connectionIds, Math.max(25, input.limit * 4)) as DictionarySearchRow[])
      : [];

    const rowsByKey = new Map<string, DictionarySearchRow>();
    for (const row of [...ftsRows, ...substringRows]) {
      const key = `${row.connection_id}/${row.source_name}/${row.column_name}/${row.value}`;
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, row);
      }
    }

    const grouped = new Map<string, DictionarySearchRow[]>();
    for (const row of rowsByKey.values()) {
      const key = candidateId(row.connection_id, row.source_name);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }

    return [...grouped.entries()]
      .map(([id, rows]) => {
        const [first] = rows;
        const byColumn = new Map<string, string[]>();
        for (const row of rows.sort(
          (left, right) => left.column_name.localeCompare(right.column_name) || left.value.localeCompare(right.value),
        )) {
          byColumn.set(row.column_name, [...(byColumn.get(row.column_name) ?? []), row.value]);
        }
        const matches = [...byColumn.entries()].map(([column, values]) => ({ column, values: values.slice(0, 5) }));
        return {
          id,
          connectionId: first?.connection_id ?? '',
          sourceName: first?.source_name ?? '',
          rank: 0,
          rawScore: matches.reduce((total, match) => total + match.values.length, 0),
          matches,
        };
      })
      .sort(
        (left, right) =>
          right.rawScore - left.rawScore ||
          right.matches.length - left.matches.length ||
          left.connectionId.localeCompare(right.connectionId) ||
          left.sourceName.localeCompare(right.sourceName),
      )
      .slice(0, Math.max(1, input.limit))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  async search(
    connectionId: string,
    _queryEmbedding: number[] | null,
    queryText: string,
    limit: number,
    minRrfScore = 0,
  ): Promise<Array<{ sourceName: string; rrfScore: number; snippet?: string }>> {
    const ftsQuery = normalizeFtsQuery(queryText);
    if (!ftsQuery) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
        SELECT
          source_name,
          bm25(local_sl_sources_fts) AS rank,
          snippet(local_sl_sources_fts, 2, '<mark>', '</mark>', '...', 12) AS snippet
        FROM local_sl_sources_fts
        WHERE connection_id = ?
          AND local_sl_sources_fts MATCH ?
        ORDER BY rank ASC, source_name ASC
        LIMIT ?
      `,
      )
      .all(connectionId, ftsQuery, Math.max(1, limit)) as SearchRow[];

    return rows
      .map((row) => ({
        sourceName: row.source_name,
        rrfScore: scoreFromRank(row.rank),
        ...(typeof row.snippet === 'string' && row.snippet.length > 0 ? { snippet: row.snippet } : {}),
      }))
      .filter((row) => row.rrfScore >= minRrfScore);
  }

  private deleteByConnectionAndNameSync(connectionId: string, sourceName: string): number {
    const remove = this.db.transaction(() => {
      this.db
        .prepare(
          `
          DELETE FROM local_sl_sources_fts
          WHERE connection_id = ?
            AND source_name = ?
        `,
        )
        .run(connectionId, sourceName);
      const result = this.db
        .prepare(
          `
          DELETE FROM local_sl_sources
          WHERE connection_id = ?
            AND source_name = ?
        `,
        )
        .run(connectionId, sourceName);
      return Number(result.changes);
    });
    return remove();
  }
}
