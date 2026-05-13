import type { Option as ClackOption } from '@clack/prompts';
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  password,
  select,
  text,
} from '@clack/prompts';
import { localConnectionToWarehouseDescriptor } from '@ktx/context/connections';
import {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultMetabaseConnectionClientFactory,
  KtxYamlMetabaseSourceStateReader,
  LocalMetabaseDiscoveryCache,
  MetabaseClient,
  type MetabaseDatabase,
  type MetabaseRuntimeClient,
  type MetabaseSyncMode,
  metabaseRuntimeConfigFromLocalConnection,
  validateMappingPhysicalMatch,
} from '@ktx/context/ingest';
import {
  type KtxLocalProject,
  type KtxProjectConnectionConfig,
  ktxLocalStateDbPath,
  loadKtxProject,
  parseMetabaseMappingBootstrap,
  serializeKtxProjectConfig,
  stripKtxSetupCompletedSteps,
} from '@ktx/context/project';

import { createClackSpinner, type KtxCliSpinner } from '../clack.js';
import type { KtxCliIo } from '../cli-runtime.js';
import { withMenuOptionsSpacing, withMultiselectNavigation } from '../prompt-navigation.js';
import { type KtxPublicIngestArgs, runKtxPublicIngest } from '../public-ingest.js';

export type KtxMetabaseSetupInputMode = 'auto' | 'disabled';

export type MetabaseSetupSyncMode = MetabaseSyncMode;

type MetabaseSetupPromptOption<Value> = ClackOption<Value>;

