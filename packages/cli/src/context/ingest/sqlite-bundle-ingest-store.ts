import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { CanonicalPin } from './canonical-pins.js';
import type {
  CreateIngestRunArgs,
  IngestCanonicalPinsPort,
  IngestProvenanceInsert,
  IngestProvenancePort,
  IngestProvenanceRow,
  IngestReportsPort,
  IngestRunRecord,
  IngestRunsPort,
  ProvenanceActionType,
} from './ports.js';
import type { IngestReportBody, IngestReportSnapshot } from './reports.js';
import type { IngestDiffSummary } from './types.js';

export interface SqliteBundleIngestStoreOptions {
  dbPath: string;
  idFactory?: () => string;
  now?: () => Date;
}

type RunStatus = 'running' | 'completed' | 'failed';

interface ReportRow {
  id: string;
  run_id: string;
  job_id: string;
  connection_id: string;
  source_key: string;
  body_json: string;
  created_at: string;
}

interface ProvenanceRow {
  sync_id: string;
  raw_path: string;
  raw_content_hash: string;
  artifact_kind: string | null;
  artifact_key: string | null;
  target_connection_id: string | null;
  artifact_content_hash: string | null;
  action_type: string;
}

interface ProvenanceHashCandidateRow {
  raw_path: string;
  raw_content_hash: string;
  action_type: string;
  report_body_json: string | null;
}

function parseArtifactKind(kind: string | null): IngestProvenanceRow['artifact_kind'] {
  if (kind === null || kind === 'sl' || kind === 'wiki') {
    return kind;
  }
  throw new Error(`Unexpected local ingest artifact kind: ${kind}`);
}

function parseActionType(action: string): ProvenanceActionType {
  switch (action) {
    case 'source_created':
    case 'measure_added':
    case 'join_added':
    case 'merged':
    case 'subsumed':
    case 'wiki_written':
    case 'skipped':
      return action;
    default:
      throw new Error(`Unexpected local ingest provenance action type: ${action}`);
  }
}

function parseReport(row: ReportRow): IngestReportSnapshot {
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    connectionId: row.connection_id,
    sourceKey: row.source_key,
    body: JSON.parse(row.body_json) as IngestReportBody,
    createdAt: row.created_at,
  };
}

function toPortProvenanceRow(row: ProvenanceRow): IngestProvenanceRow {
  return {
    sync_id: row.sync_id,
    raw_path: row.raw_path,
    raw_content_hash: row.raw_content_hash,
    artifact_kind: parseArtifactKind(row.artifact_kind),
    artifact_key: row.artifact_key,
    target_connection_id: row.target_connection_id,
    artifact_content_hash: row.artifact_content_hash,
    action_type: parseActionType(row.action_type),
  };
}

function recordValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function isSuccessfulNoOutputSkippedBaseline(reportBodyJson: string | null): boolean {
  if (reportBodyJson === null) {
    return true;
  }
  const body = JSON.parse(reportBodyJson) as unknown;
  const workUnits = recordValue(body, 'workUnits');
  const failedWorkUnits = recordValue(body, 'failedWorkUnits');
  return (
    Array.isArray(workUnits) &&
    workUnits.length > 0 &&
    Array.isArray(failedWorkUnits) &&
    failedWorkUnits.length === 0
  );
}

