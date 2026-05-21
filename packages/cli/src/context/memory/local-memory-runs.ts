import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { MemoryRunRecord, MemoryRunStatus, MemoryRunStorePort } from './memory-runs.js';
import type { MemoryAgentResult } from './types.js';

export interface LocalMemoryRunStoreOptions {
  projectDir: string;
  idFactory?: () => string;
}

type MemoryRunRow = {
  id: string;
  status: string;
  stage: string;
  input_hash: string;
  chat_id: string | null;
  output_summary_json: string | null;
  error: string | null;
};

function localMemoryDbPath(projectDir: string): string {
  return join(projectDir, '.ktx', 'db.sqlite');
}

function isSafeRunId(runId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runId);
}

function isMemoryRunStatus(value: unknown): value is MemoryRunStatus {
  return value === 'running' || value === 'done' || value === 'error';
}

function parseOutputSummary(raw: string | null): MemoryAgentResult | null {
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as MemoryAgentResult;
}

function rowToRecord(row: MemoryRunRow): MemoryRunRecord | null {
  if (!isMemoryRunStatus(row.status)) {
    return null;
  }
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    inputHash: row.input_hash,
    chatId: row.chat_id,
    outputSummary: parseOutputSummary(row.output_summary_json),
    error: row.error,
  };
}

export class LocalMemoryRunStore implements MemoryRunStorePort {
  private readonly db: Database.Database;
  private readonly idFactory: () => string;

  constructor(options: LocalMemoryRunStoreOptions) {
    const dbPath = localMemoryDbPath(options.projectDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_memory_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        chat_id TEXT,
        output_summary_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS local_memory_runs_status_updated_idx
        ON local_memory_runs (status, updated_at DESC);
    `);
    this.idFactory = options.idFactory ?? (() => `memory-${randomUUID()}`);
  }

  async createRunning(args: { inputHash: string; chatId?: string | null }): Promise<{ id: string }> {
    const now = new Date().toISOString();
    const id = this.idFactory();
    this.db
      .prepare(
        `
        INSERT INTO local_memory_runs (
          id,
          status,
          stage,
          input_hash,
          chat_id,
          output_summary_json,
          error,
          created_at,
          updated_at
        )
        VALUES (
          @id,
          'running',
          'queued',
          @inputHash,
          @chatId,
          NULL,
          NULL,
          @now,
          @now
        )
      `,
      )
      .run({
        id,
        inputHash: args.inputHash,
        chatId: args.chatId ?? null,
        now,
      });
    return { id };
  }

  async markRunning(id: string, stage: string): Promise<void> {
    this.updateRun(id, {
      status: 'running',
      stage,
      outputSummaryJson: null,
      error: null,
    });
  }

  async markDone(id: string, outputSummary: MemoryAgentResult): Promise<void> {
    this.updateRun(id, {
      status: 'done',
      stage: 'done',
      outputSummaryJson: JSON.stringify(outputSummary),
      error: null,
    });
  }

  async markError(id: string, error: string): Promise<void> {
    this.updateRun(id, {
      status: 'error',
      stage: 'error',
      outputSummaryJson: null,
      error,
    });
  }

  async findById(id: string): Promise<MemoryRunRecord | null> {
    if (!isSafeRunId(id)) {
      return null;
    }
    const row = this.db
      .prepare(
        `
        SELECT
          id,
          status,
          stage,
          input_hash,
          chat_id,
          output_summary_json,
          error
        FROM local_memory_runs
        WHERE id = ?
      `,
      )
      .get(id) as MemoryRunRow | undefined;

    return row ? rowToRecord(row) : null;
  }

  private updateRun(
    id: string,
    input: {
      status: MemoryRunStatus;
      stage: string;
      outputSummaryJson: string | null;
      error: string | null;
    },
  ): void {
    const result = this.db
      .prepare(
        `
        UPDATE local_memory_runs
        SET
          status = @status,
          stage = @stage,
          output_summary_json = @outputSummaryJson,
          error = @error,
          updated_at = @updatedAt
        WHERE id = @id
      `,
      )
      .run({
        id,
        status: input.status,
        stage: input.stage,
        outputSummaryJson: input.outputSummaryJson,
        error: input.error,
        updatedAt: new Date().toISOString(),
      });

    if (result.changes === 0) {
      throw new Error(`Memory run not found: ${id}`);
    }
  }
}
