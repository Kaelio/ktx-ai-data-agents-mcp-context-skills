import { cancel, confirm, isCancel } from '@clack/prompts';
import {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultMetabaseConnectionClientFactory,
  type MetabaseRuntimeClient,
  metabaseRuntimeConfigFromLocalConnection,
} from '@ktx/context/ingest';
import { type KtxLocalProject, loadKtxProject, serializeKtxProjectConfig } from '@ktx/context/project';
import type { KtxScanConnector } from '@ktx/context/scan';
import type { KtxConnectionMappingArgs } from './commands/connection-mapping.js';
import type { KtxCliIo } from './index.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { profileMark } from './startup-profile.js';

profileMark('module:connection');

interface KtxNotionConnectionCliConfig {
  authTokenRef: string;
  crawlMode: 'all_accessible' | 'selected_roots';
  rootPageIds: string[];
  rootDatabaseIds: string[];
  rootDataSourceIds: string[];
  maxPagesPerRun?: number;
  maxKnowledgeCreatesPerRun?: number;
  maxKnowledgeUpdatesPerRun?: number;
}

type KtxConnectionInputMode = 'disabled';

export type KtxConnectionArgs =
  | { command: 'list'; projectDir: string }
  | {
      command: 'add';
      projectDir: string;
      driver: string;
      connectionId: string;
      url?: string;
      schemas: string[];
      readonly: boolean;
      force: boolean;
      allowLiteralCredentials: boolean;
      notion?: KtxNotionConnectionCliConfig;
    }
  | { command: 'test'; projectDir: string; connectionId: string }
  | {
      command: 'remove';
      projectDir: string;
      connectionId: string;
      force: boolean;
      inputMode?: KtxConnectionInputMode;
    }
  | {
      command: 'map';
      projectDir: string;
      sourceConnectionId: string;
      json: boolean;
    };

interface KtxConnectionPromptAdapter {
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  cancel(message: string): void;
}

interface KtxConnectionIo extends KtxCliIo {
  stdin?: { isTTY?: boolean };
}

interface KtxConnectionDeps {
  createScanConnector?: typeof createKtxCliScanConnector;
  createMetabaseClient?: typeof createDefaultMetabaseClient;
  runMapping?: (argv: string[], io: KtxCliIo) => Promise<number>;
  prompts?: KtxConnectionPromptAdapter;
}

function assertSafeConnectionId(connectionId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
}

function isCredentialReference(value: string): boolean {
  return value.startsWith('env:') || value.startsWith('file:');
}

function literalCredentialWarning(connectionId: string): string {
  return `Warning: writing a literal credential URL to ktx.yaml for connection "${connectionId}". Prefer env:NAME or file:/path references.`;
}

function createClackConnectionPromptAdapter(): KtxConnectionPromptAdapter {
  return {
    async confirm(options: { message: string; initialValue?: boolean }): Promise<boolean> {
      const value = await confirm(options);
      return isCancel(value) ? false : value;
    },
    cancel(message: string): void {
      cancel(message);
    },
  };
}

function isInteractiveConnectionIo(
  args: Extract<KtxConnectionArgs, { command: 'remove' }>,
  io: KtxConnectionIo,
): boolean {
  return args.inputMode !== 'disabled' && io.stdin?.isTTY === true && io.stdout.isTTY === true;
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

interface BufferedIo extends KtxCliIo {
  stdoutText(): string;
  stderrText(): string;
}

function createBufferedIo(): BufferedIo {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
      },
    },
    stdoutText() {
      return stdout;
    },
    stderrText() {
      return stderr;
    },
  };
}

function splitOutputLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runLowLevelMapping(
  args: KtxConnectionMappingArgs,
  argv: string[],
  io: KtxCliIo,
  deps: KtxConnectionDeps,
): Promise<number> {
  if (deps.runMapping) {
    return await deps.runMapping(argv, io);
  }

  const { runKtxConnectionMapping } = await import('./commands/connection-mapping.js');
  return await runKtxConnectionMapping(args, io);
}

