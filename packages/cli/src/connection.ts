import {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultLookerConnectionClientFactory,
  DefaultMetabaseConnectionClientFactory,
  type LookerClient,
  type MetabaseRuntimeClient,
  type NotionBotInfo,
  NotionClient,
  createLocalLookerCredentialResolver,
  metabaseRuntimeConfigFromLocalConnection,
  testRepoConnection,
} from '@ktx/context/ingest';
import { parseNotionConnectionConfig, resolveNotionConnectionAuthToken } from '@ktx/context/connections';
import { resolveKtxConfigReference } from '@ktx/context/core';
import { type KtxLocalProject, loadKtxProject } from '@ktx/context/project';
import type { KtxScanConnector } from '@ktx/context/scan';
import type { KtxCliIo } from './index.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { profileMark } from './startup-profile.js';

profileMark('module:connection');

export type KtxConnectionArgs =
  | { command: 'list'; projectDir: string }
  | { command: 'test'; projectDir: string; connectionId: string };

type MetabaseTestPort = Pick<MetabaseRuntimeClient, 'testConnection' | 'getDatabases' | 'cleanup'>;
type LookerTestPort = Pick<LookerClient, 'testConnection'>;
type NotionTestPort = Pick<NotionClient, 'retrieveBotUser'>;
type TestRepoConnection = typeof testRepoConnection;

export interface KtxConnectionDeps {
  createScanConnector?: typeof createKtxCliScanConnector;
  createMetabaseClient?: (project: KtxLocalProject, connectionId: string) => Promise<MetabaseTestPort>;
  createLookerClient?: (project: KtxLocalProject, connectionId: string) => Promise<LookerTestPort>;
  createNotionClient?: (project: KtxLocalProject, connectionId: string) => Promise<NotionTestPort>;
  testRepoConnection?: TestRepoConnection;
}

const SUPPORTED_TEST_DRIVERS = [
  'sqlite',
  'postgres',
  'mysql',
  'clickhouse',
  'sqlserver',
  'bigquery',
  'snowflake',
  'metabase',
  'looker',
  'notion',
  'dbt',
  'metricflow',
  'lookml',
];

function normalizedConnectionDriver(project: KtxLocalProject, connectionId: string): string {
  return String(project.config.connections[connectionId]?.driver ?? '')
    .trim()
    .toLowerCase();
}

async function testNativeConnection(
  project: KtxLocalProject,
  connectionId: string,
  createScanConnector: typeof createKtxCliScanConnector,
): Promise<{ driver: string }> {
  let connector: KtxScanConnector | null = null;
  try {
    connector = await createScanConnector(project, connectionId);
    if (!connector.testConnection) {
      throw new Error(`Connector for "${connectionId}" does not implement testConnection`);
    }
    const result = await connector.testConnection();
    if (!result.success) {
      throw new Error(result.error ?? 'connection test failed');
    }
    return { driver: connector.driver };
  } finally {
    if (connector?.cleanup) {
      await connector.cleanup();
    }
  }
}

async function createDefaultMetabaseClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<MetabaseTestPort> {
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
  createClient: (project: KtxLocalProject, connectionId: string) => Promise<MetabaseTestPort>,
): Promise<{ databaseCount: number }> {
  let client: MetabaseTestPort | null = null;
  try {
    client = await createClient(project, connectionId);
    const testResult = await client.testConnection();
    if (!testResult.success) {
      throw new Error(`Metabase connection test failed: ${testResult.error ?? testResult.message ?? 'unknown error'}`);
    }
    const databases = await client.getDatabases();
    const databaseCount = databases.filter((database) => database.is_sample !== true).length;
    if (databaseCount === 0) {
      throw new Error('Metabase auth worked but no usable databases were returned');
    }
    return { databaseCount };
  } finally {
    await client?.cleanup();
  }
}

async function createDefaultLookerClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<LookerTestPort> {
  const factory = new DefaultLookerConnectionClientFactory(createLocalLookerCredentialResolver(project));
  return (await factory.createClient(connectionId)) as unknown as LookerTestPort;
}

async function testLookerConnection(
  project: KtxLocalProject,
  connectionId: string,
  createClient: (project: KtxLocalProject, connectionId: string) => Promise<LookerTestPort>,
): Promise<{ user: string }> {
  const client = await createClient(project, connectionId);
  const result = await client.testConnection();
  if (!result.success) {
    throw new Error(`Looker connection test failed: ${result.error ?? 'unknown error'}`);
  }
  const metadata = (result.metadata ?? {}) as { displayName?: string | null; userId?: string };
  const user = (metadata.displayName ?? metadata.userId ?? 'unknown').trim() || 'unknown';
  return { user };
}

