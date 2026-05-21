import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { parseMetabaseMappingBootstrap, type MetabaseMappingBootstrap } from '../../../../context/project/mappings-yaml-schema.js';
import type { KtxLocalProject } from '../../../../context/project/project.js';
import type { DiscoveredMetabaseDatabase } from './mapping.js';
import type { MetabaseSourceState, MetabaseSourceStateReader, MetabaseSourceStateSelection } from './source-state-port.js';

type LocalMetabaseMappingSource = 'ktx.yaml' | 'refresh';

interface LocalMetabaseDiscoveryCacheOptions {
  dbPath: string;
  now?: () => Date;
}

export interface RefreshLocalMetabaseDiscoveredDatabasesInput {
  connectionId: string;
  discovered: DiscoveredMetabaseDatabase[];
}

export interface LocalMetabaseDiscoveredDatabaseRow extends DiscoveredMetabaseDatabase {
  updatedAt: string;
}

export interface LocalMetabaseMappingListRow {
  metabaseDatabaseId: number;
  metabaseDatabaseName: string | null;
  metabaseEngine: string | null;
  metabaseHost: string | null;
  metabaseDbName: string | null;
  targetConnectionId: string | null;
  syncEnabled: boolean;
  source: LocalMetabaseMappingSource;
}

interface DiscoveryRow {
  metabase_database_id: number;
  metabase_database_name: string;
  metabase_engine: string;
  metabase_host: string | null;
  metabase_db_name: string | null;
  updated_at: string;
}

function selectionState(bootstrap: MetabaseMappingBootstrap): MetabaseSourceStateSelection[] {
  return [
    ...bootstrap.selections.collections.map((id) => ({ selectionType: 'collection' as const, metabaseObjectId: id })),
    ...bootstrap.selections.items.map((id) => ({ selectionType: 'item' as const, metabaseObjectId: id })),
  ];
}

function configuredMappingIds(bootstrap: MetabaseMappingBootstrap): number[] {
  return [...new Set([...Object.keys(bootstrap.databaseMappings), ...Object.keys(bootstrap.syncEnabled)].map(Number))].sort(
    (left, right) => left - right,
  );
}

function discoveredRowToDatabase(row: DiscoveryRow): LocalMetabaseDiscoveredDatabaseRow {
  return {
    id: row.metabase_database_id,
    name: row.metabase_database_name,
    engine: row.metabase_engine,
    host: row.metabase_host,
    dbName: row.metabase_db_name,
    updatedAt: row.updated_at,
  };
}

function emptyMetabaseSourceState(): MetabaseSourceState {
  return {
    syncMode: 'ALL',
    selections: [],
    defaultTagNames: [],
    mappings: [],
  };
}

export class LocalMetabaseDiscoveryCache {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: LocalMetabaseDiscoveryCacheOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.now = options.now ?? (() => new Date());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_metabase_discovered_databases (
        metabase_connection_id TEXT NOT NULL,
        metabase_database_id INTEGER NOT NULL,
        metabase_database_name TEXT NOT NULL,
        metabase_engine TEXT NOT NULL,
        metabase_host TEXT,
        metabase_db_name TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (metabase_connection_id, metabase_database_id)
      );
    `);
  }

  async refreshDiscoveredDatabases(input: RefreshLocalMetabaseDiscoveredDatabasesInput): Promise<void> {
    const timestamp = this.now().toISOString();
    const refresh = this.db.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO local_metabase_discovered_databases (
          metabase_connection_id,
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          metabase_host,
          metabase_db_name,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metabase_connection_id, metabase_database_id) DO UPDATE SET
          metabase_database_name = excluded.metabase_database_name,
          metabase_engine = excluded.metabase_engine,
          metabase_host = excluded.metabase_host,
          metabase_db_name = excluded.metabase_db_name,
          updated_at = excluded.updated_at
      `);

      for (const database of input.discovered) {
        upsert.run(
          input.connectionId,
          database.id,
          database.name,
          database.engine,
          database.host,
          database.dbName,
          timestamp,
        );
      }
    });

    refresh();
  }

  async listDiscoveredDatabases(connectionId: string): Promise<LocalMetabaseDiscoveredDatabaseRow[]> {
    const rows = this.db
      .prepare(
        `
        SELECT
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          metabase_host,
          metabase_db_name,
          updated_at
        FROM local_metabase_discovered_databases
        WHERE metabase_connection_id = ?
        ORDER BY metabase_database_id
      `,
      )
      .all(connectionId) as DiscoveryRow[];
    return rows.map(discoveredRowToDatabase);
  }

  async getDiscoveredDatabase(
    connectionId: string,
    metabaseDatabaseId: number,
  ): Promise<LocalMetabaseDiscoveredDatabaseRow | null> {
    const row = this.db
      .prepare(
        `
        SELECT
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          metabase_host,
          metabase_db_name,
          updated_at
        FROM local_metabase_discovered_databases
        WHERE metabase_connection_id = ? AND metabase_database_id = ?
      `,
      )
      .get(connectionId, metabaseDatabaseId) as DiscoveryRow | undefined;
    return row ? discoveredRowToDatabase(row) : null;
  }
}

