import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { HybridSearchCore } from '../../../context/search/hybrid-search-core.js';
import type { SearchCandidateGenerator, SearchLaneBreakdown } from '../../../context/search/types.js';
import type {
  ContextCandidateStatusResult,
  ContextEvidenceChunkForCandidate,
  ContextEvidenceChunkReadResult,
  ContextEvidenceNeighborResult,
  ContextEvidenceReadResult,
  ContextEvidenceSearchArgs,
  ContextEvidenceSearchMatchReason,
  ContextEvidenceSearchResult,
  ContextEvidenceToolStorePort,
} from '../../tools/context-evidence-tool-store.js';
import type { BudgetExhaustedCandidateForCarryForward, ContextCandidateRejectionReason, ContextCandidateVerdictSummary, CurrentRunEvidenceChunkForCarryForward, InsertContextCandidateInput, MarkContextCandidateClusterInput } from '../../../context/ingest/context-candidates/types.js';
import type { ContextCandidateStorePort } from '../../../context/ingest/context-candidates/store.js';
import type { PageTriageEvidenceChunk, PageTriageStorePort } from '../../../context/ingest/page-triage/page-triage.service.js';
import type { ContextCandidateForDedup, ContextCandidateSummary, JsonValue } from '../ports.js';
import type { ContextEvidenceIndexStorePort } from './store.js';
import type {
  ContextEvidenceDocumentRef,
  EvidencePublishState,
  ReplaceContextEvidenceChunk,
  UpsertContextEvidenceDocument,
} from './types.js';

export interface SqliteContextEvidenceStoreOptions {
  dbPath: string;
  idFactory?: () => string;
}

interface DocumentRow {
  id: string;
  run_id: string;
  connection_id: string;
  source_key: string;
  external_id: string;
  external_parent_id: string | null;
  title: string;
  path: string;
  url: string | null;
  raw_path: string;
  sync_id: string;
  publish_state: EvidencePublishState;
  deleted_at: string | null;
  triage_lane: string | null;
  metadata_json: string;
  last_edited_at: string | null;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_key: string;
  heading_path_json: string;
  ordinal: number;
  content: string;
  search_text: string;
  embedding_json: string | null;
  citation_json: string;
  stable_citation_key: string;
  sync_id: string;
  content_hash: string;
}

interface CandidateRow {
  id: string;
  run_id: string;
  connection_id: string;
  source_key: string;
  candidate_key: string;
  topic: string;
  assertion: string;
  rationale: string;
  evidence_chunk_ids_json: string;
  evidence_refs_json: string;
  suggested_page_key: string | null;
  action_hint: string;
  durability_score: number;
  authority_score: number;
  reuse_score: number;
  novelty_score: number;
  risk_score: number;
  promotion_score: number;
  status: 'pending' | 'promoted' | 'merged' | 'rejected' | 'conflict';
  rejection_reason: string | null;
  lane: 'light' | 'full' | null;
  embedding_json: string | null;
  created_at: string;
  updated_at: string;
}

interface VisibleChunkRow extends ChunkRow {
  external_id: string;
  title: string;
  path: string;
  url: string | null;
  raw_path: string;
  last_edited_at: string | null;
}

interface ContextEvidenceLaneCandidate {
  id: string;
  chunkId: string;
  rank: number;
  rawScore: number;
}

function stringifyJson(value: JsonValue | string[] | number[] | null): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  return JSON.parse(raw) as T;
}

function parseDate(raw: string | null): Date | null {
  return raw ? new Date(raw) : null;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function ftsQuery(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9_]/g, ''))
    .filter(Boolean)
    .map((token) => `${token}*`)
    .join(' OR ');
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function metadataLinks(row: DocumentRow): {
  children: string[];
  mentions: string[];
  databases: string[];
  reverseLinks: string[];
} {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  const links =
    typeof metadata.links === 'object' && metadata.links !== null ? (metadata.links as Record<string, unknown>) : {};
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return {
    children: stringArray(links.children),
    mentions: stringArray(links.mentions),
    databases: stringArray(links.databases),
    reverseLinks: stringArray(links.reverseLinks),
  };
}