function isProcessedHashBaseline(row: ProvenanceHashCandidateRow): boolean {
  return row.action_type !== 'skipped' || isSuccessfulNoOutputSkippedBaseline(row.report_body_json);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export class SqliteBundleIngestStore
  implements IngestRunsPort, IngestReportsPort, IngestProvenancePort, IngestCanonicalPinsPort
{
  private readonly db: Database.Database;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: SqliteBundleIngestStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bundle_ingest_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        scope_fingerprint TEXT,
        status TEXT NOT NULL,
        diff_summary_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        failed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS bundle_ingest_runs_completed_lookup_idx
        ON bundle_ingest_runs (connection_id, source_key, sync_id, status, completed_at DESC);

      CREATE TABLE IF NOT EXISTS bundle_ingest_reports (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES bundle_ingest_runs(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS bundle_ingest_reports_run_idx
        ON bundle_ingest_reports (run_id);

      CREATE TABLE IF NOT EXISTS bundle_ingest_provenance (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        raw_path TEXT NOT NULL,
        raw_content_hash TEXT NOT NULL,
        artifact_kind TEXT,
        artifact_key TEXT,
        target_connection_id TEXT,
        artifact_content_hash TEXT,
        action_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS bundle_ingest_provenance_latest_idx
        ON bundle_ingest_provenance (connection_id, source_key, raw_path, sync_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS bundle_ingest_canonical_pins (
        connection_id TEXT NOT NULL,
        contested_key TEXT NOT NULL,
        canonical_artifact_key TEXT NOT NULL,
        pinned_at TEXT NOT NULL,
        pinned_by TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, contested_key)
      );
    `);
    this.ensureColumn('bundle_ingest_provenance', 'target_connection_id', 'TEXT');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((existing) => existing.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }

  async create(args: CreateIngestRunArgs): Promise<IngestRunRecord>;
  async create(args: {
    runId: string;
    jobId: string;
    connectionId: string;
    sourceKey: string;
    body: unknown;
  }): Promise<IngestReportSnapshot>;
  async create(
    args:
      | CreateIngestRunArgs
      | {
          runId: string;
          jobId: string;
          connectionId: string;
          sourceKey: string;
          body: unknown;
        },
  ): Promise<IngestRunRecord | IngestReportSnapshot> {
    if ('body' in args) {
      return this.createReport(args);
    }
    return this.createRun(args);
  }

  async markCompleted(id: string, diffSummary: IngestDiffSummary): Promise<void> {
    this.markRun(id, 'completed', diffSummary);
  }

  async markFailed(id: string): Promise<void> {
    this.markRun(id, 'failed', null);
  }

  async insertMany(rows: IngestProvenanceInsert[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const insert = this.db.prepare(`
      INSERT INTO bundle_ingest_provenance (
        id,
        connection_id,
        source_key,
        sync_id,
        raw_path,
        raw_content_hash,
        artifact_kind,
        artifact_key,
        target_connection_id,
        artifact_content_hash,
        action_type,
        created_at
      )
      VALUES (
        @id,
        @connectionId,
        @sourceKey,
        @syncId,
        @rawPath,
        @rawContentHash,
        @artifactKind,
        @artifactKey,
        @targetConnectionId,
        @artifactContentHash,
        @actionType,
        @createdAt
      )
    `);
    const createdAt = this.now().toISOString();
    const save = this.db.transaction((inputRows: IngestProvenanceInsert[]) => {
      for (const row of inputRows) {
        insert.run({
          id: this.idFactory(),
          connectionId: row.connectionId,
          sourceKey: row.sourceKey,
          syncId: row.syncId,
          rawPath: row.rawPath,
          rawContentHash: row.rawContentHash,
          artifactKind: row.artifactKind,
          artifactKey: row.artifactKey,
          targetConnectionId: row.targetConnectionId ?? null,
          artifactContentHash: row.artifactContentHash,
          actionType: row.actionType,
          createdAt,
        });
      }
    });
    save(rows);
  }

  async findLatestHashesForCompletedSyncs(connectionId: string, sourceKey: string): Promise<Map<string, string>> {
    const rows = this.db
      .prepare(
        `
        SELECT
          p.raw_path,
          p.raw_content_hash,
          p.action_type,
          br.body_json AS report_body_json
        FROM bundle_ingest_provenance p
        INNER JOIN bundle_ingest_runs r
          ON r.connection_id = p.connection_id
          AND r.source_key = p.source_key
          AND r.sync_id = p.sync_id
        LEFT JOIN bundle_ingest_reports br
          ON br.run_id = r.id
        WHERE p.connection_id = ?
          AND p.source_key = ?
          AND r.status = 'completed'
        ORDER BY r.completed_at DESC, r.rowid DESC, p.created_at DESC, p.rowid DESC
      `,
      )
      .all(connectionId, sourceKey) as ProvenanceHashCandidateRow[];

    const latest = new Map<string, string>();
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.raw_path)) {
        continue;
      }
      seen.add(row.raw_path);
      if (isProcessedHashBaseline(row)) {
        latest.set(row.raw_path, row.raw_content_hash);
      }
    }
    return latest;
  }

  async findLatestArtifactsForRawPaths(
    connectionId: string,
    sourceKey: string,
    rawPaths: string[],
  ): Promise<Map<string, IngestProvenanceRow[]>> {
    if (rawPaths.length === 0) {
      return new Map();
    }
    const rows = this.db
      .prepare(
        `
        SELECT
          p.sync_id,
          p.raw_path,
          p.raw_content_hash,
          p.artifact_kind,
          p.artifact_key,
          p.target_connection_id,
          p.artifact_content_hash,
          p.action_type
        FROM bundle_ingest_provenance p
        INNER JOIN bundle_ingest_runs r
          ON r.connection_id = p.connection_id
          AND r.source_key = p.source_key
          AND r.sync_id = p.sync_id
        WHERE p.connection_id = ?
          AND p.source_key = ?
          AND p.raw_path IN (${placeholders(rawPaths)})
          AND r.status = 'completed'
        ORDER BY r.completed_at DESC, r.rowid DESC, p.created_at DESC, p.rowid DESC
      `,
      )
      .all(connectionId, sourceKey, ...rawPaths) as ProvenanceRow[];

    const selectedSyncByPath = new Map<string, string>();
    const result = new Map<string, IngestProvenanceRow[]>();
    for (const row of rows) {
      if (!selectedSyncByPath.has(row.raw_path)) {
        selectedSyncByPath.set(row.raw_path, row.sync_id);
      }
      if (selectedSyncByPath.get(row.raw_path) !== row.sync_id) {
        continue;
      }
      const group = result.get(row.raw_path) ?? [];
      group.push(toPortProvenanceRow(row));
      result.set(row.raw_path, group);
    }
    return result;
  }

  async findByJobId(jobId: string): Promise<IngestReportSnapshot | null> {
    const row = this.db
      .prepare(
        `
        SELECT id, run_id, job_id, connection_id, source_key, body_json, created_at
        FROM bundle_ingest_reports
        WHERE job_id = ?
      `,
      )
      .get(jobId) as ReportRow | undefined;
    return row ? parseReport(row) : null;
  }

  async findReportByAnyId(id: string): Promise<IngestReportSnapshot | null> {
    const row = this.db
      .prepare(
        `
        SELECT id, run_id, job_id, connection_id, source_key, body_json, created_at
        FROM bundle_ingest_reports
        WHERE id = ?
          OR run_id = ?
          OR job_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `,
      )
      .get(id, id, id) as ReportRow | undefined;
    return row ? parseReport(row) : null;
  }

  async findLatestReport(): Promise<IngestReportSnapshot | null> {
    const row = this.db
      .prepare(
        `
        SELECT br.id, br.run_id, br.job_id, br.connection_id, br.source_key, br.body_json, br.created_at
        FROM bundle_ingest_reports br
        LEFT JOIN bundle_ingest_runs r
          ON r.id = br.run_id
        ORDER BY
          COALESCE(r.completed_at, r.failed_at, r.started_at, br.created_at) DESC,
          br.created_at DESC,
          br.rowid DESC
        LIMIT 1
      `,
      )
      .get() as ReportRow | undefined;
    return row ? parseReport(row) : null;
  }

  async markSuperseded(jobId: string, supersededByJobId: string): Promise<void> {
    const report = await this.findByJobId(jobId);
    if (!report) {
      return;
    }
    const nextBody = {
      ...report.body,
      supersededBy: supersededByJobId,
    };
    this.db
      .prepare('UPDATE bundle_ingest_reports SET body_json = ? WHERE job_id = ?')
      .run(JSON.stringify(nextBody), jobId);
  }

  async listPins(connectionIds: string[]): Promise<CanonicalPin[]> {
    if (connectionIds.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `
        SELECT contested_key, canonical_artifact_key, pinned_at, pinned_by, reason
        FROM bundle_ingest_canonical_pins
        WHERE connection_id IN (${placeholders(connectionIds)})
        ORDER BY contested_key ASC
      `,
      )
      .all(...connectionIds) as Array<{
      contested_key: string;
      canonical_artifact_key: string;
      pinned_at: string;
      pinned_by: string;
      reason: string | null;
    }>;
    return rows.map((row) => ({
      contestedKey: row.contested_key,
      canonicalArtifactKey: row.canonical_artifact_key,
      pinnedAt: row.pinned_at,
      pinnedBy: row.pinned_by,
      reason: row.reason,
    }));
  }

  async replaceCanonicalPins(connectionId: string, pins: CanonicalPin[]): Promise<void> {
    const createdAt = this.now().toISOString();
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM bundle_ingest_canonical_pins WHERE connection_id = ?').run(connectionId);
      const insert = this.db.prepare(`
        INSERT INTO bundle_ingest_canonical_pins (
          connection_id,
          contested_key,
          canonical_artifact_key,
          pinned_at,
          pinned_by,
          reason,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const pin of pins) {
        insert.run(
          connectionId,
          pin.contestedKey,
          pin.canonicalArtifactKey,
          pin.pinnedAt,
          pin.pinnedBy,
          pin.reason ?? null,
          createdAt,
        );
      }
    });
    replace();
  }

  private async createRun(args: CreateIngestRunArgs): Promise<IngestRunRecord> {
    const id = this.idFactory();
    const deletePrior = this.db.prepare('DELETE FROM bundle_ingest_runs WHERE job_id = ?');
    const insert = this.db.prepare(`
      INSERT INTO bundle_ingest_runs (
        id,
        job_id,
        connection_id,
        source_key,
        sync_id,
        trigger,
        scope_fingerprint,
        status,
        started_at
      )
      VALUES (
        @id,
        @jobId,
        @connectionId,
        @sourceKey,
        @syncId,
        @trigger,
        @scopeFingerprint,
        'running',
        @startedAt
      )
    `);
    const replace = this.db.transaction((row: Record<string, unknown>) => {
      deletePrior.run(args.jobId);
      insert.run(row);
    });
    replace({
      id,
      jobId: args.jobId,
      connectionId: args.connectionId,
      sourceKey: args.sourceKey,
      syncId: args.syncId,
      trigger: args.trigger,
      scopeFingerprint: args.scopeFingerprint ?? null,
      startedAt: this.now().toISOString(),
    });
    return { id };
  }

  private async createReport(args: {
    runId: string;
    jobId: string;
    connectionId: string;
    sourceKey: string;
    body: unknown;
  }): Promise<IngestReportSnapshot> {
    const id = this.idFactory();
    const createdAt = this.now().toISOString();
    const body = args.body as IngestReportBody;
    this.db
      .prepare(
        `
        INSERT INTO bundle_ingest_reports (
          id,
          run_id,
          job_id,
          connection_id,
          source_key,
          body_json,
          created_at
        )
        VALUES (
          @id,
          @runId,
          @jobId,
          @connectionId,
          @sourceKey,
          @bodyJson,
          @createdAt
        )
        ON CONFLICT(job_id) DO UPDATE SET
          run_id = excluded.run_id,
          connection_id = excluded.connection_id,
          source_key = excluded.source_key,
          body_json = excluded.body_json,
          created_at = excluded.created_at
      `,
      )
      .run({
        id,
        runId: args.runId,
        jobId: args.jobId,
        connectionId: args.connectionId,
        sourceKey: args.sourceKey,
        bodyJson: JSON.stringify(body),
        createdAt,
      });
    return {
      id,
      runId: args.runId,
      jobId: args.jobId,
      connectionId: args.connectionId,
      sourceKey: args.sourceKey,
      body,
      createdAt,
    };
  }

  private markRun(id: string, status: RunStatus, diffSummary: IngestDiffSummary | null): void {
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `
        UPDATE bundle_ingest_runs
        SET
          status = @status,
          diff_summary_json = @diffSummaryJson,
          completed_at = CASE WHEN @status = 'completed' THEN @timestamp ELSE completed_at END,
          failed_at = CASE WHEN @status = 'failed' THEN @timestamp ELSE failed_at END
        WHERE id = @id
      `,
      )
      .run({
        id,
        status,
        diffSummaryJson: diffSummary ? JSON.stringify(diffSummary) : null,
        timestamp,
      });
  }
}
