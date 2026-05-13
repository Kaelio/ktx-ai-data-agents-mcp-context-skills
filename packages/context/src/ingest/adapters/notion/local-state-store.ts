import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

interface LocalNotionRuntimeStoreOptions {
  dbPath: string;
  now?: () => Date;
}

export class LocalNotionRuntimeStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: LocalNotionRuntimeStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.now = options.now ?? (() => new Date());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_notion_runtime_config (
        notion_connection_id TEXT PRIMARY KEY,
        last_successful_cursor TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async readCursor(notionConnectionId: string): Promise<string | null> {
    const row = this.db
      .prepare(
        `
        SELECT last_successful_cursor
        FROM local_notion_runtime_config
        WHERE notion_connection_id = ?
      `,
      )
      .get(notionConnectionId) as { last_successful_cursor: string | null } | undefined;

    return row?.last_successful_cursor ?? null;
  }

  async setCursor(notionConnectionId: string, cursor: string | null): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO local_notion_runtime_config (
          notion_connection_id,
          last_successful_cursor,
          updated_at
        )
        VALUES (?, ?, ?)
        ON CONFLICT(notion_connection_id) DO UPDATE SET
          last_successful_cursor = excluded.last_successful_cursor,
          updated_at = excluded.updated_at
      `,
      )
      .run(notionConnectionId, cursor, this.now().toISOString());
  }
}