export class SqliteContextEvidenceStore
  implements ContextEvidenceIndexStorePort, ContextCandidateStorePort, PageTriageStorePort, ContextEvidenceToolStorePort
{
  private readonly db: Database.Database;
  private readonly idFactory: () => string;

  constructor(options: SqliteContextEvidenceStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_evidence_documents (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        external_id TEXT NOT NULL,
        external_parent_id TEXT,
        database_id TEXT,
        data_source_id TEXT,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        url TEXT,
        object_type TEXT NOT NULL,
        last_edited_at TEXT,
        last_edited_by TEXT,
        raw_path TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        publish_state TEXT NOT NULL,
        published_at TEXT,
        deleted_at TEXT,
        triage_lane TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(connection_id, source_key, external_id, sync_id)
      );

      CREATE INDEX IF NOT EXISTS context_evidence_documents_visible_idx
        ON context_evidence_documents (connection_id, source_key, publish_state, deleted_at);

      CREATE INDEX IF NOT EXISTS context_evidence_documents_run_raw_idx
        ON context_evidence_documents (run_id, raw_path);

      CREATE TABLE IF NOT EXISTS context_evidence_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES context_evidence_documents(id) ON DELETE CASCADE,
        chunk_key TEXT NOT NULL,
        heading_path_json TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        content TEXT NOT NULL,
        search_text TEXT NOT NULL,
        embedding_json TEXT,
        token_count INTEGER NOT NULL,
        citation_json TEXT NOT NULL,
        stable_citation_key TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE(document_id, chunk_key)
      );

      CREATE INDEX IF NOT EXISTS context_evidence_chunks_document_idx
        ON context_evidence_chunks (document_id, ordinal);

      CREATE VIRTUAL TABLE IF NOT EXISTS context_evidence_chunks_fts
        USING fts5(chunk_id UNINDEXED, search_text);

      CREATE TABLE IF NOT EXISTS context_knowledge_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        candidate_key TEXT NOT NULL,
        topic TEXT NOT NULL,
        assertion TEXT NOT NULL,
        rationale TEXT NOT NULL,
        evidence_chunk_ids_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        suggested_page_key TEXT,
        action_hint TEXT NOT NULL,
        durability_score INTEGER NOT NULL,
        authority_score INTEGER NOT NULL,
        reuse_score INTEGER NOT NULL,
        novelty_score INTEGER NOT NULL,
        risk_score INTEGER NOT NULL,
        promotion_score INTEGER NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        lane TEXT,
        embedding_json TEXT,
        representative_id TEXT,
        cluster_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, candidate_key)
      );

      CREATE INDEX IF NOT EXISTS context_knowledge_candidates_run_status_idx
        ON context_knowledge_candidates (run_id, status, promotion_score DESC, created_at ASC);

      CREATE INDEX IF NOT EXISTS context_knowledge_candidates_carry_forward_idx
        ON context_knowledge_candidates (connection_id, source_key, status, rejection_reason, updated_at DESC);
    `);
  }

  async upsertDocument(params: UpsertContextEvidenceDocument): Promise<ContextEvidenceDocumentRef> {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `
        SELECT id FROM context_evidence_documents
        WHERE connection_id = ? AND source_key = ? AND external_id = ? AND sync_id = ?
      `,
      )
      .get(params.connectionId, params.sourceKey, params.externalId, params.syncId) as { id: string } | undefined;
    const id = existing?.id ?? `ctxdoc-${this.idFactory()}`;
    const publishState = params.publishState ?? 'published';
    const row = {
      id,
      runId: params.runId,
      connectionId: params.connectionId,
      sourceKey: params.sourceKey,
      externalId: params.externalId,
      externalParentId: params.externalParentId,
      databaseId: params.databaseId,
      dataSourceId: params.dataSourceId,
      title: params.title,
      path: params.path,
      url: params.url,
      objectType: params.objectType,
      lastEditedAt: params.lastEditedAt?.toISOString() ?? null,
      lastEditedBy: params.lastEditedBy,
      rawPath: params.rawPath,
      syncId: params.syncId,
      contentHash: params.contentHash,
      publishState,
      publishedAt: publishState === 'published' ? now : null,
      metadataJson: stringifyJson(params.metadata),
      now,
    };

    this.db
      .prepare(
        `
        INSERT INTO context_evidence_documents (
          id, run_id, connection_id, source_key, external_id, external_parent_id, database_id,
          data_source_id, title, path, url, object_type, last_edited_at, last_edited_by,
          raw_path, sync_id, content_hash, publish_state, published_at, deleted_at,
          triage_lane, metadata_json, created_at, updated_at
        )
        VALUES (
          @id, @runId, @connectionId, @sourceKey, @externalId, @externalParentId, @databaseId,
          @dataSourceId, @title, @path, @url, @objectType, @lastEditedAt, @lastEditedBy,
          @rawPath, @syncId, @contentHash, @publishState, @publishedAt, NULL,
          NULL, @metadataJson, @now, @now
        )
        ON CONFLICT(connection_id, source_key, external_id, sync_id) DO UPDATE SET
          run_id = excluded.run_id,
          external_parent_id = excluded.external_parent_id,
          database_id = excluded.database_id,
          data_source_id = excluded.data_source_id,
          title = excluded.title,
          path = excluded.path,
          url = excluded.url,
          object_type = excluded.object_type,
          last_edited_at = excluded.last_edited_at,
          last_edited_by = excluded.last_edited_by,
          raw_path = excluded.raw_path,
          content_hash = excluded.content_hash,
          publish_state = excluded.publish_state,
          published_at = excluded.published_at,
          deleted_at = NULL,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(row);
    return { id };
  }

  async replaceChunks(documentId: string, chunks: ReplaceContextEvidenceChunk[]): Promise<void> {
    const replace = this.db.transaction(() => {
      const oldRows = this.db
        .prepare('SELECT id FROM context_evidence_chunks WHERE document_id = ?')
        .all(documentId) as Array<{
        id: string;
      }>;
      for (const row of oldRows) {
        this.db.prepare('DELETE FROM context_evidence_chunks_fts WHERE chunk_id = ?').run(row.id);
      }
      this.db.prepare('DELETE FROM context_evidence_chunks WHERE document_id = ?').run(documentId);

      const insertChunk = this.db.prepare(`
        INSERT INTO context_evidence_chunks (
          id, document_id, chunk_key, heading_path_json, ordinal, content, search_text,
          embedding_json, token_count, citation_json, stable_citation_key, sync_id, content_hash
        )
        VALUES (
          @id, @documentId, @chunkKey, @headingPathJson, @ordinal, @content, @searchText,
          @embeddingJson, @tokenCount, @citationJson, @stableCitationKey, @syncId, @contentHash
        )
      `);
      const insertFts = this.db.prepare(
        'INSERT INTO context_evidence_chunks_fts (chunk_id, search_text) VALUES (?, ?)',
      );

      for (const chunk of chunks) {
        const id = `ctxchunk-${this.idFactory()}`;
        insertChunk.run({
          id,
          documentId,
          chunkKey: chunk.chunkKey,
          headingPathJson: stringifyJson(chunk.headingPath),
          ordinal: chunk.ordinal,
          content: chunk.content,
          searchText: chunk.searchText,
          embeddingJson: chunk.embedding ? stringifyJson(chunk.embedding) : null,
          tokenCount: chunk.tokenCount,
          citationJson: stringifyJson(chunk.citation),
          stableCitationKey: chunk.stableCitationKey,
          syncId: chunk.syncId,
          contentHash: chunk.contentHash,
        });
        insertFts.run(id, chunk.searchText);
      }
    });
    replace();
  }

  async countPublishedDocumentsByRawPaths(
    connectionId: string,
    sourceKey: string,
    rawPaths: string[],
  ): Promise<number> {
    if (rawPaths.length === 0) {
      return 0;
    }
    const row = this.db
      .prepare(
        `
        SELECT count(*) AS count
        FROM context_evidence_documents
        WHERE connection_id = ?
          AND source_key = ?
          AND raw_path IN (${placeholders(rawPaths)})
          AND publish_state = 'published'
          AND deleted_at IS NULL
      `,
      )
      .get(connectionId, sourceKey, ...rawPaths) as { count: number };
    return row.count;
  }

  async publishSync(
    connectionId: string,
    sourceKey: string,
    syncId: string,
    deletedMarkdownRawPaths: string[],
  ): Promise<{ documentsPublished: number; documentsDeleted: number }> {
    const publish = this.db.transaction(() => {
      const now = new Date().toISOString();
      const pending = this.db
        .prepare(
          `
          SELECT DISTINCT external_id
          FROM context_evidence_documents
          WHERE connection_id = ? AND source_key = ? AND sync_id = ? AND publish_state = 'pending' AND deleted_at IS NULL
        `,
        )
        .all(connectionId, sourceKey, syncId) as Array<{ external_id: string }>;
      const externalIds = pending.map((row) => row.external_id);
      if (externalIds.length > 0) {
        this.db
          .prepare(
            `
            UPDATE context_evidence_documents
            SET publish_state = 'superseded', updated_at = ?
            WHERE connection_id = ?
              AND source_key = ?
              AND external_id IN (${placeholders(externalIds)})
              AND sync_id <> ?
              AND publish_state = 'published'
              AND deleted_at IS NULL
          `,
          )
          .run(now, connectionId, sourceKey, ...externalIds, syncId);
      }
      const published = this.db
        .prepare(
          `
          UPDATE context_evidence_documents
          SET publish_state = 'published', published_at = ?, deleted_at = NULL, updated_at = ?
          WHERE connection_id = ? AND source_key = ? AND sync_id = ? AND publish_state = 'pending' AND deleted_at IS NULL
        `,
        )
        .run(now, now, connectionId, sourceKey, syncId).changes;
      const uniqueDeleted = [...new Set(deletedMarkdownRawPaths)];
      const deleted =
        uniqueDeleted.length === 0
          ? 0
          : this.db
              .prepare(
                `
                UPDATE context_evidence_documents
                SET deleted_at = ?, updated_at = ?
                WHERE connection_id = ?
                  AND source_key = ?
                  AND raw_path IN (${placeholders(uniqueDeleted)})
                  AND publish_state = 'published'
                  AND deleted_at IS NULL
              `,
              )
              .run(now, now, connectionId, sourceKey, ...uniqueDeleted).changes;
      return { documentsPublished: published, documentsDeleted: deleted };
    });
    return publish();
  }

  async setDocumentTriageLane(runId: string, rawPath: string, lane: 'skip' | 'light' | 'full'): Promise<number> {
    return this.db
      .prepare(
        `
        UPDATE context_evidence_documents
        SET triage_lane = ?, updated_at = ?
        WHERE run_id = ? AND raw_path = ?
      `,
      )
      .run(lane, new Date().toISOString(), runId, rawPath).changes;
  }

  async listDocumentChunksForLightExtraction(runId: string, rawPath: string): Promise<PageTriageEvidenceChunk[]> {
    const rows = this.db
      .prepare(
        `
        SELECT c.*, d.raw_path, d.title, d.path, d.url, d.last_edited_at
        FROM context_evidence_chunks c
        JOIN context_evidence_documents d ON d.id = c.document_id
        WHERE d.run_id = ? AND d.raw_path = ?
        ORDER BY c.ordinal ASC
      `,
      )
      .all(runId, rawPath) as Array<
      ChunkRow & Pick<DocumentRow, 'raw_path' | 'title' | 'path' | 'url' | 'last_edited_at'>
    >;
    return rows.map((row) => ({
      chunkId: row.id,
      headingPath: parseJson<string[]>(row.heading_path_json, []),
      ordinal: row.ordinal,
      content: row.content,
      stableCitationKey: row.stable_citation_key,
      citation: parseJson<JsonValue>(row.citation_json, null),
      rawPath: row.raw_path,
      title: row.title,
      path: row.path,
      url: row.url,
      lastEditedAt: parseDate(row.last_edited_at),
    }));
  }

  async searchRRF(args: ContextEvidenceSearchArgs): Promise<ContextEvidenceSearchResult[]> {
    const rows = this.visibleChunks(
      args.connectionId,
      args.sourceKey ?? null,
      args.currentRunId ?? null,
      args.includeDeleted,
    );
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const store = this;
    const core = new HybridSearchCore();

    const generators: SearchCandidateGenerator[] = [
      {
        lane: 'lexical',
        async generate(searchArgs) {
          const fts = ftsQuery(searchArgs.queryText);
          if (!fts) {
            return { status: 'skipped', candidates: [], reason: 'fts_query_empty' };
          }
          const candidates = store.searchLexicalContextEvidenceCandidates(
            rowsById,
            fts,
            searchArgs.laneCandidatePoolLimit,
          );
          return {
            candidates: candidates.map((candidate) => ({
              id: candidate.id,
              rank: candidate.rank,
              rawScore: candidate.rawScore,
            })),
          };
        },
      },
      {
        lane: 'semantic',
        async generate(searchArgs) {
          if (!args.queryEmbedding) {
            return { status: 'skipped', candidates: [], reason: 'embedding_unconfigured' };
          }
          const candidates = store.searchSemanticContextEvidenceCandidates(
            rows,
            args.queryEmbedding,
            searchArgs.laneCandidatePoolLimit,
          );
          return {
            candidates: candidates.map((candidate) => ({
              id: candidate.id,
              rank: candidate.rank,
              rawScore: candidate.rawScore,
            })),
          };
        },
      },
      {
        lane: 'token',
        async generate(searchArgs) {
          const candidates = store.searchTokenContextEvidenceCandidates(
            rows,
            searchArgs.normalizedQuery.terms,
            searchArgs.queryText,
            searchArgs.laneCandidatePoolLimit,
          );
          return {
            candidates: candidates.map((candidate) => ({
              id: candidate.id,
              rank: candidate.rank,
              rawScore: candidate.rawScore,
            })),
          };
        },
      },
    ];

    const result = await core.search({ queryText: args.queryText, limit: args.limit, generators });
    return result.results
      .map((fused): ContextEvidenceSearchResult | null => {
        const row = rowsById.get(fused.id);
        return row
          ? this.contextEvidenceSearchResult(
              row,
              fused.score,
              fused.matchReasons as ContextEvidenceSearchMatchReason[],
              result.lanes,
            )
          : null;
      })
      .filter((entry): entry is ContextEvidenceSearchResult => entry !== null);
  }

  async readChunkById(
    chunkId: string,
    connectionId: string,
    sourceKey: string,
    currentRunId?: string,
  ): Promise<ContextEvidenceChunkReadResult | null> {
    const row = this.visibleChunks(connectionId, sourceKey, currentRunId ?? null, false).find(
      (chunk) => chunk.id === chunkId,
    );
    if (!row) {
      return null;
    }
    return {
      document: this.documentForRead(row),
      chunk: this.chunkForRead(row),
    };
  }

  async readDocumentById(
    documentId: string,
    connectionId: string,
    sourceKey: string,
    currentRunId?: string,
  ): Promise<ContextEvidenceReadResult | null> {
    return this.readDocument({ documentId, connectionId, sourceKey, currentRunId: currentRunId ?? null });
  }

  async readDocumentByExternalId(
    connectionId: string,
    sourceKey: string,
    externalId: string,
    currentRunId?: string,
  ): Promise<ContextEvidenceReadResult | null> {
    return this.readDocument({ externalId, connectionId, sourceKey, currentRunId: currentRunId ?? null });
  }

  async readChunksByIds(
    chunkIds: string[],
    connectionId: string,
    sourceKey: string,
    currentRunId?: string,
  ): Promise<ContextEvidenceChunkForCandidate[]> {
    if (chunkIds.length === 0) {
      return [];
    }
    const visible = this.visibleChunks(connectionId, sourceKey, currentRunId ?? null, false);
    const byId = new Map(visible.map((row) => [row.id, row]));
    return chunkIds.flatMap((chunkId) => {
      const row = byId.get(chunkId);
      if (!row) {
        return [];
      }
      return [
        {
          chunkId: row.id,
          documentId: row.document_id,
          externalId: row.external_id,
          title: row.title,
          path: row.path,
          url: row.url,
          rawPath: row.raw_path,
          content: row.content,
          citation: parseJson<JsonValue>(row.citation_json, null),
          stableCitationKey: row.stable_citation_key,
          syncId: row.sync_id,
          lastEditedAt: parseDate(row.last_edited_at),
        },
      ];
    });
  }

  async findNeighborDocuments(args: {
    connectionId: string;
    sourceKey: string;
    documentId: string;
    relation: 'parent' | 'children' | 'linked' | 'backlinked' | 'same_path';
    limit: number;
    currentRunId?: string;
  }): Promise<ContextEvidenceNeighborResult[]> {
    const current = this.visibleDocument(args.connectionId, args.sourceKey, args.documentId, args.currentRunId ?? null);
    if (!current) {
      return [];
    }
    let externalIds: string[] = [];
    if (args.relation === 'parent' && current.external_parent_id) {
      externalIds = [current.external_parent_id];
    } else if (args.relation === 'children') {
      return this.neighborRowsByParent(args, current.external_id);
    } else if (args.relation === 'same_path' && current.external_parent_id) {
      return this.neighborRowsByParent(args, current.external_parent_id).filter(
        (row) => row.externalId !== current.external_id,
      );
    } else if (args.relation === 'linked') {
      const links = metadataLinks(current);
      externalIds = [...links.mentions, ...links.databases];
    } else if (args.relation === 'backlinked') {
      externalIds = metadataLinks(current).reverseLinks;
    }
    return this.neighborRowsByExternalIds(args, externalIds);
  }

  async insertCandidate(
    params: InsertContextCandidateInput,
  ): Promise<{ id: string; candidate_key: string; promotion_score: number; status: string }> {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT id, created_at FROM context_knowledge_candidates WHERE run_id = ? AND candidate_key = ?')
      .get(params.runId, params.candidateKey) as { id: string; created_at: string } | undefined;
    const id = existing?.id ?? `ctxcand-${this.idFactory()}`;
    this.db
      .prepare(
        `
        INSERT INTO context_knowledge_candidates (
          id, run_id, connection_id, source_key, candidate_key, topic, assertion, rationale,
          evidence_chunk_ids_json, evidence_refs_json, suggested_page_key, action_hint,
          durability_score, authority_score, reuse_score, novelty_score, risk_score, promotion_score,
          status, rejection_reason, lane, embedding_json, representative_id, cluster_id, created_at, updated_at
        )
        VALUES (
          @id, @runId, @connectionId, @sourceKey, @candidateKey, @topic, @assertion, @rationale,
          @evidenceChunkIdsJson, @evidenceRefsJson, @suggestedPageKey, @actionHint,
          @durabilityScore, @authorityScore, @reuseScore, @noveltyScore, @riskScore, @promotionScore,
          @status, @rejectionReason, @lane, @embeddingJson, NULL, NULL, @createdAt, @updatedAt
        )
        ON CONFLICT(run_id, candidate_key) DO UPDATE SET
          connection_id = excluded.connection_id,
          source_key = excluded.source_key,
          topic = excluded.topic,
          assertion = excluded.assertion,
          rationale = excluded.rationale,
          evidence_chunk_ids_json = excluded.evidence_chunk_ids_json,
          evidence_refs_json = excluded.evidence_refs_json,
          suggested_page_key = excluded.suggested_page_key,
          action_hint = excluded.action_hint,
          durability_score = excluded.durability_score,
          authority_score = excluded.authority_score,
          reuse_score = excluded.reuse_score,
          novelty_score = excluded.novelty_score,
          risk_score = excluded.risk_score,
          promotion_score = excluded.promotion_score,
          status = excluded.status,
          rejection_reason = excluded.rejection_reason,
          lane = excluded.lane,
          embedding_json = excluded.embedding_json,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        id,
        runId: params.runId,
        connectionId: params.connectionId,
        sourceKey: params.sourceKey,
        candidateKey: params.candidateKey,
        topic: params.topic,
        assertion: params.assertion,
        rationale: params.rationale,
        evidenceChunkIdsJson: stringifyJson(params.evidenceChunkIds),
        evidenceRefsJson: stringifyJson(params.evidenceRefs),
        suggestedPageKey: params.suggestedPageKey,
        actionHint: params.actionHint,
        durabilityScore: params.durabilityScore,
        authorityScore: params.authorityScore,
        reuseScore: params.reuseScore,
        noveltyScore: params.noveltyScore,
        riskScore: params.riskScore,
        promotionScore: params.promotionScore,
        status: params.status,
        rejectionReason: params.rejectionReason,
        lane: params.lane ?? null,
        embeddingJson: params.embedding ? stringifyJson(params.embedding) : null,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      });
    return { id, candidate_key: params.candidateKey, promotion_score: params.promotionScore, status: params.status };
  }

  async listCandidatesForPromptByKeys(runId: string, candidateKeys: string[]) {
    if (candidateKeys.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `
        SELECT candidate_key, topic, assertion, rationale, action_hint, status, promotion_score, suggested_page_key,
          evidence_refs_json
        FROM context_knowledge_candidates
        WHERE run_id = ? AND candidate_key IN (${placeholders(candidateKeys)})
      `,
      )
      .all(runId, ...candidateKeys) as CandidateRow[];
    const byKey = new Map(
      rows.map((row) => [
        row.candidate_key,
        {
          candidateKey: row.candidate_key,
          topic: row.topic,
          assertion: row.assertion,
          rationale: row.rationale,
          actionHint: row.action_hint,
          status: row.status,
          promotionScore: row.promotion_score,
          suggestedPageKey: row.suggested_page_key,
          evidenceRefs: parseJson<JsonValue>(row.evidence_refs_json, null),
        },
      ]),
    );
    return candidateKeys.map((candidateKey) => byKey.get(candidateKey)).filter((row) => !!row);
  }

  async markPendingCandidatesByReason(params: {
    runId: string;
    candidateKeys: string[];
    rejectionReason: ContextCandidateRejectionReason;
  }): Promise<number> {
    if (params.candidateKeys.length === 0) {
      return 0;
    }
    return this.db
      .prepare(
        `
        UPDATE context_knowledge_candidates
        SET status = 'rejected', rejection_reason = ?, updated_at = ?
        WHERE run_id = ? AND candidate_key IN (${placeholders(params.candidateKeys)}) AND status = 'pending'
      `,
      )
      .run(params.rejectionReason, new Date().toISOString(), params.runId, ...params.candidateKeys).changes;
  }

  async summarizeCandidateVerdicts(runId: string, candidateKeys: string[]): Promise<ContextCandidateVerdictSummary> {
    const summary: ContextCandidateVerdictSummary = {
      pending: 0,
      promoted: 0,
      merged: 0,
      rejected: 0,
      conflict: 0,
      rejectedByReason: {},
    };
    if (candidateKeys.length === 0) {
      return summary;
    }
    const rows = this.db
      .prepare(
        `
        SELECT status, rejection_reason
        FROM context_knowledge_candidates
        WHERE run_id = ? AND candidate_key IN (${placeholders(candidateKeys)})
      `,
      )
      .all(runId, ...candidateKeys) as CandidateRow[];
    for (const row of rows) {
      if (row.status === 'pending') {
        summary.pending += 1;
      } else if (row.status === 'promoted') {
        summary.promoted += 1;
      } else if (row.status === 'merged') {
        summary.merged += 1;
      } else if (row.status === 'rejected') {
        summary.rejected += 1;
        if (row.rejection_reason) {
          summary.rejectedByReason[row.rejection_reason] = (summary.rejectedByReason[row.rejection_reason] ?? 0) + 1;
        }
      } else if (row.status === 'conflict') {
        summary.conflict += 1;
      }
    }
    return summary;
  }

  async listPendingCandidatesForDedup(runId: string): Promise<ContextCandidateForDedup[]> {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM context_knowledge_candidates
        WHERE run_id = ? AND status = 'pending'
        ORDER BY promotion_score DESC, created_at ASC
      `,
      )
      .all(runId) as CandidateRow[];
    return rows.map((row) => this.candidateForDedup(row));
  }

  async updateCandidateEmbedding(candidateId: string, embedding: number[]): Promise<void> {
    this.db
      .prepare('UPDATE context_knowledge_candidates SET embedding_json = ?, updated_at = ? WHERE id = ?')
      .run(stringifyJson(embedding), new Date().toISOString(), candidateId);
  }

  async markCandidatesAsMergedToCluster(params: MarkContextCandidateClusterInput): Promise<void> {
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE context_knowledge_candidates
          SET cluster_id = ?, evidence_chunk_ids_json = ?, evidence_refs_json = ?, promotion_score = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          params.representativeId,
          stringifyJson(params.evidenceChunkIds),
          stringifyJson(params.evidenceRefs),
          params.promotionScore,
          new Date().toISOString(),
          params.representativeId,
        );
      if (params.memberIds.length > 0) {
        this.db
          .prepare(
            `
            UPDATE context_knowledge_candidates
            SET status = 'merged', representative_id = ?, cluster_id = ?, updated_at = ?
            WHERE id IN (${placeholders(params.memberIds)})
          `,
          )
          .run(params.representativeId, params.representativeId, new Date().toISOString(), ...params.memberIds);
      }
    });
    update();
  }

  async listBudgetExhaustedCandidatesForCarryForward(params: {
    connectionId: string;
    sourceKey: string;
    currentRunId: string;
  }): Promise<BudgetExhaustedCandidateForCarryForward[]> {
    const currentRows = this.db
      .prepare('SELECT candidate_key FROM context_knowledge_candidates WHERE run_id = ?')
      .all(params.currentRunId) as Array<{ candidate_key: string }>;
    const currentKeys = new Set(currentRows.map((row) => row.candidate_key));
    const rows = this.db
      .prepare(
        `
        SELECT * FROM context_knowledge_candidates
        WHERE connection_id = ?
          AND source_key = ?
          AND run_id <> ?
          AND status = 'rejected'
          AND rejection_reason = 'exceeded_run_budget'
        ORDER BY candidate_key ASC, updated_at DESC
      `,
      )
      .all(params.connectionId, params.sourceKey, params.currentRunId) as CandidateRow[];
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (currentKeys.has(row.candidate_key) || seen.has(row.candidate_key)) {
        return [];
      }
      seen.add(row.candidate_key);
      return [
        {
          sourceRunId: row.run_id,
          candidateKey: row.candidate_key,
          topic: row.topic,
          assertion: row.assertion,
          rationale: row.rationale,
          evidenceChunkIds: parseJson<string[]>(row.evidence_chunk_ids_json, []),
          evidenceRefs: parseJson<JsonValue>(row.evidence_refs_json, []),
          suggestedPageKey: row.suggested_page_key,
          actionHint: row.action_hint as BudgetExhaustedCandidateForCarryForward['actionHint'],
          durabilityScore: row.durability_score,
          authorityScore: row.authority_score,
          reuseScore: row.reuse_score,
          noveltyScore: row.novelty_score,
          riskScore: row.risk_score,
          promotionScore: row.promotion_score,
          lane: row.lane,
        },
      ];
    });
  }

  async listCurrentRunEvidenceChunksForCarryForward(runId: string): Promise<CurrentRunEvidenceChunkForCarryForward[]> {
    const rows = this.db
      .prepare(
        `
        SELECT c.*, d.external_id, d.raw_path, d.title, d.path, d.url, d.last_edited_at
        FROM context_evidence_chunks c
        JOIN context_evidence_documents d ON d.id = c.document_id
        WHERE d.run_id = ? AND d.deleted_at IS NULL
        ORDER BY d.raw_path ASC, c.ordinal ASC
      `,
      )
      .all(runId) as VisibleChunkRow[];
    return rows.map((row) => ({
      chunkId: row.id,
      stableCitationKey: row.stable_citation_key,
      syncId: row.sync_id,
      rawPath: row.raw_path,
      title: row.title,
      path: row.path,
      url: row.url,
      lastEditedAt: parseDate(row.last_edited_at),
      citation: parseJson<JsonValue>(row.citation_json, null),
      content: row.content,
    }));
  }

  async updateCandidateStatus(args: {
    runId: string;
    candidateKey: string;
    status: 'pending' | 'promoted' | 'merged' | 'rejected' | 'conflict';
    rejectionReason: string | null;
  }): Promise<ContextCandidateStatusResult | null> {
    this.db
      .prepare(
        `
        UPDATE context_knowledge_candidates
        SET status = ?, rejection_reason = ?, updated_at = ?
        WHERE run_id = ? AND candidate_key = ?
      `,
      )
      .run(args.status, args.rejectionReason, new Date().toISOString(), args.runId, args.candidateKey);
    const row = this.db
      .prepare('SELECT candidate_key, status FROM context_knowledge_candidates WHERE run_id = ? AND candidate_key = ?')
      .get(args.runId, args.candidateKey) as Pick<CandidateRow, 'candidate_key' | 'status'> | undefined;
    return row ? { candidate_key: row.candidate_key, status: row.status } : null;
  }

  async getCandidateSummary(runId: string): Promise<ContextCandidateSummary> {
    const rows = this.db
      .prepare(
        `
        SELECT status, COUNT(*) AS count
        FROM context_knowledge_candidates
        WHERE run_id = ?
        GROUP BY status
      `,
      )
      .all(runId) as Array<{ status: CandidateRow['status']; count: number }>;
    const summary: ContextCandidateSummary = {
      total: 0,
      pending: 0,
      promoted: 0,
      merged: 0,
      rejected: 0,
      conflict: 0,
    };
    for (const row of rows) {
      summary.total += row.count;
      summary[row.status] = row.count;
    }
    return summary;
  }

  private searchLexicalContextEvidenceCandidates(
    visibleRowsById: Map<string, VisibleChunkRow>,
    query: string,
    limit: number,
  ): ContextEvidenceLaneCandidate[] {
    const rows = this.db
      .prepare(
        `
        SELECT chunk_id, bm25(context_evidence_chunks_fts) AS score
        FROM context_evidence_chunks_fts
        WHERE context_evidence_chunks_fts MATCH ?
        ORDER BY score ASC, chunk_id ASC
      `,
      )
      .all(query) as Array<{ chunk_id: string; score: number }>;

    return rows
      .filter((row) => visibleRowsById.has(row.chunk_id))
      .slice(0, Math.max(1, limit))
      .map((row, index) => ({
        id: row.chunk_id,
        chunkId: row.chunk_id,
        rank: index + 1,
        rawScore: Number(row.score),
      }));
  }

  private searchSemanticContextEvidenceCandidates(
    rows: VisibleChunkRow[],
    queryEmbedding: number[],
    limit: number,
  ): ContextEvidenceLaneCandidate[] {
    return rows
      .flatMap((row) => {
        const vector = parseJson<number[] | null>(row.embedding_json, null);
        if (!vector) {
          return [];
        }
        return [
          {
            id: row.id,
            chunkId: row.id,
            rank: 0,
            rawScore: cosine(queryEmbedding, vector),
          },
        ];
      })
      .filter((candidate) => candidate.rawScore > 0)
      .sort((left, right) => right.rawScore - left.rawScore || left.chunkId.localeCompare(right.chunkId))
      .slice(0, Math.max(1, limit))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  private searchTokenContextEvidenceCandidates(
    rows: VisibleChunkRow[],
    terms: string[],
    rawQueryText: string,
    limit: number,
  ): ContextEvidenceLaneCandidate[] {
    const rawNeedle = rawQueryText.trim().toLowerCase();
    if (terms.length === 0 && rawNeedle.length === 0) {
      return [];
    }

    return rows
      .map((row) => {
        const haystack = row.search_text.toLowerCase();
        const rawScore =
          terms.length > 0
            ? terms.filter((term) => haystack.includes(term)).length / terms.length
            : haystack.includes(rawNeedle)
              ? 1
              : 0;
        return {
          id: row.id,
          chunkId: row.id,
          rank: 0,
          rawScore,
        };
      })
      .filter((candidate) => candidate.rawScore > 0)
      .sort((left, right) => right.rawScore - left.rawScore || left.chunkId.localeCompare(right.chunkId))
      .slice(0, Math.max(1, limit))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  private contextEvidenceSearchResult(
    row: VisibleChunkRow,
    score: number,
    matchReasons: ContextEvidenceSearchMatchReason[],
    lanes: SearchLaneBreakdown[],
  ): ContextEvidenceSearchResult {
    return {
      chunkId: row.id,
      documentId: row.document_id,
      externalId: row.external_id,
      title: row.title,
      path: row.path,
      url: row.url,
      snippet: row.content.slice(0, 500),
      score,
      citation: parseJson<JsonValue>(row.citation_json, null),
      stableCitationKey: row.stable_citation_key,
      syncId: row.sync_id,
      lastEditedAt: parseDate(row.last_edited_at),
      matchReasons,
      lanes,
    };
  }

  private visibleChunks(
    connectionId: string,
    sourceKey: string | null,
    currentRunId: string | null,
    includeDeleted: boolean,
  ): VisibleChunkRow[] {
    return this.db
      .prepare(
        `
        SELECT
          c.*,
          d.external_id,
          d.title,
          d.path,
          d.url,
          d.raw_path,
          d.last_edited_at
        FROM context_evidence_chunks c
        JOIN context_evidence_documents d ON d.id = c.document_id
        WHERE d.connection_id = @connectionId
          AND (@sourceKey IS NULL OR d.source_key = @sourceKey)
          AND (@includeDeleted = 1 OR d.deleted_at IS NULL)
          AND (
            d.publish_state = 'published'
            OR (@currentRunId IS NOT NULL AND d.run_id = @currentRunId AND d.publish_state = 'pending')
          )
        ORDER BY d.created_at ASC, c.ordinal ASC
      `,
      )
      .all({
        connectionId,
        sourceKey,
        currentRunId,
        includeDeleted: includeDeleted ? 1 : 0,
      }) as VisibleChunkRow[];
  }

  private visibleDocument(
    connectionId: string,
    sourceKey: string,
    documentId: string,
    currentRunId: string | null,
  ): DocumentRow | null {
    return (
      (this.db
        .prepare(
          `
          SELECT * FROM context_evidence_documents
          WHERE id = ?
            AND connection_id = ?
            AND source_key = ?
            AND deleted_at IS NULL
            AND (
              publish_state = 'published'
              OR (? IS NOT NULL AND run_id = ? AND publish_state = 'pending')
            )
        `,
        )
        .get(documentId, connectionId, sourceKey, currentRunId, currentRunId) as DocumentRow | undefined) ?? null
    );
  }

  private readDocument(params: {
    documentId?: string;
    externalId?: string;
    connectionId: string;
    sourceKey: string;
    currentRunId: string | null;
  }): ContextEvidenceReadResult | null {
    const document = params.documentId
      ? this.visibleDocument(params.connectionId, params.sourceKey, params.documentId, params.currentRunId)
      : ((this.db
          .prepare(
            `
            SELECT * FROM context_evidence_documents
            WHERE connection_id = ?
              AND source_key = ?
              AND external_id = ?
              AND deleted_at IS NULL
              AND (
                publish_state = 'published'
                OR (? IS NOT NULL AND run_id = ? AND publish_state = 'pending')
              )
            ORDER BY CASE WHEN run_id = ? THEN 0 ELSE 1 END, updated_at DESC
          `,
          )
          .get(
            params.connectionId,
            params.sourceKey,
            params.externalId,
            params.currentRunId,
            params.currentRunId,
            params.currentRunId,
          ) as DocumentRow | undefined) ?? null);
    if (!document) {
      return null;
    }
    const chunks = this.db
      .prepare('SELECT * FROM context_evidence_chunks WHERE document_id = ? ORDER BY ordinal ASC')
      .all(document.id) as ChunkRow[];
    return {
      document: this.documentForRead(document),
      chunks: chunks.map((chunk) => this.chunkForRead(chunk)),
    };
  }

  private documentForRead(
    row: Pick<DocumentRow, 'id' | 'title' | 'path' | 'external_id' | 'url'>,
  ): ContextEvidenceReadResult['document'] {
    return {
      id: row.id,
      title: row.title,
      path: row.path,
      external_id: row.external_id,
      url: row.url,
    };
  }

  private chunkForRead(
    row: Pick<ChunkRow, 'id' | 'content' | 'citation_json'>,
  ): ContextEvidenceReadResult['chunks'][number] {
    return {
      id: row.id,
      content: row.content,
      citation: parseJson<JsonValue>(row.citation_json, null),
    };
  }

  private candidateForDedup(row: CandidateRow): ContextCandidateForDedup {
    return {
      id: row.id,
      candidateKey: row.candidate_key,
      topic: row.topic,
      assertion: row.assertion,
      promotionScore: row.promotion_score,
      createdAt: new Date(row.created_at),
      evidenceChunkIds: parseJson<string[]>(row.evidence_chunk_ids_json, []),
      evidenceRefs: parseJson<JsonValue>(row.evidence_refs_json, []),
      embedding: row.embedding_json,
      lane: row.lane === 'light' || row.lane === 'full' ? row.lane : null,
    };
  }

  private neighborRowsByExternalIds(
    args: {
      connectionId: string;
      sourceKey: string;
      relation: ContextEvidenceNeighborResult['relation'];
      limit: number;
      currentRunId?: string;
    },
    externalIds: string[],
  ): ContextEvidenceNeighborResult[] {
    if (externalIds.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `
        SELECT * FROM context_evidence_documents
        WHERE connection_id = ?
          AND source_key = ?
          AND external_id IN (${placeholders(externalIds)})
          AND deleted_at IS NULL
          AND (
            publish_state = 'published'
            OR (? IS NOT NULL AND run_id = ? AND publish_state = 'pending')
          )
        ORDER BY path ASC
        LIMIT ?
      `,
      )
      .all(
        args.connectionId,
        args.sourceKey,
        ...externalIds,
        args.currentRunId ?? null,
        args.currentRunId ?? null,
        args.limit,
      ) as DocumentRow[];
    return rows.map((row) => this.neighborResult(row, args.relation));
  }

  private neighborRowsByParent(
    args: {
      connectionId: string;
      sourceKey: string;
      relation: ContextEvidenceNeighborResult['relation'];
      limit: number;
      currentRunId?: string;
    },
    parentExternalId: string,
  ): ContextEvidenceNeighborResult[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM context_evidence_documents
        WHERE connection_id = ?
          AND source_key = ?
          AND external_parent_id = ?
          AND deleted_at IS NULL
          AND (
            publish_state = 'published'
            OR (? IS NOT NULL AND run_id = ? AND publish_state = 'pending')
          )
        ORDER BY path ASC
        LIMIT ?
      `,
      )
      .all(
        args.connectionId,
        args.sourceKey,
        parentExternalId,
        args.currentRunId ?? null,
        args.currentRunId ?? null,
        args.limit,
      ) as DocumentRow[];
    return rows.map((row) => this.neighborResult(row, args.relation));
  }

  private neighborResult(
    row: DocumentRow,
    relation: ContextEvidenceNeighborResult['relation'],
  ): ContextEvidenceNeighborResult {
    return {
      documentId: row.id,
      externalId: row.external_id,
      title: row.title,
      path: row.path,
      relation,
      url: row.url,
      lastEditedAt: parseDate(row.last_edited_at),
    };
  }
}
