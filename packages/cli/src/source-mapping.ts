import { localConnectionToWarehouseDescriptor } from './context/connections/local-warehouse-descriptor.js';
import { DEFAULT_METABASE_CLIENT_CONFIG, DefaultMetabaseConnectionClientFactory } from './context/ingest/adapters/metabase/client.js';
import { DefaultLookerConnectionClientFactory } from './context/ingest/adapters/looker/factory.js';
import { KtxYamlMetabaseSourceStateReader, LocalMetabaseDiscoveryCache, type LocalMetabaseMappingListRow } from './context/ingest/adapters/metabase/local-source-state-store.js';
import { LocalLookerRuntimeStore } from './context/ingest/adapters/looker/local-runtime-store.js';
import { computeLookerMappingDrift, discoverLookerConnections, validateLookerMappings, type LookerMappingClient } from './context/ingest/adapters/looker/mapping.js';
import { computeMetabaseMappingDrift, discoverMetabaseDatabases, validateMappingPhysicalMatch } from './context/ingest/adapters/metabase/mapping.js';
import { lookerCredentialsFromLocalConnection } from './context/ingest/adapters/looker/local-looker.adapter.js';
import { metabaseRuntimeConfigFromLocalConnection } from './context/ingest/adapters/metabase/local-metabase.adapter.js';
import { planMetabaseFanoutChildren } from './context/ingest/adapters/metabase/fanout-planner.js';
import { seedLocalMappingStateFromKtxYaml } from './context/ingest/local-mapping-reconcile.js';
import type { MetabaseRuntimeClient } from './context/ingest/adapters/metabase/client-port.js';
import { type KtxLocalProject, loadKtxProject } from './context/project/project.js';
import { ktxLocalStateDbPath } from './context/project/local-state-db.js';
import type { KtxCliIo } from './cli-runtime.js';
import { profileMark } from './startup-profile.js';

profileMark('module:source-mapping');

export type KtxSourceMappingArgs =
  | { command: 'list'; projectDir: string; connectionId: string; json: boolean }
  | { command: 'refresh'; projectDir: string; connectionId: string; autoAccept: boolean }
  | { command: 'validate'; projectDir: string; connectionId: string };

interface KtxSourceMappingDeps {
  createMetabaseClient?: (
    project: KtxLocalProject,
    connectionId: string,
  ) => Promise<Pick<MetabaseRuntimeClient, 'getDatabases' | 'cleanup'>>;
  createLookerClient?: (
    project: KtxLocalProject,
    connectionId: string,
  ) => Promise<Pick<LookerMappingClient, 'listLookerConnections'> & { cleanup?(): Promise<void> }>;
}

async function createDefaultMetabaseClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<Pick<MetabaseRuntimeClient, 'getDatabases' | 'cleanup'>> {
  const factory = new DefaultMetabaseConnectionClientFactory(
    (metabaseConnectionId) =>
      metabaseRuntimeConfigFromLocalConnection(metabaseConnectionId, project.config.connections[metabaseConnectionId]),
    DEFAULT_METABASE_CLIENT_CONFIG,
  );
  return factory.createClient(connectionId);
}

async function createDefaultLookerClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<Pick<LookerMappingClient, 'listLookerConnections'> & { cleanup?(): Promise<void> }> {
  const factory = new DefaultLookerConnectionClientFactory({
    async resolve(lookerConnectionId) {
      return lookerCredentialsFromLocalConnection(lookerConnectionId, project.config.connections[lookerConnectionId]);
    },
  });
  return factory.createClient(connectionId) as unknown as Pick<LookerMappingClient, 'listLookerConnections'> & {
    cleanup?(): Promise<void>;
  };
}

function isLookerConnection(project: KtxLocalProject, connectionId: string): boolean {
  return String(project.config.connections[connectionId]?.driver ?? '').toLowerCase() === 'looker';
}

function assertMetabaseConnection(project: KtxLocalProject, connectionId: string): void {
  const connection = project.config.connections[connectionId];
  if (!connection || String(connection.driver).toLowerCase() !== 'metabase') {
    throw new Error(`Connection "${connectionId}" is not a Metabase connection`);
  }
}

function targetPhysicalInfo(project: KtxLocalProject, connectionId: string) {
  const descriptor = localConnectionToWarehouseDescriptor(connectionId, project.config.connections[connectionId]);
  if (!descriptor) {
    return { connection_type: 'UNKNOWN' };
  }
  return {
    connection_type: descriptor.connection_type,
    host: descriptor.host ?? null,
    database: descriptor.database ?? null,
    account: descriptor.account ?? null,
    project_id: descriptor.project_id ?? null,
    dataset_id: descriptor.dataset_id ?? null,
    ...descriptor.connection_params,
  };
}

function renderMapping(row: LocalMetabaseMappingListRow): string {
  const name = row.metabaseDatabaseName ?? 'unhydrated';
  const target = row.targetConnectionId ?? '[unmapped]';
  return `${row.metabaseDatabaseId} -> ${target} (${name}, sync: ${row.syncEnabled ? 'on' : 'off'}, source: ${
    row.source
  })`;
}