export class KtxYamlMetabaseSourceStateReader implements MetabaseSourceStateReader {
  constructor(
    private readonly project: Pick<KtxLocalProject, 'config'>,
    private readonly options: { discoveryCache?: LocalMetabaseDiscoveryCache } = {},
  ) {}

  async getSourceState(connectionId: string): Promise<MetabaseSourceState> {
    const connection = this.project.config.connections[connectionId];
    if (!connection || String(connection.driver ?? '').toLowerCase() !== 'metabase') {
      return emptyMetabaseSourceState();
    }

    const bootstrap = parseMetabaseMappingBootstrap(connectionId, connection);
    const discovered = new Map(
      (await this.options.discoveryCache?.listDiscoveredDatabases(connectionId))?.map((database) => [database.id, database]) ??
        [],
    );

    return {
      syncMode: bootstrap.syncMode,
      selections: selectionState(bootstrap),
      defaultTagNames: bootstrap.defaultTagNames,
      mappings: configuredMappingIds(bootstrap).map((id) => {
        const metadata = discovered.get(id);
        return {
          metabaseDatabaseId: id,
          metabaseDatabaseName: metadata?.name ?? null,
          metabaseEngine: metadata?.engine ?? null,
          metabaseHost: metadata?.host ?? null,
          metabaseDbName: metadata?.dbName ?? null,
          targetConnectionId: bootstrap.databaseMappings[String(id)] ?? null,
          syncEnabled: bootstrap.syncEnabled[String(id)] ?? false,
        };
      }),
    };
  }

  async listDatabaseMappings(connectionId: string): Promise<LocalMetabaseMappingListRow[]> {
    const state = await this.getSourceState(connectionId);
    const configuredRows: LocalMetabaseMappingListRow[] = state.mappings.map((mapping) => ({
      metabaseDatabaseId: mapping.metabaseDatabaseId,
      metabaseDatabaseName: mapping.metabaseDatabaseName,
      metabaseEngine: mapping.metabaseEngine,
      metabaseHost: mapping.metabaseHost ?? null,
      metabaseDbName: mapping.metabaseDbName ?? null,
      targetConnectionId: mapping.targetConnectionId,
      syncEnabled: mapping.syncEnabled,
      source: 'ktx.yaml',
    }));

    const configuredIds = new Set(configuredRows.map((row) => row.metabaseDatabaseId));
    const discoveredRows =
      (await this.options.discoveryCache?.listDiscoveredDatabases(connectionId))?.filter(
        (database) => !configuredIds.has(database.id),
      ) ?? [];
    return [
      ...configuredRows,
      ...discoveredRows.map((database) => ({
        metabaseDatabaseId: database.id,
        metabaseDatabaseName: database.name,
        metabaseEngine: database.engine,
        metabaseHost: database.host,
        metabaseDbName: database.dbName,
        targetConnectionId: null,
        syncEnabled: false,
        source: 'refresh' as const,
      })),
    ].sort((left, right) => left.metabaseDatabaseId - right.metabaseDatabaseId);
  }
}
