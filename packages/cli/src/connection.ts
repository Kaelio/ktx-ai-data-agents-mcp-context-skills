import {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultMetabaseConnectionClientFactory,
  type MetabaseRuntimeClient,
  metabaseRuntimeConfigFromLocalConnection,
} from '@ktx/context/ingest';
import { type KtxLocalProject, loadKtxProject } from '@ktx/context/project';
import type { KtxScanConnector } from '@ktx/context/scan';
import type { KtxCliIo } from './index.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { profileMark } from './startup-profile.js';

profileMark('module:connection');

export type KtxConnectionArgs =
  | { command: 'list'; projectDir: string }
  | { command: 'test'; projectDir: string; connectionId: string };

interface KtxConnectionDeps {
  createScanConnector?: typeof createKtxCliScanConnector;
  createMetabaseClient?: typeof createDefaultMetabaseClient;
}

async function cleanupConnector(connector: KtxScanConnector | null): Promise<void> {
  if (connector?.cleanup) {
    await connector.cleanup();
  }
}

function normalizedConnectionDriver(project: KtxLocalProject, connectionId: string): string {
  return String(project.config.connections[connectionId]?.driver ?? '')
    .trim()
    .toLowerCase();
}

async function testNativeConnection(
  project: KtxLocalProject,
  connectionId: string,
  createScanConnector: typeof createKtxCliScanConnector,
): Promise<{ driver: string; tableCount: number }> {
  let connector: KtxScanConnector | null = null;
  try {
    connector = await createScanConnector(project, connectionId);
    const snapshot = await connector.introspect(
      {
        connectionId,
        driver: connector.driver,
        mode: 'structural',
        dryRun: true,
        detectRelationships: false,
      },
      { runId: `connection-test-${connectionId}` },
    );
    return {
      driver: connector.driver,
      tableCount: snapshot.tables.length,
    };
  } finally {
    await cleanupConnector(connector);
  }
}

async function createDefaultMetabaseClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<Pick<MetabaseRuntimeClient, 'testConnection' | 'getDatabases' | 'cleanup'>> {
  const factory = new DefaultMetabaseConnectionClientFactory(
    (metabaseConnectionId) =>
      metabaseRuntimeConfigFromLocalConnection(
        metabaseConnectionId,
        project.config.connections[metabaseConnectionId],
      ),
    DEFAULT_METABASE_CLIENT_CONFIG,
  );
  return factory.createClient(connectionId);
}

async function testMetabaseConnection(
  project: KtxLocalProject,
  connectionId: string,
  createMetabaseClient: typeof createDefaultMetabaseClient,
): Promise<{ driver: 'metabase'; databaseCount: number }> {
  let client: Pick<MetabaseRuntimeClient, 'testConnection' | 'getDatabases' | 'cleanup'> | null = null;
  try {
    client = await createMetabaseClient(project, connectionId);
    const testResult = await client.testConnection();
    if (!testResult.success) {
      throw new Error(
        `Metabase connection test failed: ${testResult.error ?? testResult.message ?? 'unknown error'}`,
      );
    }

    const databases = await client.getDatabases();
    const databaseCount = databases.filter((database) => database.is_sample !== true).length;
    if (databaseCount === 0) {
      throw new Error('Metabase auth worked but no usable databases were returned');
    }

    return { driver: 'metabase', databaseCount };
  } finally {
    await client?.cleanup();
  }
}

export async function runKtxConnection(
  args: KtxConnectionArgs,
  io: KtxCliIo = process,
  deps: KtxConnectionDeps = {},
): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    if (args.command === 'list') {
      const entries = Object.entries(project.config.connections).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) {
        io.stdout.write('No connections configured. Run `ktx setup` to add one.\n');
        return 0;
      }
      const idWidth = Math.max('ID'.length, ...entries.map(([id]) => id.length));
      const driverWidth = Math.max(
        'DRIVER'.length,
        ...entries.map(([, c]) => (c.driver ?? 'unknown').length),
      );
      io.stdout.write(`${'ID'.padEnd(idWidth)}  ${'DRIVER'.padEnd(driverWidth)}\n`);
      for (const [id, connection] of entries) {
        io.stdout.write(`${id.padEnd(idWidth)}  ${(connection.driver ?? 'unknown').padEnd(driverWidth)}\n`);
      }
      return 0;
    }

    if (normalizedConnectionDriver(project, args.connectionId) === 'metabase') {
      const result = await testMetabaseConnection(
        project,
        args.connectionId,
        deps.createMetabaseClient ?? createDefaultMetabaseClient,
      );
      io.stdout.write(`Connection test passed: ${args.connectionId}\n`);
      io.stdout.write(`Driver: ${result.driver}\n`);
      io.stdout.write(`Databases: ${result.databaseCount}\n`);
      return 0;
    }

    const result = await testNativeConnection(
      project,
      args.connectionId,
      deps.createScanConnector ?? createKtxCliScanConnector,
    );
    io.stdout.write(`Connection test passed: ${args.connectionId}\n`);
    io.stdout.write(`Driver: ${result.driver}\n`);
    io.stdout.write(`Tables: ${result.tableCount}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