function renderLookerMapping(row: Awaited<ReturnType<LocalLookerRuntimeStore['listConnectionMappings']>>[number]): string {
  const target = row.ktxConnectionId ?? '[unmapped]';
  const metadata = [row.lookerDialect, row.lookerHost, row.lookerDatabase].filter(Boolean).join(', ');
  return `${row.lookerConnectionName} -> ${target}${metadata ? ` (${metadata}, source: ${row.source})` : ` (source: ${row.source})`}`;
}

export async function runKtxSourceMapping(
  args: KtxSourceMappingArgs,
  io: KtxCliIo = process,
  deps: KtxSourceMappingDeps = {},
): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    await seedLocalMappingStateFromKtxYaml(project, args.connectionId);
    if (isLookerConnection(project, args.connectionId)) {
      const store = new LocalLookerRuntimeStore({ dbPath: ktxLocalStateDbPath(project) });

      if (args.command === 'list') {
        const rows = await store.listConnectionMappings(args.connectionId);
        io.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${rows.map(renderLookerMapping).join('\n')}\n`);
        return 0;
      }

      if (args.command === 'refresh') {
        const client = await (deps.createLookerClient ?? createDefaultLookerClient)(project, args.connectionId);
        try {
          const discovered = await discoverLookerConnections(client);
          const drift = computeLookerMappingDrift({
            storedMappings: await store.readMappings(args.connectionId),
            discovered,
          });
          if (args.autoAccept) {
            await store.refreshDiscoveredConnections({ lookerConnectionId: args.connectionId, discovered });
          }
          io.stdout.write(`Discovery: ${discovered.length} ${discovered.length === 1 ? 'connection' : 'connections'}\n`);
          io.stdout.write(`Unmapped discovered: ${drift.unmappedDiscovered.length}\n`);
          io.stdout.write(`Stale mappings: ${drift.staleMappings.length}\n`);
          return 0;
        } finally {
          await client.cleanup?.();
        }
      }

      const knownKtxConnectionIds = new Set(Object.keys(project.config.connections));
      const knownConnectionTypes = new Map(
        Object.entries(project.config.connections).map(([id]) => [id, targetPhysicalInfo(project, id).connection_type]),
      );
      const validation = validateLookerMappings({
        mappings: await store.readMappings(args.connectionId),
        knownKtxConnectionIds,
        knownConnectionTypes,
      });
      if (!validation.ok) {
        for (const error of validation.errors) {
          io.stderr.write(`${error.key}: ${error.reason}\n`);
        }
        return 1;
      }
      io.stdout.write(`Mapping validation passed: ${args.connectionId}\n`);
      return 0;
    }

    assertMetabaseConnection(project, args.connectionId);
    const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: ktxLocalStateDbPath(project) });
    const store = new KtxYamlMetabaseSourceStateReader(project, { discoveryCache });

    if (args.command === 'list') {
      const rows = await store.listDatabaseMappings(args.connectionId);
      io.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${rows.map(renderMapping).join('\n')}\n`);
      return 0;
    }

    if (args.command === 'refresh') {
      const client = await (deps.createMetabaseClient ?? createDefaultMetabaseClient)(project, args.connectionId);
      try {
        const discovered = await discoverMetabaseDatabases(client);
        const existing = Object.fromEntries(
          (await store.listDatabaseMappings(args.connectionId)).map((row) => [
            String(row.metabaseDatabaseId),
            row.targetConnectionId,
          ]),
        );
        const drift = computeMetabaseMappingDrift({ currentMappings: existing, discovered });
        if (args.autoAccept) {
          await discoveryCache.refreshDiscoveredDatabases({ connectionId: args.connectionId, discovered });
        }
        io.stdout.write(`Discovery: ${discovered.length} ${discovered.length === 1 ? 'database' : 'databases'}\n`);
        io.stdout.write(`Unmapped discovered: ${drift.unmappedDiscovered.length}\n`);
        io.stdout.write(`Stale mappings: ${drift.staleMappings.length}\n`);
        return 0;
      } finally {
        await client.cleanup();
      }
    }

    const rows = await store.listDatabaseMappings(args.connectionId);
    planMetabaseFanoutChildren({
      metabaseConnectionId: args.connectionId,
      mappings: rows.map((row) => ({
        metabaseDatabaseId: row.metabaseDatabaseId,
        targetConnectionId: row.targetConnectionId,
        syncEnabled: row.syncEnabled,
      })),
    });
    const failures = rows.flatMap((row) => {
      if (!row.targetConnectionId) {
        return [];
      }
      const reason = validateMappingPhysicalMatch(
        { metabaseEngine: row.metabaseEngine, metabaseDbName: row.metabaseDbName, metabaseHost: row.metabaseHost },
        project.config.connections[row.targetConnectionId]
          ? targetPhysicalInfo(project, row.targetConnectionId)
          : { connection_type: 'UNKNOWN' },
      );
      return reason ? [`${row.metabaseDatabaseId}: ${reason}`] : [];
    });
    if (failures.length > 0) {
      for (const failure of failures) {
        io.stderr.write(`${failure}\n`);
      }
      return 1;
    }
    io.stdout.write(`Mapping validation passed: ${args.connectionId}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