function parseMappingListJson(output: string): unknown[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

async function runPublicConnectionMap(
  args: Extract<KtxConnectionArgs, { command: 'map' }>,
  io: KtxCliIo,
  deps: KtxConnectionDeps,
): Promise<number> {
  const refreshIo = createBufferedIo();
  const refreshArgs: KtxConnectionMappingArgs = {
    command: 'refresh',
    projectDir: args.projectDir,
    connectionId: args.sourceConnectionId,
    autoAccept: true,
  };
  const refreshCode = await runLowLevelMapping(
    refreshArgs,
    ['refresh', args.sourceConnectionId, '--auto-accept', '--project-dir', args.projectDir],
    refreshIo,
    deps,
  );
  if (refreshCode !== 0) {
    io.stderr.write(
      refreshIo.stderrText() ||
        refreshIo.stdoutText() ||
        `Failed to refresh mapping metadata for ${args.sourceConnectionId}\n`,
    );
    return refreshCode;
  }

  const validationIo = createBufferedIo();
  const validationArgs: KtxConnectionMappingArgs = {
    command: 'validate',
    projectDir: args.projectDir,
    connectionId: args.sourceConnectionId,
  };
  const validationCode = await runLowLevelMapping(
    validationArgs,
    ['validate', args.sourceConnectionId, '--project-dir', args.projectDir],
    validationIo,
    deps,
  );
  if (validationCode !== 0) {
    io.stderr.write(
      validationIo.stderrText() || validationIo.stdoutText() || `Mapping validation failed for ${args.sourceConnectionId}\n`,
    );
    return validationCode;
  }

  const listIo = createBufferedIo();
  const listArgv = ['list', args.sourceConnectionId, '--project-dir', args.projectDir];
  const listArgs: KtxConnectionMappingArgs = {
    command: 'list',
    projectDir: args.projectDir,
    connectionId: args.sourceConnectionId,
    json: args.json,
  };
  const listCode = await runLowLevelMapping(listArgs, args.json ? [...listArgv, '--json'] : listArgv, listIo, deps);
  if (listCode !== 0) {
    io.stderr.write(listIo.stderrText() || listIo.stdoutText() || `Failed to list mappings for ${args.sourceConnectionId}\n`);
    return listCode;
  }

  if (args.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          connectionId: args.sourceConnectionId,
          refresh: { ok: true, output: splitOutputLines(refreshIo.stdoutText()) },
          validation: { ok: true, output: splitOutputLines(validationIo.stdoutText()) },
          mappings: parseMappingListJson(listIo.stdoutText()),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  io.stdout.write(`Mapping: ${args.sourceConnectionId}\n`);
  io.stdout.write(refreshIo.stdoutText());
  io.stdout.write(validationIo.stdoutText());
  io.stdout.write('\nMappings:\n');
  io.stdout.write(listIo.stdoutText().trim() ? listIo.stdoutText() : 'No mappings found.\n');
  io.stdout.write('\nNext:\n');
  io.stdout.write(`  ktx ingest run --connection-id ${args.sourceConnectionId} --adapter <adapter>\n`);
  io.stdout.write(`  ktx connection mapping list ${args.sourceConnectionId}\n`);
  return 0;
}

export async function runKtxConnection(
  args: KtxConnectionArgs,
  io: KtxConnectionIo = process,
  deps: KtxConnectionDeps = {},
): Promise<number> {
  try {
    if (args.command === 'map') {
      return await runPublicConnectionMap(args, io, deps);
    }

    const project = await loadKtxProject({ projectDir: args.projectDir });
    if (args.command === 'list') {
      const entries = Object.entries(project.config.connections).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) {
        io.stdout.write('No connections configured. Run `ktx connection add <id> --driver <driver>` to add one.\n');
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

    if (args.command === 'add') {
      assertSafeConnectionId(args.connectionId);
      const hasLiteralCredentialUrl = !!args.url && !isCredentialReference(args.url);
      if (hasLiteralCredentialUrl && !args.allowLiteralCredentials) {
        throw new Error('Literal credential URLs require --allow-literal-credentials');
      }
      if (hasLiteralCredentialUrl) {
        io.stderr.write(`${literalCredentialWarning(args.connectionId)}\n`);
      }
      if (project.config.connections[args.connectionId] && !args.force) {
        throw new Error(`Connection "${args.connectionId}" already exists; pass --force to replace it`);
      }
      const connectionConfig =
        args.driver === 'notion' && args.notion
          ? {
              driver: 'notion',
              auth_token_ref: args.notion.authTokenRef,
              crawl_mode: args.notion.crawlMode,
              root_page_ids: args.notion.rootPageIds,
              root_database_ids: args.notion.rootDatabaseIds,
              root_data_source_ids: args.notion.rootDataSourceIds,
              ...(args.notion.maxPagesPerRun !== undefined ? { max_pages_per_run: args.notion.maxPagesPerRun } : {}),
              ...(args.notion.maxKnowledgeCreatesPerRun !== undefined
                ? { max_knowledge_creates_per_run: args.notion.maxKnowledgeCreatesPerRun }
                : {}),
              ...(args.notion.maxKnowledgeUpdatesPerRun !== undefined
                ? { max_knowledge_updates_per_run: args.notion.maxKnowledgeUpdatesPerRun }
                : {}),
            }
          : {
              driver: args.driver,
              ...(args.url ? { url: args.url } : {}),
              ...(args.schemas.length > 0 ? { schemas: args.schemas } : {}),
              readonly: args.readonly,
            };
      const nextConfig = {
        ...project.config,
        connections: {
          ...project.config.connections,
          [args.connectionId]: connectionConfig,
        },
      };
      await project.fileStore.writeFile(
        'ktx.yaml',
        serializeKtxProjectConfig(nextConfig),
        'ktx',
        'ktx@example.com',
        `Update KTX connection: ${args.connectionId}`,
      );
      io.stdout.write(`Connection: ${args.connectionId}\n`);
      io.stdout.write(`Driver: ${args.driver}\n`);
      return 0;
    }

    if (args.command === 'remove') {
      if (!project.config.connections[args.connectionId]) {
        throw new Error(`Connection "${args.connectionId}" is not configured in ktx.yaml`);
      }

      if (!args.force) {
        if (!isInteractiveConnectionIo(args, io)) {
          throw new Error(
            `connection remove ${args.connectionId} requires --force when input is disabled or not interactive`,
          );
        }

        const prompts = deps.prompts ?? createClackConnectionPromptAdapter();
        const confirmed = await prompts.confirm({
          message: `Remove connection "${args.connectionId}" from ktx.yaml? Ingested artifacts will remain in .ktx/.`,
          initialValue: false,
        });
        if (!confirmed) {
          prompts.cancel('Connection removal cancelled.');
          return 1;
        }
      }

      const { [args.connectionId]: _removedConnection, ...connections } = project.config.connections;
      const nextConfig = {
        ...project.config,
        connections,
      };
      await project.fileStore.writeFile(
        'ktx.yaml',
        serializeKtxProjectConfig(nextConfig),
        'ktx',
        'ktx@example.com',
        `Remove KTX connection: ${args.connectionId}`,
      );
      io.stdout.write('Connection removed from ktx.yaml.\n');
      io.stdout.write('Ingested artifacts from this connection remain in .ktx/. Run ktx dev artifacts to inspect.\n');
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
