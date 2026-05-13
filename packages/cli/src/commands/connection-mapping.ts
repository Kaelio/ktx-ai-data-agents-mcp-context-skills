import { readFile } from 'node:fs/promises';
import { localConnectionToWarehouseDescriptor } from '@ktx/context/connections';
import {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultLookerConnectionClientFactory,
  DefaultMetabaseConnectionClientFactory,
  KtxYamlMetabaseSourceStateReader,
  LocalLookerRuntimeStore,
  LocalMetabaseDiscoveryCache,
  computeLookerMappingDrift,
  computeMetabaseMappingDrift,
  discoverLookerConnections,
  discoverMetabaseDatabases,
  lookerCredentialsFromLocalConnection,
  metabaseRuntimeConfigFromLocalConnection,
  seedLocalMappingStateFromKtxYaml,
  validateLookerMappings,
  validateMappingPhysicalMatch,
  type LookerMappingClient,
  type LocalMetabaseMappingListRow,
  type MetabaseRuntimeClient,
  type MetabaseSyncMode,
} from '@ktx/context/ingest';
import {
  type KtxLocalProject,
  type KtxProjectConfig,
  ktxLocalStateDbPath,
  loadKtxProject,
  parseMetabaseMappingBootstrap,
  serializeKtxProjectConfig,
  stripKtxSetupCompletedSteps,
} from '@ktx/context/project';
import type { KtxCliIo } from '../index.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/connection-mapping');

export type KtxConnectionMappingArgs =
  | { command: 'list'; projectDir: string; connectionId: string; json: boolean }
  | {
      command: 'set';
      projectDir: string;
      connectionId: string;
      field: 'databaseMappings' | 'connectionMappings';
      key: string;
      value: string;
    }
  | { command: 'apply-bulk'; projectDir: string; connectionId: string; filePath: string }
  | {
      command: 'set-sync-enabled';
      projectDir: string;
      connectionId: string;
      metabaseDatabaseId: number;
      enabled: boolean;
    }
  | { command: 'sync-state-get'; projectDir: string; connectionId: string; json: boolean }
  | {
      command: 'sync-state-set';
      projectDir: string;
      connectionId: string;
      syncMode: MetabaseSyncMode;
      collectionIds: number[];
      itemIds: number[];
      tagNames: string[];
    }
  | { command: 'refresh'; projectDir: string; connectionId: string; autoAccept: boolean }
  | { command: 'validate'; projectDir: string; connectionId: string }
  | { command: 'clear'; projectDir: string; connectionId: string; metabaseDatabaseId?: number; mappingKey?: string };

interface KtxConnectionMappingDeps {
  createMetabaseClient?: (
    project: KtxLocalProject,
    connectionId: string,
  ) => Promise<Pick<MetabaseRuntimeClient, 'getDatabases' | 'cleanup'>>;
  createLookerClient?: (
    project: KtxLocalProject,
    connectionId: string,
  ) => Promise<Pick<LookerMappingClient, 'listLookerConnections'> & { cleanup?(): Promise<void> }>;
}

interface MetabaseBulkMappingPayload {
  databaseMappings?: Record<string, string | null>;
  syncEnabled?: Record<string, boolean>;
  syncMode?: MetabaseSyncMode;
  selections?: { collections?: number[]; items?: number[] };
  defaultTagNames?: string[];
}

