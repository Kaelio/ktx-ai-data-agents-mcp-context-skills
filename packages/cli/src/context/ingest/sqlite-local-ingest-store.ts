import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { LocalIngestReport, LocalIngestRunRecord } from './local-stage-ingest.js';

export interface SqliteLocalIngestStoreOptions {
  dbPath: string;
}

export interface SaveCompletedLocalIngestRunInput {
  record: LocalIngestRunRecord;
  rawContentHashes: Record<string, string>;
}

interface FindLatestCompletedLocalIngestReportOptions {
  excludeRunId?: string;
}

interface JsonRow {
  body_json: string;
}

function isSafeRunId(runId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runId);
}

function parseRunRecord(raw: string): LocalIngestRunRecord | null {
  const parsed = JSON.parse(raw) as Partial<LocalIngestRunRecord>;
  if (
    typeof parsed.runId !== 'string' ||
    typeof parsed.jobId !== 'string' ||
    (parsed.status !== 'running' && parsed.status !== 'done' && parsed.status !== 'error') ||
    typeof parsed.adapter !== 'string' ||
    typeof parsed.connectionId !== 'string' ||
    typeof parsed.syncId !== 'string'
  ) {
    return null;
  }
  return parsed as LocalIngestRunRecord;
}

function parseReport(raw: string): LocalIngestReport | null {
  const parsed = JSON.parse(raw) as Partial<LocalIngestReport>;
  if (
    typeof parsed.runId !== 'string' ||
    parsed.status !== 'done' ||
    typeof parsed.adapter !== 'string' ||
    typeof parsed.connectionId !== 'string' ||
    typeof parsed.completedAt !== 'string' ||
    typeof parsed.rawContentHashes !== 'object' ||
    parsed.rawContentHashes === null ||
    Array.isArray(parsed.rawContentHashes)
  ) {
    return null;
  }
  return parsed as LocalIngestReport;
}

export class SqliteLocalIngestStore {
  private readonly db: Database.Database;

  constructor(options: SqliteLocalIngestStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_ingest_runs (
        run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        adapter TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS local_ingest_runs_connection_adapter_idx
        ON local_ingest_runs (connection_id, adapter, completed_at DESC);

      CREATE TABLE IF NOT EXISTS local_ingest_reports (
        run_id TEXT PRIMARY KEY REFERENCES local_ingest_runs(run_id) ON DELETE CASCADE,
        adapter TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        raw_content_hashes_json TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS local_ingest_reports_latest_completed_idx
        ON local_ingest_reports (connection_id, adapter, status, completed_at DESC, run_id DESC);
    `);
  }

  saveCompletedRun(input: SaveCompletedLocalIngestRunInput): void {
    const report: LocalIngestReport = {
      ...input.record,
      rawContentHashes: input.rawContentHashes,
    };
    const runBody = JSON.stringify(input.record);
    const reportBody = JSON.stringify(report);
    const rawContentHashesJson = JSON.stringify(input.rawContentHashes);

    const save = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO local_ingest_runs (
            run_id,
            job_id,
            status,
            adapter,
            connection_id,
            sync_id,
            started_at,
            completed_at,
            body_json
          )
          VALUES (
            @runId,
            @jobId,
            @status,
            @adapter,
            @connectionId,
            @syncId,
            @startedAt,
            @completedAt,
            @bodyJson
          )
          ON CONFLICT(run_id) DO UPDATE SET
            job_id = excluded.job_id,
            status = excluded.status,
            adapter = excluded.adapter,
            connection_id = excluded.connection_id,
            sync_id = excluded.sync_id,
            started_at = excluded.started_at,
            completed_at = excluded.completed_at,
            body_json = excluded.body_json
        `,
        )
        .run({
          runId: input.record.runId,
          jobId: input.record.jobId,
          status: input.record.status,
          adapter: input.record.adapter,
          connectionId: input.record.connectionId,
          syncId: input.record.syncId,
          startedAt: input.record.startedAt,
          completedAt: input.record.completedAt,
          bodyJson: runBody,
        });

      this.db
        .prepare(
          `
          INSERT INTO local_ingest_reports (
            run_id,
            adapter,
            connection_id,
            status,
            completed_at,
            raw_content_hashes_json,
            body_json
          )
          VALUES (
            @runId,
            @adapter,
            @connectionId,
            @status,
            @completedAt,
            @rawContentHashesJson,
            @bodyJson
          )
          ON CONFLICT(run_id) DO UPDATE SET
            adapter = excluded.adapter,
            connection_id = excluded.connection_id,
            status = excluded.status,
            completed_at = excluded.completed_at,
            raw_content_hashes_json = excluded.raw_content_hashes_json,
            body_json = excluded.body_json
        `,
        )
        .run({
          runId: report.runId,
          adapter: report.adapter,
          connectionId: report.connectionId,
          status: report.status,
          completedAt: report.completedAt,
          rawContentHashesJson,
          bodyJson: reportBody,
        });
    });

    save();
  }

  findRunById(runId: string): LocalIngestRunRecord | null {
    if (!isSafeRunId(runId)) {
      return null;
    }
    const row = this.db
      .prepare('SELECT body_json FROM local_ingest_runs WHERE run_id = ?')
      .get(runId) as JsonRow | undefined;
    return row ? parseRunRecord(row.body_json) : null;
  }

  findLatestCompletedReport(
    connectionId: string,
    adapter: string,
    options: FindLatestCompletedLocalIngestReportOptions = {},
  ): LocalIngestReport | null {
    const excludeCurrentRunClause = options.excludeRunId ? 'AND run_id <> ?' : '';
    const params = options.excludeRunId ? [connectionId, adapter, options.excludeRunId] : [connectionId, adapter];
    const row = this.db
      .prepare(
        `
        SELECT body_json
        FROM local_ingest_reports
        WHERE connection_id = ?
          AND adapter = ?
          AND status = 'done'
          ${excludeCurrentRunClause}
        ORDER BY completed_at DESC, run_id DESC
        LIMIT 1
      `,
      )
      .get(...params) as JsonRow | undefined;
    return row ? parseReport(row.body_json) : null;
  }
}
