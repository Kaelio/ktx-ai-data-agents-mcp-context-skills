import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { LookerWarehouseConnectionInfo } from './client.js';
import type { LookerConnectionMapping } from './mapping.js';
import type { LookerRuntimeCursors } from './types.js';

type LocalLookerMappingSource = 'ktx.yaml' | 'cli' | 'refresh';

interface LocalLookerRuntimeStoreOptions {
  dbPath: string;
  now?: () => Date;
}

export interface LocalLookerConnectionMappingListRow extends LookerConnectionMapping {
  source: LocalLookerMappingSource;
}

export interface UpsertLocalLookerConnectionMappingInput {
  lookerConnectionId: string;
  lookerConnectionName: string;
  ktxConnectionId: string | null;
  source: LocalLookerMappingSource;
}

interface ApplyLocalLookerYamlBootstrapInput {
  lookerConnectionId: string;
  mappings: Array<{
    lookerConnectionName: string;
    ktxConnectionId: string | null;
  }>;
}

export interface RefreshLocalLookerDiscoveredConnectionsInput {
  lookerConnectionId: string;
  discovered: LookerWarehouseConnectionInfo[];
}

export interface ClearLocalLookerMappingsInput {
  lookerConnectionId: string;
  lookerConnectionName?: string;
}

interface LookerSourceStateReader {
  readMappings(lookerConnectionId: string): Promise<LookerConnectionMapping[]>;
  readCursors(lookerConnectionId: string): Promise<LookerRuntimeCursors>;
}

export class LocalLookerRuntimeStore implements LookerSourceStateReader {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: LocalLookerRuntimeStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.now = options.now ?? (() => new Date());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_looker_runtime_config (
        looker_connection_id TEXT PRIMARY KEY,
        dashboards_last_synced_at TEXT,
        looks_last_synced_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_looker_connection_mappings (
        looker_connection_id TEXT NOT NULL,
        looker_connection_name TEXT NOT NULL,
        ktx_connection_id TEXT,
        looker_host TEXT,
        looker_database TEXT,
        looker_dialect TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (looker_connection_id, looker_connection_name)
      );
    `);
  }

  async applyYamlBootstrap(input: ApplyLocalLookerYamlBootstrapInput): Promise<void> {
    const timestamp = this.now().toISOString();
    const apply = this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT ktx_connection_id, source
        FROM local_looker_connection_mappings
        WHERE looker_connection_id = ? AND looker_connection_name = ?
      `);
      const insert = this.db.prepare(`
        INSERT INTO local_looker_connection_mappings (
          looker_connection_id,
          looker_connection_name,
          ktx_connection_id,
          looker_host,
          looker_database,
          looker_dialect,
          source,
          updated_at
        )
        VALUES (?, ?, ?, NULL, NULL, NULL, 'ktx.yaml', ?)
      `);
      const updateRefreshRow = this.db.prepare(`
        UPDATE local_looker_connection_mappings
        SET ktx_connection_id = ?,
            source = 'ktx.yaml',
            updated_at = ?
        WHERE looker_connection_id = ?
          AND looker_connection_name = ?
          AND source = 'refresh'
          AND ktx_connection_id IS NULL
      `);