export interface MetabaseSetupLogger {
  info(message: string): void;
  step(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface MetabaseSetupPromptAdapter {
  intro(title?: string): void;
  outro(message?: string): void;
  note(message: string, title: string): void;
  log: MetabaseSetupLogger;
  spinner(): KtxCliSpinner;
  select<T extends string>(options: { message: string; options: Array<MetabaseSetupPromptOption<T>> }): Promise<T>;
  multiselect<Value extends number | string>(options: {
    message: string;
    options: Array<MetabaseSetupPromptOption<Value>>;
    initialValues?: Value[];
    required?: boolean;
    maxItems?: number;
  }): Promise<Value[]>;
  text(options: { message: string; placeholder?: string }): Promise<string>;
  password(options: { message: string }): Promise<string>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  cancel(message: string): void;
}

type KtxMetabaseSetupInteractiveIo = KtxCliIo & {
  stdin?: { isTTY?: boolean };
};

export interface MetabaseSetupMappingAssignment {
  metabaseDatabaseId: number;
  targetConnectionId: string;
}

export interface MintMetabaseApiKeyArgs {
  url: string;
  username: string;
  password: string;
}

export type MintMetabaseApiKey = (args: MintMetabaseApiKeyArgs, io: KtxCliIo) => Promise<string>;

export interface KtxConnectionMetabaseSetupArgs {
  command: 'setup';
  projectDir: string;
  connectionId?: string;
  url?: string;
  apiKey?: string;
  mintApiKey: boolean;
  metabaseUsername?: string;
  metabasePassword?: string;
  mappings: MetabaseSetupMappingAssignment[];
  syncEnabledDatabaseIds: number[];
  syncMode: MetabaseSetupSyncMode;
  runIngest: boolean;
  yes: boolean;
  inputMode: KtxMetabaseSetupInputMode;
}

export interface KtxConnectionMetabaseSetupDeps {
  createMetabaseClient?: (
    project: KtxLocalProject,
    connectionId: string,
  ) => Promise<Pick<MetabaseRuntimeClient, 'testConnection' | 'getDatabases' | 'cleanup'>>;
  mintMetabaseApiKey?: MintMetabaseApiKey;
  prompts?: MetabaseSetupPromptAdapter;
  runPublicIngest?: (args: Extract<KtxPublicIngestArgs, { command: 'run' }>, io: KtxCliIo) => Promise<number>;
}

function isMetabaseConnection(connection: KtxProjectConnectionConfig | undefined): boolean {
  return (
    String(connection?.driver ?? '')
      .trim()
      .toLowerCase() === 'metabase'
  );
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function resolveMetabaseUrl(connection: KtxProjectConnectionConfig | undefined): string | undefined {
  return stringField(connection?.api_url) ?? stringField(connection?.apiUrl) ?? stringField(connection?.url);
}

function resolveLiteralMetabaseApiKey(connection: KtxProjectConnectionConfig | undefined): string | undefined {
  return stringField(connection?.api_key) ?? stringField(connection?.apiKey);
}

function listMetabaseConnectionIds(project: KtxLocalProject): string[] {
  return Object.entries(project.config.connections)
    .filter(([_connectionId, connection]) => isMetabaseConnection(connection))
    .map(([connectionId]) => connectionId)
    .sort();
}

function listWarehouseConnectionIds(project: KtxLocalProject): string[] {
  return Object.entries(project.config.connections)
    .filter(([connectionId, connection]) => localConnectionToWarehouseDescriptor(connectionId, connection) != null)
    .map(([connectionId]) => connectionId)
    .sort();
}

function redactSecrets(message: string, secrets: string[]): string {
  let result = message;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    result = result.split(secret).join('[redacted]');
  }
  return result;
}

async function createDefaultMetabaseClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<Pick<MetabaseRuntimeClient, 'testConnection' | 'getDatabases' | 'cleanup'>> {
  const factory = new DefaultMetabaseConnectionClientFactory(
    (metabaseConnectionId) =>
      metabaseRuntimeConfigFromLocalConnection(metabaseConnectionId, project.config.connections[metabaseConnectionId]),
    DEFAULT_METABASE_CLIENT_CONFIG,
  );
  return factory.createClient(connectionId);
}

async function defaultMintMetabaseApiKey(args: MintMetabaseApiKeyArgs): Promise<string> {
  const loginClient = new MetabaseClient({ apiUrl: args.url, apiKey: '' }, DEFAULT_METABASE_CLIENT_CONFIG);
  const sessionId = await loginClient.createSession(args.username, args.password);
  const sessionClient = new MetabaseClient(
    { apiUrl: args.url, apiKey: sessionId, authHeaderName: 'X-Metabase-Session' },
    DEFAULT_METABASE_CLIENT_CONFIG,
  );
  const groups = await sessionClient.getPermissionGroups();
  const adminGroup = groups.find((group) => group.name === 'Administrators');

  if (!adminGroup) {
    throw new Error('Metabase Administrators group was not found; create an API key manually and pass --api-key');
  }

  const mintedKey = await sessionClient.createApiKey({
    groupId: adminGroup.id,
    name: `KTX CLI ${new Date().toISOString()}`,
  });
  const trimmedKey = stringField(mintedKey);
  if (!trimmedKey) {
    throw new Error('Metabase API key minting returned an empty key');
  }
  return trimmedKey;
}

function ensureNotCancelled<T>(value: T | symbol, prompts: Pick<MetabaseSetupPromptAdapter, 'cancel'>): T {
  if (isCancel(value)) {
    prompts.cancel('Setup cancelled.');
    throw new Error('Setup cancelled.');
  }
  return value as T;
}

export function createClackMetabaseSetupPromptAdapter(): MetabaseSetupPromptAdapter {
  return {
    intro(title?: string): void {
      intro(title);
    },
    outro(message?: string): void {
      outro(message);
    },
    note(message: string, title: string): void {
      note(message, title);
    },
    log: {
      info(message: string): void {
        log.info(message);
      },
      step(message: string): void {
        log.step(message);
      },
      success(message: string): void {
        log.success(message);
      },
      warn(message: string): void {
        log.warn(message);
      },
      error(message: string): void {
        log.error(message);
      },
    },
    spinner(): KtxCliSpinner {
      return createClackSpinner();
    },
    async select<T extends string>(options: {
      message: string;
      options: Array<MetabaseSetupPromptOption<T>>;
    }): Promise<T> {
      return ensureNotCancelled(await select(withMenuOptionsSpacing(options)), this);
    },
    async multiselect<Value extends number | string>(options: {
      message: string;
      options: Array<MetabaseSetupPromptOption<Value>>;
      initialValues?: Value[];
      required?: boolean;
      maxItems?: number;
    }): Promise<Value[]> {
      return ensureNotCancelled(await multiselect(withMenuOptionsSpacing(options)), this);
    },
    async text(options: { message: string; placeholder?: string }): Promise<string> {
      return ensureNotCancelled(await text(options), this);
    },
    async password(options: { message: string }): Promise<string> {
      return ensureNotCancelled(await password(options), this);
    },
    async confirm(options: { message: string; initialValue?: boolean }): Promise<boolean> {
      return ensureNotCancelled(await confirm(options), this);
    },
    cancel(message: string): void {
      cancel(message);
    },
  };
}

function isInteractiveMetabaseSetupIo(
  args: Pick<KtxConnectionMetabaseSetupArgs, 'inputMode'>,
  io: KtxMetabaseSetupInteractiveIo,
): boolean {
  return args.inputMode !== 'disabled' && io.stdin?.isTTY === true && io.stdout.isTTY === true;
}

function normalizeDiscoveredDatabases(databases: MetabaseDatabase[]): Array<{
  id: number;
  name: string;
  engine: string;
  host: string | null;
  dbName: string | null;
}> {
  return databases
    .filter((database) => database.is_sample !== true)
    .map((database) => ({
      id: database.id,
      name: database.name,
      engine: stringField(database.engine) ?? 'unknown',
      host: stringField(database.details?.host) ?? null,
      dbName: stringField(database.details?.dbname) ?? null,
    }));
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

function noteMetabaseSetupSummary(options: {
  prompts: MetabaseSetupPromptAdapter;
  connectionId: string;
  url: string;
  mappings: MetabaseSetupMappingAssignment[];
  syncEnabledDatabaseIds: number[];
}): void {
  const mappingLines = options.mappings
    .map((mapping) => `  ${mapping.metabaseDatabaseId} -> ${mapping.targetConnectionId}`)
    .join('\n');
  const syncLines = options.syncEnabledDatabaseIds.map((id) => `  ${id}`).join('\n');

  options.prompts.note(
    [
      `Connection: ${options.connectionId}`,
      `URL: ${options.url}`,
      '',
      'Mappings:',
      mappingLines || '  (none)',
      '',
      'Sync enabled:',
      syncLines || '  (none)',
    ].join('\n'),
    'Summary',
  );
}

function metabaseMappingsBlockForSetup(options: {
  connectionId: string;
  connection: KtxProjectConnectionConfig;
  mappings: MetabaseSetupMappingAssignment[];
  syncEnabledDatabaseIds: number[];
  syncMode: MetabaseSetupSyncMode;
}): Record<string, unknown> {
  const existing = parseMetabaseMappingBootstrap(options.connectionId, options.connection);
  const databaseMappings = { ...existing.databaseMappings };
  const syncEnabled = { ...existing.syncEnabled };
  for (const mapping of options.mappings) {
    const key = String(mapping.metabaseDatabaseId);
    databaseMappings[key] = mapping.targetConnectionId;
    syncEnabled[key] = false;
  }
  for (const metabaseDatabaseId of options.syncEnabledDatabaseIds) {
    syncEnabled[String(metabaseDatabaseId)] = true;
  }
  return {
    databaseMappings,
    syncEnabled,
    syncMode: options.syncMode,
    selections: existing.selections,
    defaultTagNames: existing.defaultTagNames,
  };
}

export async function runKtxConnectionMetabaseSetup(
  args: KtxConnectionMetabaseSetupArgs,
  io: KtxCliIo,
  deps: KtxConnectionMetabaseSetupDeps = {},
): Promise<number> {
  let apiKeyForRedaction = args.apiKey;
  let passwordForRedaction = args.metabasePassword;
  const interactiveIo = io as KtxMetabaseSetupInteractiveIo;
  const isInteractive = isInteractiveMetabaseSetupIo(args, interactiveIo);
  const prompts = deps.prompts ?? (isInteractive ? createClackMetabaseSetupPromptAdapter() : undefined);

  try {
    if (isInteractive && prompts) {
      prompts.intro('KTX Metabase setup');
    }

    const project = await loadKtxProject({ projectDir: args.projectDir });
    const existingMetabaseConnectionIds = listMetabaseConnectionIds(project);
    let connectionId: string;

    if (args.connectionId) {
      connectionId = args.connectionId;
    } else if (existingMetabaseConnectionIds.length === 1) {
      const onlyMetabaseConnectionId = existingMetabaseConnectionIds[0];
      if (!onlyMetabaseConnectionId) {
        throw new Error('No Metabase connection id was resolved');
      }
      connectionId = onlyMetabaseConnectionId;
    } else if (existingMetabaseConnectionIds.length > 1) {
      if (!isInteractive || !prompts) {
        throw new Error(
          `Multiple Metabase connections found (${existingMetabaseConnectionIds.join(', ')}); select one with --id`,
        );
      }
      connectionId = await prompts.select({
        message: 'Select the Metabase connection to configure',
        options: existingMetabaseConnectionIds.map((id) => ({ value: id, label: id })),
      });
    } else {
      connectionId = 'metabase';
    }

    const existingConnection = project.config.connections[connectionId];
    const warehouseConnectionIds = listWarehouseConnectionIds(project);

    if (warehouseConnectionIds.length === 0) {
      throw new Error('Add a warehouse connection first');
    }

    let url = args.url ?? resolveMetabaseUrl(existingConnection);
    let apiKey = args.apiKey ?? resolveLiteralMetabaseApiKey(existingConnection);
    apiKeyForRedaction = apiKey;

    if (!url && isInteractive && prompts) {
      url = stringField(
        await prompts.text({
          message: 'Metabase API URL',
          placeholder: 'http://localhost:3000',
        }),
      );
    }

    if (args.inputMode === 'disabled' && !url) {
      throw new Error('missing Metabase URL');
    }

    if (!args.apiKey && !args.mintApiKey && apiKey && isInteractive && prompts && !args.yes) {
      const reuse = await prompts.confirm({
        message: `Reuse the existing Metabase API key from connections.${connectionId}?`,
        initialValue: true,
      });
      if (!reuse) {
        apiKey = undefined;
        apiKeyForRedaction = undefined;
      }
    }

    if (args.mintApiKey) {
      let username = stringField(args.metabaseUsername);
      let metabasePassword = stringField(args.metabasePassword);

      if (isInteractive && prompts) {
        if (!username) {
          username = stringField(await prompts.text({ message: 'Metabase admin username' }));
        }
        if (!metabasePassword) {
          metabasePassword = stringField(await prompts.password({ message: 'Metabase admin password' }));
        }
      }

      if (!username) {
        throw new Error('--mint-api-key requires --username');
      }
      if (!metabasePassword) {
        throw new Error('--mint-api-key requires --password');
      }
      if (!url) {
        throw new Error('Metabase URL is required (use --url)');
      }

      passwordForRedaction = metabasePassword;
      apiKey = await (deps.mintMetabaseApiKey ?? defaultMintMetabaseApiKey)(
        { url, username, password: metabasePassword },
        io,
      );
      apiKeyForRedaction = apiKey;
    }

    if (!apiKey && isInteractive && prompts) {
      const credentialMode = await prompts.select({
        message: 'Metabase credentials',
        options: [
          { value: 'paste', label: 'Paste API key' },
          { value: 'mint', label: 'Mint API key' },
        ],
      });

      if (credentialMode === 'paste') {
        apiKey = stringField(await prompts.password({ message: 'Metabase API key' }));
        apiKeyForRedaction = apiKey;
      } else {
        const username = stringField(await prompts.text({ message: 'Metabase admin username' }));
        const metabasePassword = stringField(await prompts.password({ message: 'Metabase admin password' }));
        if (!username) {
          throw new Error('Metabase username is required');
        }
        if (!metabasePassword) {
          throw new Error('Metabase password is required');
        }
        if (!url) {
          throw new Error('Metabase URL is required (use --url)');
        }

        passwordForRedaction = metabasePassword;
        apiKey = await (deps.mintMetabaseApiKey ?? defaultMintMetabaseApiKey)(
          { url, username, password: metabasePassword },
          io,
        );
        apiKeyForRedaction = apiKey;
      }
    }

    if (args.inputMode === 'disabled' && !apiKey) {
      throw new Error('missing Metabase API key');
    }

    if (!url) {
      throw new Error('Metabase URL is required (use --url)');
    }
    if (!apiKey) {
      throw new Error('Metabase API key is required (use --api-key)');
    }

    const transientConnectionConfig: KtxProjectConnectionConfig = {
      ...(existingConnection ?? {}),
      driver: 'metabase',
      api_url: url,
      api_key: apiKey,
    };
    const configWithTransient = {
      ...project.config,
      connections: {
        ...project.config.connections,
        [connectionId]: transientConnectionConfig,
      },
    };
    const discoveryProject: KtxLocalProject = { ...project, config: configWithTransient };

    for (const mapping of args.mappings) {
      if (!configWithTransient.connections[mapping.targetConnectionId]) {
        throw new Error(`Target connection "${mapping.targetConnectionId}" does not exist`);
      }
    }

    const client = await (deps.createMetabaseClient ?? createDefaultMetabaseClient)(discoveryProject, connectionId);
    try {
      const authSpinner = isInteractive && prompts ? prompts.spinner() : undefined;
      authSpinner?.start('Testing Metabase connection');
      const testResult = await client.testConnection();
      if (!testResult.success) {
        authSpinner?.error('Metabase authentication failed');
        throw new Error(
          `Metabase authentication failed. Replace connections.${connectionId}.api_key or use --mint-api-key.`,
        );
      }
      authSpinner?.stop('Metabase reachable');

      const discoverySpinner = isInteractive && prompts ? prompts.spinner() : undefined;
      discoverySpinner?.start('Discovering Metabase databases');
      const discovered = normalizeDiscoveredDatabases(await client.getDatabases());
      discoverySpinner?.stop(`Discovered ${discovered.length} ${discovered.length === 1 ? 'database' : 'databases'}`);
      if (isInteractive && prompts) {
        prompts.log.success(
          `Discovered ${discovered.length} ${discovered.length === 1 ? 'database' : 'databases'}`,
        );
      }
      if (discovered.length === 0) {
        throw new Error('Metabase auth worked but no usable databases were returned');
      }

      let resolvedMappings = args.mappings;
      let resolvedSyncEnabledDatabaseIds = args.syncEnabledDatabaseIds;

      if (resolvedSyncEnabledDatabaseIds.length === 0 && args.yes && resolvedMappings.length > 0) {
        resolvedSyncEnabledDatabaseIds = uniqueSorted(resolvedMappings.map((mapping) => mapping.metabaseDatabaseId));
      }

      if (resolvedMappings.length === 0 && resolvedSyncEnabledDatabaseIds.length === 0) {
        const onlyDiscoveredDatabase = discovered.length === 1 ? discovered[0] : undefined;
        const compatibleWarehouses = onlyDiscoveredDatabase
          ? warehouseConnectionIds.filter((warehouseConnectionId) => {
              const mismatchReason = validateMappingPhysicalMatch(
                {
                  metabaseEngine: onlyDiscoveredDatabase.engine,
                  metabaseDbName: onlyDiscoveredDatabase.dbName,
                  metabaseHost: onlyDiscoveredDatabase.host,
                },
                targetPhysicalInfo(project, warehouseConnectionId),
              );
              return !mismatchReason;
            })
          : [];
        const onlyWarehouseConnectionId = compatibleWarehouses[0];

        if (onlyDiscoveredDatabase && compatibleWarehouses.length === 1 && onlyWarehouseConnectionId) {
          if (args.yes) {
            resolvedMappings = [
              { metabaseDatabaseId: onlyDiscoveredDatabase.id, targetConnectionId: onlyWarehouseConnectionId },
            ];
            resolvedSyncEnabledDatabaseIds = [onlyDiscoveredDatabase.id];
          } else if (isInteractive && prompts) {
            const proposedMappings = [
              { metabaseDatabaseId: onlyDiscoveredDatabase.id, targetConnectionId: onlyWarehouseConnectionId },
            ];
            const proposedSyncEnabledDatabaseIds = [onlyDiscoveredDatabase.id];
            noteMetabaseSetupSummary({
              prompts,
              connectionId,
              url,
              mappings: proposedMappings,
              syncEnabledDatabaseIds: proposedSyncEnabledDatabaseIds,
            });
            const confirmed = await prompts.confirm({
              message: `Map Metabase database "${onlyDiscoveredDatabase.name}" (${onlyDiscoveredDatabase.id}) to "${onlyWarehouseConnectionId}" and enable sync?`,
              initialValue: true,
            });
            if (!confirmed) {
              prompts.cancel('Setup cancelled.');
              throw new Error('Setup cancelled.');
            }
            resolvedMappings = proposedMappings;
            resolvedSyncEnabledDatabaseIds = proposedSyncEnabledDatabaseIds;
          } else {
            throw new Error('Metabase mapping/sync is required in --no-input mode; pass --map and --sync');
          }
        } else if (isInteractive && prompts) {
          const selectedDatabaseIds = await prompts.multiselect<number>({
            message: withMultiselectNavigation('Select Metabase databases to configure'),
            options: discovered.map((database) => ({
              value: database.id,
              label: `${database.id}: ${database.name}`,
              hint: [database.engine, database.host, database.dbName].filter(Boolean).join(' • '),
            })),
            required: true,
          });

          resolvedMappings = [];
          for (const databaseId of selectedDatabaseIds) {
            const database = discovered.find((candidate) => candidate.id === databaseId);
            if (!database) {
              throw new Error(`Selected database id ${databaseId} was not discovered`);
            }

            const existingMapping = args.mappings.find((mapping) => mapping.metabaseDatabaseId === databaseId);
            if (existingMapping) {
              resolvedMappings.push(existingMapping);
              continue;
            }

            const targetConnectionId = await prompts.select({
              message: `Map Metabase database ${database.id} ("${database.name}") to which KTX connection?`,
              options: warehouseConnectionIds.map((warehouseId) => ({ value: warehouseId, label: warehouseId })),
            });
            resolvedMappings.push({ metabaseDatabaseId: databaseId, targetConnectionId });
          }

          const syncIds = await prompts.multiselect<number>({
            message: withMultiselectNavigation('Enable sync for which databases?'),
            options: selectedDatabaseIds.map((id) => ({ value: id, label: String(id) })),
            initialValues: selectedDatabaseIds,
            required: true,
          });
          resolvedSyncEnabledDatabaseIds = uniqueSorted(syncIds);

          if (!args.yes) {
            noteMetabaseSetupSummary({
              prompts,
              connectionId,
              url,
              mappings: resolvedMappings,
              syncEnabledDatabaseIds: resolvedSyncEnabledDatabaseIds,
            });
            const confirmed = await prompts.confirm({
              message: 'Write changes to ktx.yaml and enable sync?',
              initialValue: true,
            });
            if (!confirmed) {
              prompts.cancel('Setup cancelled.');
              throw new Error('Setup cancelled.');
            }
          }
        } else if (args.inputMode === 'disabled') {
          throw new Error('Metabase mapping/sync is required in --no-input mode; pass --map and --sync');
        }
      }

      if (
        args.inputMode === 'disabled' &&
        resolvedMappings.length > 0 &&
        resolvedSyncEnabledDatabaseIds.length === 0
      ) {
        throw new Error('Metabase sync selection is required in --no-input mode; pass --sync <metabaseDatabaseId>');
      }

      const discoveredIds = new Set(discovered.map((database) => database.id));
      for (const mapping of resolvedMappings) {
        if (!discoveredIds.has(mapping.metabaseDatabaseId)) {
          throw new Error(`Mapped database id ${mapping.metabaseDatabaseId} was not discovered`);
        }
      }
      for (const syncId of resolvedSyncEnabledDatabaseIds) {
        if (!discoveredIds.has(syncId)) {
          throw new Error(`Sync database id ${syncId} was not discovered`);
        }
      }

      const finalConnectionConfig: KtxProjectConnectionConfig = {
        ...transientConnectionConfig,
        mappings: metabaseMappingsBlockForSetup({
          connectionId,
          connection: transientConnectionConfig,
          mappings: resolvedMappings,
          syncEnabledDatabaseIds: resolvedSyncEnabledDatabaseIds,
          syncMode: args.syncMode,
        }),
      };
      const finalConfig = {
        ...configWithTransient,
        connections: {
          ...configWithTransient.connections,
          [connectionId]: finalConnectionConfig,
        },
      };
      await project.fileStore.writeFile(
        'ktx.yaml',
        serializeKtxProjectConfig(stripKtxSetupCompletedSteps(finalConfig)),
        'ktx',
        'ktx@example.com',
        `Setup Metabase connection ${connectionId}`,
      );

      const updatedProject = await loadKtxProject({ projectDir: args.projectDir });
      const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: ktxLocalStateDbPath(updatedProject) });
      await discoveryCache.refreshDiscoveredDatabases({ connectionId, discovered });
      const rows = await new KtxYamlMetabaseSourceStateReader(updatedProject, { discoveryCache }).listDatabaseMappings(
        connectionId,
      );
      const physicalFailures = rows.flatMap((row) => {
        if (!row.targetConnectionId) {
          return [];
        }
        const reason = validateMappingPhysicalMatch(
          { metabaseEngine: row.metabaseEngine, metabaseDbName: row.metabaseDbName, metabaseHost: row.metabaseHost },
          updatedProject.config.connections[row.targetConnectionId]
            ? targetPhysicalInfo(updatedProject, row.targetConnectionId)
            : { connection_type: 'UNKNOWN' },
        );
        return reason ? [`${row.metabaseDatabaseId}: ${reason}`] : [];
      });
      if (physicalFailures.length > 0) {
        for (const failure of physicalFailures) {
          io.stderr.write(`${failure}\n`);
        }
        return 1;
      }

      io.stdout.write(`Connection: ${connectionId}\n`);
      io.stdout.write(`Discovered ${discovered.length} ${discovered.length === 1 ? 'database' : 'databases'}\n`);
      io.stdout.write(
        `Next: ktx ingest run --connection-id ${connectionId} --adapter metabase --project-dir ${args.projectDir}\n`,
      );

      if (args.runIngest) {
        const ingestRunner = deps.runPublicIngest ?? runKtxPublicIngest;
        const exitCode = await ingestRunner(
          {
            command: 'run',
            projectDir: args.projectDir,
            targetConnectionId: connectionId,
            all: false,
            json: false,
            inputMode: 'disabled',
          },
          io,
        );
        if (exitCode !== 0) {
          io.stderr.write(
            `Ingest failed; re-run: ktx ingest run --connection-id ${connectionId} --adapter metabase --project-dir ${args.projectDir}\n`,
          );
          return 1;
        }
      }

      if (isInteractive && prompts) {
        prompts.outro('Metabase setup complete');
      }

      return 0;
    } finally {
      await client.cleanup();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(
      `${redactSecrets(message, [apiKeyForRedaction ?? '', passwordForRedaction ?? '', args.apiKey ?? ''])}\n`,
    );
    return 1;
  }
}