async function createDefaultNotionClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<NotionTestPort> {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const parsed = parseNotionConnectionConfig(connection);
  const token = await resolveNotionConnectionAuthToken(parsed);
  return new NotionClient(token);
}

function describeNotionBot(bot: NotionBotInfo): string {
  const name = typeof bot.name === 'string' ? bot.name.trim() : '';
  if (name) return name;
  const id = typeof bot.id === 'string' ? bot.id.trim() : '';
  return id || 'unknown';
}

async function testNotionConnection(
  project: KtxLocalProject,
  connectionId: string,
  createClient: (project: KtxLocalProject, connectionId: string) => Promise<NotionTestPort>,
): Promise<{ bot: string }> {
  const client = await createClient(project, connectionId);
  const bot = await client.retrieveBotUser();
  return { bot: describeNotionBot(bot) };
}

interface GitConnectionFields {
  repoUrl: string;
  authToken: string | null;
}

function extractGitConnectionFields(
  project: KtxLocalProject,
  connectionId: string,
  driver: string,
): GitConnectionFields {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const stringField = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  const record =
    driver === 'metricflow' && typeof connection.metricflow === 'object' && connection.metricflow !== null
      ? (connection.metricflow as Record<string, unknown>)
      : (connection as Record<string, unknown>);
  const repoUrl = driver === 'dbt' ? stringField(record.repo_url) : stringField(record.repoUrl);
  if (!repoUrl) {
    const field = driver === 'dbt' ? 'repo_url' : 'repoUrl';
    throw new Error(`Connection "${connectionId}" (driver: ${driver}) is missing ${field}`);
  }
  const literalToken = stringField(record.auth_token);
  const ref = stringField(record.auth_token_ref);
  const resolvedRef = ref ? resolveKtxConfigReference(ref, process.env) : null;
  return { repoUrl, authToken: literalToken ?? resolvedRef ?? null };
}

async function testGitRepoConnection(
  project: KtxLocalProject,
  connectionId: string,
  driver: string,
  runTest: TestRepoConnection,
): Promise<{ repoUrl: string }> {
  const { repoUrl, authToken } = extractGitConnectionFields(project, connectionId, driver);
  const result = await runTest({ repoUrl, authToken });
  if (!result.ok) {
    throw new Error(`${driver} repository check failed: ${result.error}`);
  }
  return { repoUrl };
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

    const driver = normalizedConnectionDriver(project, args.connectionId);
    if (!driver) {
      throw new Error(`Connection "${args.connectionId}" has no \`driver\` field in ktx.yaml`);
    }

    const writePassed = (detailKey: string, detailValue: string): void => {
      io.stdout.write(`Connection test passed: ${args.connectionId}\n`);
      io.stdout.write(`Driver: ${driver}\n`);
      io.stdout.write(`${detailKey}: ${detailValue}\n`);
    };

    if (driver === 'metabase') {
      const result = await testMetabaseConnection(
        project,
        args.connectionId,
        deps.createMetabaseClient ?? createDefaultMetabaseClient,
      );
      writePassed('Databases', String(result.databaseCount));
      return 0;
    }

    if (driver === 'looker') {
      const result = await testLookerConnection(
        project,
        args.connectionId,
        deps.createLookerClient ?? createDefaultLookerClient,
      );
      writePassed('User', result.user);
      return 0;
    }

    if (driver === 'notion') {
      const result = await testNotionConnection(
        project,
        args.connectionId,
        deps.createNotionClient ?? createDefaultNotionClient,
      );
      writePassed('Bot', result.bot);
      return 0;
    }

    if (driver === 'dbt' || driver === 'metricflow' || driver === 'lookml') {
      const result = await testGitRepoConnection(
        project,
        args.connectionId,
        driver,
        deps.testRepoConnection ?? testRepoConnection,
      );
      writePassed('Repo', result.repoUrl);
      return 0;
    }

    if (
      driver === 'sqlite' ||
      driver === 'sqlite3' ||
      driver === 'postgres' ||
      driver === 'postgresql' ||
      driver === 'mysql' ||
      driver === 'clickhouse' ||
      driver === 'sqlserver' ||
      driver === 'bigquery' ||
      driver === 'snowflake'
    ) {
      const result = await testNativeConnection(
        project,
        args.connectionId,
        deps.createScanConnector ?? createKtxCliScanConnector,
      );
      io.stdout.write(`Connection test passed: ${args.connectionId}\n`);
      io.stdout.write(`Driver: ${result.driver}\n`);
      io.stdout.write('Status: ok\n');
      return 0;
    }

    throw new Error(
      `Connection "${args.connectionId}" uses driver "${driver}", which has no test implementation in ktx. Supported: ${SUPPORTED_TEST_DRIVERS.join(', ')}.`,
    );
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