      for (const mapping of input.mappings) {
        const row = existing.get(input.lookerConnectionId, mapping.lookerConnectionName) as
          | { ktx_connection_id: string | null; source: LocalLookerMappingSource }
          | undefined;
        if (!row) {
          insert.run(input.lookerConnectionId, mapping.lookerConnectionName, mapping.ktxConnectionId, timestamp);
          continue;
        }
        if (row.source === 'refresh' && row.ktx_connection_id === null) {
          updateRefreshRow.run(mapping.ktxConnectionId, timestamp, input.lookerConnectionId, mapping.lookerConnectionName);
        }
      }
    });

    apply();
  }

  async readCursors(lookerConnectionId: string): Promise<LookerRuntimeCursors> {
    const row = this.db
      .prepare(
        `
        SELECT dashboards_last_synced_at, looks_last_synced_at
        FROM local_looker_runtime_config
        WHERE looker_connection_id = ?
      `,
      )
      .get(lookerConnectionId) as { dashboards_last_synced_at: string | null; looks_last_synced_at: string | null } | undefined;

    return {
      dashboardsLastSyncedAt: row?.dashboards_last_synced_at ?? null,
      looksLastSyncedAt: row?.looks_last_synced_at ?? null,
    };
  }

  async setCursors(lookerConnectionId: string, cursors: LookerRuntimeCursors): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO local_looker_runtime_config (
          looker_connection_id,
          dashboards_last_synced_at,
          looks_last_synced_at,
          updated_at
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(looker_connection_id) DO UPDATE SET
          dashboards_last_synced_at = excluded.dashboards_last_synced_at,
          looks_last_synced_at = excluded.looks_last_synced_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(lookerConnectionId, cursors.dashboardsLastSyncedAt, cursors.looksLastSyncedAt, this.now().toISOString());
  }

  async readMappings(lookerConnectionId: string): Promise<LookerConnectionMapping[]> {
    return (await this.listConnectionMappings(lookerConnectionId)).map(({ source: _source, ...mapping }) => mapping);
  }

  async listConnectionMappings(lookerConnectionId: string): Promise<LocalLookerConnectionMappingListRow[]> {
    const rows = this.db
      .prepare(
        `
        SELECT
          looker_connection_name,
          ktx_connection_id,
          looker_host,
          looker_database,
          looker_dialect,
          source
        FROM local_looker_connection_mappings
        WHERE looker_connection_id = ?
        ORDER BY looker_connection_name
      `,
      )
      .all(lookerConnectionId) as Array<{
      looker_connection_name: string;
      ktx_connection_id: string | null;
      looker_host: string | null;
      looker_database: string | null;
      looker_dialect: string | null;
      source: LocalLookerMappingSource;
    }>;

    return rows.map((row) => ({
      lookerConnectionName: row.looker_connection_name,
      ktxConnectionId: row.ktx_connection_id,
      lookerHost: row.looker_host,
      lookerDatabase: row.looker_database,
      lookerDialect: row.looker_dialect,
      source: row.source,
    }));
  }

  async upsertConnectionMapping(input: UpsertLocalLookerConnectionMappingInput): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO local_looker_connection_mappings (
          looker_connection_id,
          looker_connection_name,
          ktx_connection_id,
          looker_host,
          looker_database,
          looker_dialect,
          source,
          updated_at
        )
        VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(looker_connection_id, looker_connection_name) DO UPDATE SET
          ktx_connection_id = excluded.ktx_connection_id,
          source = excluded.source,
          updated_at = excluded.updated_at
      `,
      )
      .run(input.lookerConnectionId, input.lookerConnectionName, input.ktxConnectionId, input.source, this.now().toISOString());
  }

  async refreshDiscoveredConnections(input: RefreshLocalLookerDiscoveredConnectionsInput): Promise<void> {
    const timestamp = this.now().toISOString();
    const update = this.db.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO local_looker_connection_mappings (
          looker_connection_id,
          looker_connection_name,
          ktx_connection_id,
          looker_host,
          looker_database,
          looker_dialect,
          source,
          updated_at
        )
        VALUES (?, ?, NULL, ?, ?, ?, 'refresh', ?)
        ON CONFLICT(looker_connection_id, looker_connection_name) DO UPDATE SET
          looker_host = excluded.looker_host,
          looker_database = excluded.looker_database,
          looker_dialect = excluded.looker_dialect,
          source = excluded.source,
          updated_at = excluded.updated_at
      `);
      for (const connection of input.discovered) {
        upsert.run(
          input.lookerConnectionId,
          connection.name,
          connection.host,
          connection.database,
          connection.dialect,
          timestamp,
        );
      }
    });
    update();
  }

  async clearConnectionMappings(input: ClearLocalLookerMappingsInput): Promise<void> {
    if (input.lookerConnectionName) {
      this.db
        .prepare(
          `
          DELETE FROM local_looker_connection_mappings
          WHERE looker_connection_id = ? AND looker_connection_name = ?
        `,
        )
        .run(input.lookerConnectionId, input.lookerConnectionName);
      return;
    }
    this.db.prepare('DELETE FROM local_looker_connection_mappings WHERE looker_connection_id = ?').run(input.lookerConnectionId);
  }
}