function parseId(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

interface MetabaseMappingsBlock {
  databaseMappings: Record<string, string | null>;
  syncEnabled: Record<string, boolean>;
  syncMode: MetabaseSyncMode;
  selections: { collections: number[]; items: number[] };
  defaultTagNames: string[];
}

function currentMetabaseMappings(project: KtxLocalProject, connectionId: string): MetabaseMappingsBlock {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const bootstrap = parseMetabaseMappingBootstrap(connectionId, connection);
  return {
    databaseMappings: { ...bootstrap.databaseMappings },
    syncEnabled: { ...bootstrap.syncEnabled },
    syncMode: bootstrap.syncMode,
    selections: {
      collections: [...bootstrap.selections.collections],
      items: [...bootstrap.selections.items],
    },
    defaultTagNames: [...bootstrap.defaultTagNames],
  };
}

function hasMetabaseMappings(block: MetabaseMappingsBlock): boolean {
  return (
    Object.keys(block.databaseMappings).length > 0 ||
    Object.keys(block.syncEnabled).length > 0 ||
    block.syncMode !== 'ALL' ||
    block.selections.collections.length > 0 ||
    block.selections.items.length > 0 ||
    block.defaultTagNames.length > 0
  );
}

function serializeMetabaseMappingsBlock(block: MetabaseMappingsBlock): Record<string, unknown> | undefined {
  if (!hasMetabaseMappings(block)) {
    return undefined;
  }
  return {
    databaseMappings: block.databaseMappings,
    syncEnabled: block.syncEnabled,
    syncMode: block.syncMode,
    selections: block.selections,
    defaultTagNames: block.defaultTagNames,
  };
}

async function writeMetabaseMappings(
  project: KtxLocalProject,
  connectionId: string,
  block: MetabaseMappingsBlock,
  message: string,
): Promise<void> {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const mappings = serializeMetabaseMappingsBlock(block);
  const nextConnection = { ...connection };
  if (mappings) {
    nextConnection.mappings = mappings;
  } else {
    delete nextConnection.mappings;
  }
  const nextConfig: KtxProjectConfig = {
    ...project.config,
    connections: {
      ...project.config.connections,
      [connectionId]: nextConnection,
    },
  };
  await project.fileStore.writeFile(
    'ktx.yaml',
    serializeKtxProjectConfig(stripKtxSetupCompletedSteps(nextConfig)),
    'ktx',
    'ktx@example.com',
    message,
  );
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

function assertLookerConnection(project: KtxLocalProject, connectionId: string): void {
  if (!isLookerConnection(project, connectionId)) {
    throw new Error(`Connection "${connectionId}" is not a Looker connection`);
  }
}

function assertMetabaseConnection(project: KtxLocalProject, connectionId: string): void {
  const connection = project.config.connections[connectionId];
  if (!connection || String(connection.driver).toLowerCase() !== 'metabase') {
    throw new Error(`Connection "${connectionId}" is not a Metabase connection`);
  }
}

function assertTargetConnection(project: KtxLocalProject, connectionId: string): void {
  if (!project.config.connections[connectionId]) {
    throw new Error(`Target connection "${connectionId}" does not exist`);
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

export async function runKtxConnectionMapping(
  args: KtxConnectionMappingArgs,
  io: KtxCliIo = process,
  deps: KtxConnectionMappingDeps = {},
): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    await seedLocalMappingStateFromKtxYaml(project, args.connectionId);
    if (isLookerConnection(project, args.connectionId)) {
      assertLookerConnection(project, args.connectionId);
      const store = new LocalLookerRuntimeStore({ dbPath: ktxLocalStateDbPath(project) });

      if (args.command === 'list') {
        const rows = await store.listConnectionMappings(args.connectionId);
        io.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${rows.map(renderLookerMapping).join('\n')}\n`);
        return 0;
      }

      if (args.command === 'set') {
        if (args.field !== 'connectionMappings') {
          throw new Error('Looker mapping set requires connectionMappings <lookerConnectionName>=<targetConnectionId>');
        }
        assertTargetConnection(project, args.value);
        await store.upsertConnectionMapping({
          lookerConnectionId: args.connectionId,
          lookerConnectionName: args.key,
          ktxConnectionId: args.value,
          source: 'cli',
        });
        io.stdout.write(`Set connectionMappings.${args.key} = ${args.value}\n`);
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

      if (args.command === 'validate') {
        const knownKtxConnectionIds = new Set(Object.keys(project.config.connections));
        const knownConnectionTypes = new Map(
          Object.entries(project.config.connections).map(([id, _config]) => [id, targetPhysicalInfo(project, id).connection_type]),
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

      if (args.command === 'clear') {
        await store.clearConnectionMappings({
          lookerConnectionId: args.connectionId,
          lookerConnectionName: args.mappingKey ?? (args.metabaseDatabaseId ? String(args.metabaseDatabaseId) : undefined),
        });
        io.stdout.write(
          args.mappingKey
            ? `Cleared connectionMappings.${args.mappingKey}\n`
            : `Cleared mappings for ${args.connectionId}\n`,
        );
        return 0;
      }

      throw new Error(`Looker connection mapping does not support ${args.command}`);
    }

    assertMetabaseConnection(project, args.connectionId);
    const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: ktxLocalStateDbPath(project) });
    const metabaseStateReader = new KtxYamlMetabaseSourceStateReader(project, { discoveryCache });

    if (args.command === 'list') {
      const rows = await metabaseStateReader.listDatabaseMappings(args.connectionId);
      io.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${rows.map(renderMapping).join('\n')}\n`);
      return 0;
    }

    if (args.command === 'set') {
      if (args.field !== 'databaseMappings') {
        throw new Error('Metabase mapping set requires databaseMappings <metabaseDatabaseId>=<targetConnectionId>');
      }
      assertTargetConnection(project, args.value);
      const block = currentMetabaseMappings(project, args.connectionId);
      const metabaseDatabaseId = String(parseId(args.key, 'metabaseDatabaseId'));
      block.databaseMappings[metabaseDatabaseId] = args.value;
      block.syncEnabled[metabaseDatabaseId] = true;
      await writeMetabaseMappings(project, args.connectionId, block, `Set Metabase mapping ${args.connectionId}.${metabaseDatabaseId}`);
      io.stdout.write(`Set databaseMappings.${args.key} = ${args.value}\n`);
      return 0;
    }

    if (args.command === 'apply-bulk') {
      const payload = JSON.parse(await readFile(args.filePath, 'utf8')) as MetabaseBulkMappingPayload;
      const block = currentMetabaseMappings(project, args.connectionId);
      const databaseMappings = payload.databaseMappings ?? {};
      for (const targetConnectionId of Object.values(databaseMappings)) {
        if (targetConnectionId) {
          assertTargetConnection(project, targetConnectionId);
        }
      }
      for (const id of Object.keys(databaseMappings)) {
        parseId(id, 'metabaseDatabaseId');
        block.databaseMappings[id] = databaseMappings[id] ?? null;
      }
      for (const [id, enabled] of Object.entries(payload.syncEnabled ?? {})) {
        parseId(id, 'metabaseDatabaseId');
        block.syncEnabled[id] = enabled;
      }
      if (payload.syncMode !== undefined) {
        block.syncMode = payload.syncMode;
      }
      if (payload.defaultTagNames !== undefined) {
        block.defaultTagNames = payload.defaultTagNames;
      }
      if (payload.selections !== undefined) {
        block.selections = {
          collections: payload.selections.collections ?? [],
          items: payload.selections.items ?? [],
        };
      }
      await writeMetabaseMappings(project, args.connectionId, block, `Apply Metabase mappings ${args.connectionId}`);
      io.stdout.write(`Applied bulk mappings for ${args.connectionId}\n`);
      return 0;
    }

    if (args.command === 'set-sync-enabled') {
      const block = currentMetabaseMappings(project, args.connectionId);
      block.syncEnabled[String(args.metabaseDatabaseId)] = args.enabled;
      await writeMetabaseMappings(
        project,
        args.connectionId,
        block,
        `Set Metabase sync ${args.connectionId}.${args.metabaseDatabaseId}`,
      );
      io.stdout.write(`Set syncEnabled.${args.metabaseDatabaseId} = ${args.enabled}\n`);
      return 0;
    }

    if (args.command === 'sync-state-get') {
      const state = await metabaseStateReader.getSourceState(args.connectionId);
      const payload = {
        syncMode: state.syncMode,
        selections: state.selections,
        defaultTagNames: state.defaultTagNames,
      };
      io.stdout.write(args.json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.syncMode}\n`);
      return 0;
    }

    if (args.command === 'sync-state-set') {
      const block = currentMetabaseMappings(project, args.connectionId);
      block.syncMode = args.syncMode;
      block.defaultTagNames = args.tagNames;
      block.selections = { collections: args.collectionIds, items: args.itemIds };
      await writeMetabaseMappings(project, args.connectionId, block, `Set Metabase sync state ${args.connectionId}`);
      io.stdout.write(`Set sync state for ${args.connectionId}\n`);
      return 0;
    }

    if (args.command === 'refresh') {
      const client = await (deps.createMetabaseClient ?? createDefaultMetabaseClient)(project, args.connectionId);
      try {
        const discovered = await discoverMetabaseDatabases(client);
        const block = currentMetabaseMappings(project, args.connectionId);
        const existing = block.databaseMappings;
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

    if (args.command === 'validate') {
      const rows = (await metabaseStateReader.listDatabaseMappings(args.connectionId)).filter(
        (row) => row.source === 'ktx.yaml',
      );
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
    }

    const metabaseDatabaseId = args.metabaseDatabaseId ?? (args.mappingKey ? parseId(args.mappingKey, 'metabaseDatabaseId') : undefined);
    const block = currentMetabaseMappings(project, args.connectionId);
    if (metabaseDatabaseId === undefined) {
      block.databaseMappings = {};
      block.syncEnabled = {};
      block.syncMode = 'ALL';
      block.selections = { collections: [], items: [] };
      block.defaultTagNames = [];
    } else {
      delete block.databaseMappings[String(metabaseDatabaseId)];
      delete block.syncEnabled[String(metabaseDatabaseId)];
    }
    await writeMetabaseMappings(project, args.connectionId, block, `Clear Metabase mappings ${args.connectionId}`);
    io.stdout.write(
      metabaseDatabaseId
        ? `Cleared databaseMappings.${metabaseDatabaseId}\n`
        : `Cleared mappings for ${args.connectionId}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
