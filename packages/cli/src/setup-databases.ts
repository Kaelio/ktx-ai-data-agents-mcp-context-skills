import { writeFile } from 'node:fs/promises';
import { cancel, isCancel, multiselect, password, select, text } from '@clack/prompts';
import type { HistoricSqlDialect } from '@ktx/context/ingest';
import {
  type KtxProjectConnectionConfig,
  loadKtxProject,
  markKtxSetupStateStepComplete,
  serializeKtxProjectConfig,
  setKtxSetupDatabaseConnectionIds,
  stripKtxSetupCompletedSteps,
} from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import { runKtxConnection } from './connection.js';
import { withMenuOptionsSpacing, withMultiselectNavigation, withTextInputNavigation } from './prompt-navigation.js';
import { runKtxScan } from './scan.js';
import { withSetupInterruptConfirmation } from './setup-interrupt.js';
import { writeProjectLocalSecretReference } from './setup-secrets.js';

const HISTORIC_SQL_WORK_UNIT_MAX_CONCURRENCY = 6;

export type KtxSetupDatabaseDriver =
  | 'sqlite'
  | 'postgres'
  | 'mysql'
  | 'clickhouse'
  | 'sqlserver'
  | 'bigquery'
  | 'snowflake';

export interface KtxSetupDatabasesArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  databaseDrivers?: KtxSetupDatabaseDriver[];
  databaseConnectionIds?: string[];
  databaseConnectionId?: string;
  databaseUrl?: string;
  databaseSchemas: string[];
  enableHistoricSql?: boolean;
  disableHistoricSql?: boolean;
  historicSqlWindowDays?: number;
  historicSqlMinExecutions?: number;
  historicSqlMinCalls?: number;
  historicSqlServiceAccountPatterns?: string[];
  historicSqlRedactionPatterns?: string[];
  skipDatabases: boolean;
}

export type KtxSetupDatabasesResult =
  | { status: 'ready'; projectDir: string; connectionIds: string[] }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

export interface KtxSetupDatabasesPromptAdapter {
  multiselect(options: {
    message: string;
    options: Array<{ value: string; label: string }>;
    required?: boolean;
    initialValues?: string[];
  }): Promise<string[]>;
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<string>;
  text(options: { message: string; placeholder?: string; initialValue?: string }): Promise<string | undefined>;
  password(options: { message: string }): Promise<string | undefined>;
  cancel(message: string): void;
}

interface KtxSetupHistoricSqlProbeInput {
  projectDir: string;
  connectionId: string;
  dialect: HistoricSqlDialect;
}

interface KtxSetupHistoricSqlProbeResult {
  ok: boolean;
  lines: string[];
}

type KtxSetupHistoricSqlProbe = (input: KtxSetupHistoricSqlProbeInput) => Promise<KtxSetupHistoricSqlProbeResult>;

export interface KtxSetupDatabasesDeps {
  prompts?: KtxSetupDatabasesPromptAdapter;
  testConnection?: (projectDir: string, connectionId: string, io: KtxCliIo) => Promise<number>;
  scanConnection?: (projectDir: string, connectionId: string, io: KtxCliIo) => Promise<number>;
  listSchemas?: (projectDir: string, connectionId: string) => Promise<string[]>;
  historicSqlProbe?: KtxSetupHistoricSqlProbe;
}

const DRIVER_OPTIONS: Array<{ value: KtxSetupDatabaseDriver; label: string }> = [
  { value: 'sqlite', label: 'SQLite' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'clickhouse', label: 'ClickHouse' },
  { value: 'sqlserver', label: 'SQL Server' },
  { value: 'bigquery', label: 'BigQuery' },
  { value: 'snowflake', label: 'Snowflake' },
];

const DRIVER_LABELS = Object.fromEntries(DRIVER_OPTIONS.map((option) => [option.value, option.label])) as Record<
  KtxSetupDatabaseDriver,
  string
>;

const HISTORIC_SQL_DIALECT_BY_DRIVER: Partial<Record<KtxSetupDatabaseDriver, HistoricSqlDialect>> = {
  snowflake: 'snowflake',
  bigquery: 'bigquery',
  postgres: 'postgres',
};

const DEFAULT_CONNECTION_IDS: Record<KtxSetupDatabaseDriver, string> = {
  sqlite: 'sqlite-local',
  postgres: 'postgres-warehouse',
  mysql: 'mysql-warehouse',
  clickhouse: 'clickhouse-warehouse',
  sqlserver: 'sqlserver-warehouse',
  bigquery: 'bigquery-warehouse',
  snowflake: 'snowflake-warehouse',
};

interface ScopeDiscoverySpec {
  noun: string;
  nounPlural: string;
  promptLabel: string;
  configArrayField: string;
  configSingleField: string;
  defaultSelection: (values: string[]) => string[];
}

const SCOPE_DISCOVERY_SPECS: Partial<Record<KtxSetupDatabaseDriver, ScopeDiscoverySpec>> = {
  postgres: {
    noun: 'schema',
    nounPlural: 'schemas',
    promptLabel: 'PostgreSQL schemas',
    configArrayField: 'schemas',
    configSingleField: 'schema',
    defaultSelection(schemas) {
      const nonPublic = schemas.filter((s) => s !== 'public');
      return nonPublic.length > 0 ? nonPublic : schemas;
    },
  },
  sqlserver: {
    noun: 'schema',
    nounPlural: 'schemas',
    promptLabel: 'SQL Server schemas',
    configArrayField: 'schemas',
    configSingleField: 'schema',
    defaultSelection: (schemas) => schemas,
  },
  bigquery: {
    noun: 'dataset',
    nounPlural: 'datasets',
    promptLabel: 'BigQuery datasets',
    configArrayField: 'dataset_ids',
    configSingleField: 'dataset_id',
    defaultSelection: (datasets) => datasets,
  },
  snowflake: {
    noun: 'schema',
    nounPlural: 'schemas',
    promptLabel: 'Snowflake schemas',
    configArrayField: 'schema_names',
    configSingleField: 'schema_name',
    defaultSelection(schemas) {
      const nonPublic = schemas.filter((s) => s !== 'PUBLIC');
      return nonPublic.length > 0 ? nonPublic : schemas;
    },
  },
};

type UrlDriverType = Extract<KtxSetupDatabaseDriver, 'postgres' | 'mysql' | 'clickhouse' | 'sqlserver'>;

const DRIVER_CONNECTION_DEFAULTS: Record<UrlDriverType, { port: string }> = {
  postgres: { port: '5432' },
  mysql: { port: '3306' },
  clickhouse: { port: '8123' },
  sqlserver: { port: '1433' },
};

function driverLabel(driver: KtxSetupDatabaseDriver): string {
  return DRIVER_LABELS[driver];
}

function connectionNamePrompt(label: string): string {
  return `Name this ${label} connection\nKTX will use this short name in commands and config. You can rename it now.`;
}

function missingConnectionDetailsPrompt(
  label: string,
  canReturnToDriverSelection: boolean,
): { message: string; options: Array<{ value: string; label: string }> } {
  const backDestination = canReturnToDriverSelection ? 'primary source selection' : 'the previous setup step';
  return {
    message:
      `Some ${label} connection details are missing.\n` +
      `Continue entering details, or go back to ${backDestination}.`,
    options: [
      { value: 'retry', label: `Continue entering ${label} details` },
      { value: 'back', label: `Back to ${backDestination}` },
    ],
  };
}

function createPromptAdapter(): KtxSetupDatabasesPromptAdapter {
  return {
    async multiselect(options) {
      const value = await withSetupInterruptConfirmation(() => multiselect(withMenuOptionsSpacing(options)));
      if (isCancel(value)) {
        cancel('Setup cancelled.');
        return ['back'];
      }
      return [...value] as string[];
    },
    async select(options) {
      const value = await withSetupInterruptConfirmation(() => select(withMenuOptionsSpacing(options)));
      if (isCancel(value)) {
        cancel('Setup cancelled.');
        return 'back';
      }
      return String(value);
    },
    async text(options) {
      const value = await withSetupInterruptConfirmation(() =>
        text({ ...options, message: withTextInputNavigation(options.message) }),
      );
      return isCancel(value) ? undefined : String(value);
    },
    async password(options) {
      const value = await withSetupInterruptConfirmation(() =>
        password({ ...options, message: withTextInputNavigation(options.message) }),
      );
      return isCancel(value) ? undefined : String(value);
    },
    cancel(message) {
      cancel(message);
    },
  };
}

function normalizeDriver(driver: string | undefined): KtxSetupDatabaseDriver | null {
  const normalized = String(driver ?? '').toLowerCase();
  if (normalized === 'postgresql') return 'postgres';
  if (normalized === 'sqlite3') return 'sqlite';
  return DRIVER_OPTIONS.some((option) => option.value === normalized) ? (normalized as KtxSetupDatabaseDriver) : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function historicSqlConfigRecord(connection: KtxProjectConnectionConfig | undefined): Record<string, unknown> | null {
  const historicSql = connection?.historicSql;
  return historicSql && typeof historicSql === 'object' && !Array.isArray(historicSql)
    ? (historicSql as Record<string, unknown>)
    : null;
}

function historicSqlProbeFailureLines(error: unknown): string[] {
  if (error instanceof Error && error.name === 'HistoricSqlExtensionMissingError') {
    return [
      '  FAIL pg_stat_statements extension is not installed in the connection database',
      '  Fix: Run (against this database): CREATE EXTENSION pg_stat_statements;',
      "  Fix: Ensure shared_preload_libraries includes 'pg_stat_statements'.",
    ];
  }
  if (error instanceof Error && error.name === 'HistoricSqlGrantsMissingError') {
    return [
      '  FAIL Postgres connection role lacks pg_read_all_stats',
      '  Fix: Run: GRANT pg_read_all_stats TO <connection role>;',
    ];
  }
  if (error instanceof Error && error.name === 'HistoricSqlVersionUnsupportedError') {
    return [`  FAIL ${error.message}`];
  }
  return [`  FAIL Historic SQL probe failed: ${error instanceof Error ? error.message : String(error)}`];
}

async function defaultHistoricSqlProbe(input: KtxSetupHistoricSqlProbeInput): Promise<KtxSetupHistoricSqlProbeResult> {
  if (input.dialect !== 'postgres') {
    return { ok: true, lines: [] };
  }

  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  const [{ PostgresPgssReader }, { KtxPostgresHistoricSqlQueryClient, isKtxPostgresConnectionConfig }] =
    await Promise.all([import('@ktx/context/ingest'), import('@ktx/connector-postgres')]);

  const postgresConnection = connection as Parameters<typeof isKtxPostgresConnectionConfig>[0];
  if (!isKtxPostgresConnectionConfig(postgresConnection)) {
    return {
      ok: false,
      lines: [`  FAIL Connection ${input.connectionId} is not a native Postgres connection.`],
    };
  }

  const client = new KtxPostgresHistoricSqlQueryClient({
    connectionId: input.connectionId,
    connection: postgresConnection,
  });
  try {
    const result = await new PostgresPgssReader().probe(client);
    return {
      ok: true,
      lines: [
        `  OK pg_stat_statements ready (${result.pgServerVersion})`,
        ...result.warnings.map((warning: string) => `  ! ${warning}`),
      ],
    };
  } catch (error) {
    return { ok: false, lines: historicSqlProbeFailureLines(error) };
  } finally {
    await client.cleanup();
  }
}

async function defaultListSchemas(projectDir: string, connectionId: string): Promise<string[]> {
  const project = await loadKtxProject({ projectDir });
  const connection = project.config.connections[connectionId];
  const driver = normalizeDriver(connection?.driver);

  if (driver === 'postgres') {
    const { KtxPostgresScanConnector, isKtxPostgresConnectionConfig } = await import('@ktx/connector-postgres');
    if (!isKtxPostgresConnectionConfig(connection)) return [];
    const connector = new KtxPostgresScanConnector({ connectionId, connection });
    try {
      return await connector.listSchemas();
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'sqlserver') {
    const { KtxSqlServerScanConnector, isKtxSqlServerConnectionConfig } = await import('@ktx/connector-sqlserver');
    if (!isKtxSqlServerConnectionConfig(connection)) return [];
    const connector = new KtxSqlServerScanConnector({ connectionId, connection });
    try {
      return await connector.listSchemas();
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'bigquery') {
    const { KtxBigQueryScanConnector, isKtxBigQueryConnectionConfig } = await import('@ktx/connector-bigquery');
    if (!isKtxBigQueryConnectionConfig(connection)) return [];
    const connector = new KtxBigQueryScanConnector({ connectionId, connection });
    try {
      return await connector.listDatasets();
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'snowflake') {
    const { KtxSnowflakeScanConnector, isKtxSnowflakeConnectionConfig } = await import('@ktx/connector-snowflake');
    if (!isKtxSnowflakeConnectionConfig(connection)) return [];
    const connector = new KtxSnowflakeScanConnector({ connectionId, connection });
    try {
      return await connector.listSchemas();
    } finally {
      await connector.cleanup();
    }
  }

  return [];
}

function existingConnectionIdsByDriver(
  connections: Record<string, KtxProjectConnectionConfig>,
  driver: KtxSetupDatabaseDriver,
): string[] {
  return Object.entries(connections)
    .filter(([, connection]) => normalizeDriver(connection.driver) === driver)
    .map(([connectionId]) => connectionId)
    .sort((left, right) => left.localeCompare(right));
}

function configuredPrimaryConnectionIds(
  connections: Record<string, KtxProjectConnectionConfig>,
  setupConnectionIds: string[] | undefined,
): string[] {
  const configuredIds =
    setupConnectionIds
      ?.filter((connectionId) => normalizeDriver(connections[connectionId]?.driver) !== null)
      .filter((connectionId, index, ids) => ids.indexOf(connectionId) === index) ?? [];
  if (configuredIds.length > 0) {
    return configuredIds;
  }
  return Object.entries(connections)
    .filter(([, connection]) => normalizeDriver(connection.driver) !== null)
    .map(([connectionId]) => connectionId)
    .sort((left, right) => left.localeCompare(right));
}

function configuredPrimarySourcesPrompt(connectionIds: string[]): {
  message: string;
  options: Array<{ value: string; label: string }>;
} {
  return {
    message: `Primary sources already configured: ${connectionIds.join(', ')}\nWhat would you like to do?`,
    options: [
      { value: 'continue', label: 'Continue to knowledge sources' },
      { value: 'add', label: 'Add another primary source' },
      { value: 'back', label: 'Back' },
    ],
  };
}

function pushUniqueConnectionId(connectionIds: string[], connectionId: string): void {
  if (!connectionIds.includes(connectionId)) {
    connectionIds.push(connectionId);
  }
}

function defaultConnectionIdForDriver(
  connections: Record<string, KtxProjectConnectionConfig>,
  driver: KtxSetupDatabaseDriver,
): string {
  const base = DEFAULT_CONNECTION_IDS[driver];
  if (!connections[base]) {
    return base;
  }
  let index = 2;
  while (connections[`${base}-${index}`]) {
    index += 1;
  }
  return `${base}-${index}`;
}

async function promptText(
  prompts: KtxSetupDatabasesPromptAdapter,
  message: string,
  fallback?: string,
): Promise<string | undefined> {
  const value = await prompts.text({
    message: withTextInputNavigation(message),
    ...(fallback ? { placeholder: fallback, initialValue: fallback } : {}),
  });
  if (value === undefined) {
    return undefined;
  }
  return value.trim() || fallback || '';
}

function urlHasCredentials(url: string): boolean {
  return /:\/\/[^/\s]*@/.test(url);
}

function normalizeInputReference(value: string): string {
  if (value.startsWith('$') && /^\$[A-Z_][A-Z0-9_]*$/i.test(value)) {
    return `env:${value.slice(1)}`;
  }
  return value;
}

function normalizeFileReference(value: string): string {
  const normalized = normalizeInputReference(value);
  if (normalized.startsWith('env:') || normalized.startsWith('file:')) {
    return normalized;
  }
  return `file:${normalized}`;
}

async function promptCredential(input: {
  prompts: KtxSetupDatabasesPromptAdapter;
  message: string;
  projectDir: string;
  connectionId: string;
  secretName: string;
}): Promise<string | null | 'back'> {
  const value = await input.prompts.password({
    message: withTextInputNavigation(input.message),
  });
  if (value === undefined) return 'back';
  if (!value.trim()) return null;

  const normalized = normalizeInputReference(value.trim());
  if (normalized.startsWith('env:') || normalized.startsWith('file:')) {
    return normalized;
  }

  return await writeProjectLocalSecretReference({
    projectDir: input.projectDir,
    fileName: `${input.connectionId}-${input.secretName}`,
    value: normalized,
  });
}

async function buildFieldsConnectionConfig(input: {
  driver: UrlDriverType;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const label = driverLabel(input.driver);
  const defaults = DRIVER_CONNECTION_DEFAULTS[input.driver];

  const host = await promptText(input.prompts, `${label} host`, 'localhost');
  if (host === undefined) return 'back';
  if (!host) return null;

  const portStr = await promptText(input.prompts, `${label} port`, defaults.port);
  if (portStr === undefined) return 'back';
  const port = Number(portStr || defaults.port);

  const database = await promptText(input.prompts, `${label} database name`);
  if (database === undefined) return 'back';
  if (!database) return null;

  const username = await promptText(input.prompts, `${label} username`);
  if (username === undefined) return 'back';
  if (!username) return null;

  let passwordRef: string | undefined;
  {
    const credentialResult = await promptCredential({
      prompts: input.prompts,
      message: `${label} password`,
      projectDir: input.args.projectDir,
      connectionId: input.connectionId,
      secretName: 'password', // pragma: allowlist secret
    });
    if (credentialResult === 'back') return 'back';
    if (credentialResult) passwordRef = credentialResult;
  }

  return {
    driver: input.driver,
    host,
    port,
    database,
    username,
    ...(passwordRef ? { password: passwordRef } : {}),
    ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
    readonly: true,
  };
}

async function buildPastedUrlConnectionConfig(input: {
  driver: UrlDriverType;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const label = driverLabel(input.driver);
  const rawUrl = await promptText(input.prompts, `${label} connection URL`);
  if (rawUrl === undefined) return 'back';
  if (!rawUrl) return null;

  const url = normalizeInputReference(rawUrl);

  if (url.startsWith('env:') || url.startsWith('file:')) {
    return {
      driver: input.driver,
      url,
      ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
      readonly: true,
    };
  }

  if (urlHasCredentials(url)) {
    const ref = await writeProjectLocalSecretReference({
      projectDir: input.args.projectDir,
      fileName: `${input.connectionId}-url`,
      value: url,
    });
    return {
      driver: input.driver,
      url: ref,
      ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
      readonly: true,
    };
  }

  return {
    driver: input.driver,
    url,
    ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
    readonly: true,
  };
}

async function buildUrlConnectionConfig(input: {
  driver: UrlDriverType;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  if (input.args.inputMode === 'disabled' && !input.args.databaseUrl) return null;

  if (input.args.databaseUrl) {
    const url = normalizeInputReference(input.args.databaseUrl);
    if (urlHasCredentials(url)) {
      const ref = await writeProjectLocalSecretReference({
        projectDir: input.args.projectDir,
        fileName: `${input.connectionId}-url`,
        value: url,
      });
      return {
        driver: input.driver,
        url: ref,
        ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
        readonly: true,
      };
    }
    return {
      driver: input.driver,
      url,
      ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
      readonly: true,
    };
  }

  const label = driverLabel(input.driver);
  while (true) {
    const choice = await input.prompts.select({
      message: `How do you want to connect to ${label}?`,
      options: [
        { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
        { value: 'url', label: 'Paste a connection URL' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    const result =
      choice === 'url' ? await buildPastedUrlConnectionConfig(input) : await buildFieldsConnectionConfig(input);
    if (result === 'back') continue;
    return result;
  }
}

async function buildConnectionConfig(input: {
  driver: KtxSetupDatabaseDriver;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const { driver, args, prompts } = input;
  if (driver === 'sqlite') {
    if (args.inputMode === 'disabled' && !args.databaseUrl) return null;
    const path =
      args.databaseUrl ??
      (await promptText(
        prompts,
        'SQLite database file\nEnter a relative or absolute path, for example ./warehouse.sqlite.',
      ));
    if (path === undefined) return 'back';
    return path ? { driver: 'sqlite', path, readonly: true } : null;
  }
  if (driver === 'postgres' || driver === 'mysql' || driver === 'clickhouse' || driver === 'sqlserver') {
    return await buildUrlConnectionConfig({ driver, connectionId: input.connectionId, args, prompts });
  }
  if (driver === 'bigquery') {
    const datasetId = await promptText(prompts, 'BigQuery dataset\nFor example analytics.');
    if (datasetId === undefined) return 'back';
    const credentialsPath = await promptText(prompts, 'Path to service account JSON file');
    if (credentialsPath === undefined) return 'back';
    const location = await promptText(
      prompts,
      'BigQuery location\nPress Enter for US, or enter a location like EU.',
      'US',
    );
    if (location === undefined) return 'back';
    if (!datasetId || !credentialsPath) return null;
    return {
      driver: 'bigquery',
      dataset_id: datasetId,
      credentials_json: normalizeFileReference(credentialsPath),
      ...(location ? { location } : {}),
      readonly: true,
    };
  }
  if (driver === 'snowflake') {
    const account = await promptText(prompts, 'Snowflake account identifier');
    if (account === undefined) return 'back';
    const warehouse = await promptText(prompts, 'Snowflake warehouse\nFor example ANALYTICS_WH.');
    if (warehouse === undefined) return 'back';
    const database = await promptText(prompts, 'Snowflake database name');
    if (database === undefined) return 'back';
    const schemaName = await promptText(
      prompts,
      'Snowflake schema\nPress Enter for PUBLIC, or enter a schema name.',
      'PUBLIC',
    );
    if (schemaName === undefined) return 'back';
    const username = await promptText(prompts, 'Snowflake username');
    if (username === undefined) return 'back';
    const passwordRef = await promptCredential({
      prompts,
      message: 'Snowflake password',
      projectDir: args.projectDir,
      connectionId: input.connectionId,
      secretName: 'password', // pragma: allowlist secret
    });
    if (passwordRef === 'back') return 'back'; // pragma: allowlist secret
    const role = await promptText(prompts, 'Snowflake role (optional)\nPress Enter to skip.');
    if (role === undefined) return 'back';
    if (!account || !warehouse || !database || !schemaName || !username || !passwordRef) return null;
    return {
      driver: 'snowflake',
      authMethod: 'password',
      account,
      warehouse,
      database,
      schema_name: schemaName,
      username,
      password: passwordRef,
      ...(role ? { role } : {}),
      readonly: true,
    };
  }
  throw new Error(`Unsupported database driver: ${driver}`);
}

async function maybeApplyHistoricSqlConfig(input: {
  connection: KtxProjectConnectionConfig;
  driver: KtxSetupDatabaseDriver;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<KtxProjectConnectionConfig | 'back'> {
  const dialect = HISTORIC_SQL_DIALECT_BY_DRIVER[input.driver];
  if (!dialect) {
    if (input.args.enableHistoricSql === true) {
      throw new Error(
        `Historic SQL setup is only supported for Snowflake, BigQuery, and Postgres, not ${driverLabel(input.driver)}.`,
      );
    }
    return input.connection;
  }

  let enabled = input.args.enableHistoricSql === true;
  if (input.args.disableHistoricSql === true) {
    enabled = false;
  } else if (input.args.inputMode !== 'disabled' && input.args.enableHistoricSql !== true && dialect !== 'postgres') {
    const choice = await input.prompts.select({
      message: `Enable Historic SQL query-history ingest for this ${driverLabel(input.driver)} connection?`,
      options: [
        { value: 'yes', label: 'Enable Historic SQL' },
        { value: 'no', label: 'Do not enable Historic SQL' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    enabled = choice === 'yes';
  }

  if (dialect === 'postgres' && input.args.enableHistoricSql !== true && input.args.disableHistoricSql !== true) {
    return input.connection;
  }

  const existing =
    typeof input.connection.historicSql === 'object' && input.connection.historicSql !== null
      ? (input.connection.historicSql as Record<string, unknown>)
      : {};

  if (!enabled) {
    return { ...input.connection, historicSql: { ...existing, enabled: false, dialect } };
  }

  const common: Record<string, unknown> = {
    ...existing,
    enabled: true,
    dialect,
    filters: historicSqlFiltersForSetup(input.args.historicSqlServiceAccountPatterns),
  };
  delete common[['serviceAccount', 'UserPatterns'].join('')];

  if (dialect === 'postgres') {
    return {
      ...input.connection,
      historicSql: {
        ...common,
        minExecutions: input.args.historicSqlMinExecutions ?? input.args.historicSqlMinCalls ?? 5,
      },
    };
  }

  return {
    ...input.connection,
    historicSql: {
      ...common,
      windowDays: input.args.historicSqlWindowDays ?? 90,
      redactionPatterns: input.args.historicSqlRedactionPatterns ?? [],
    },
  };
}

function historicSqlFiltersForSetup(patterns: string[] | undefined) {
  const serviceAccountPatterns = patterns ?? [];
  return {
    dropTrivialProbes: true,
    ...(serviceAccountPatterns.length > 0
      ? {
          serviceAccounts: {
            patterns: serviceAccountPatterns,
            mode: 'exclude' as const,
          },
        }
      : {}),
  };
}

async function defaultTestConnection(projectDir: string, connectionId: string, io: KtxCliIo): Promise<number> {
  return await runKtxConnection({ command: 'test', projectDir, connectionId }, io);
}

async function defaultScanConnection(projectDir: string, connectionId: string, io: KtxCliIo): Promise<number> {
  return await runKtxScan(
    {
      command: 'run',
      projectDir,
      connectionId,
      mode: 'structural',
      detectRelationships: false,
      dryRun: false,
    },
    io,
  );
}

interface BufferedCommandIo extends KtxCliIo {
  stdoutText(): string;
  stderrText(): string;
}

function createBufferedCommandIo(): BufferedCommandIo {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      isTTY: false,
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

function flushBufferedCommandOutput(io: KtxCliIo, bufferedIo: BufferedCommandIo): void {
  const stdout = bufferedIo.stdoutText();
  const stderr = bufferedIo.stderrText();
  if (stdout.length > 0) {
    io.stdout.write(stdout);
  }
  if (stderr.length > 0) {
    io.stderr.write(stderr);
  }
}

function readOutputValue(output: string, label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escapedLabel}:\\s*(.+?)\\s*$`, 'im').exec(output);
  return match?.[1]?.trim();
}

function summarizeScanChanges(output: string): string {
  const newTables = Number(readOutputValue(output, 'New tables') ?? NaN);
  const changedTables = Number(readOutputValue(output, 'Changed tables') ?? NaN);
  const removedTables = Number(readOutputValue(output, 'Removed tables') ?? NaN);
  const parts: string[] = [];

  if (Number.isFinite(newTables) && newTables > 0) {
    parts.push(`${newTables} new ${newTables === 1 ? 'table' : 'tables'}`);
  }
  if (Number.isFinite(changedTables) && changedTables > 0) {
    parts.push(`${changedTables} changed ${changedTables === 1 ? 'table' : 'tables'}`);
  }
  if (Number.isFinite(removedTables) && removedTables > 0) {
    parts.push(`${removedTables} removed ${removedTables === 1 ? 'table' : 'tables'}`);
  }
  if (parts.length > 0) {
    return parts.join(' · ');
  }

  const semanticComparison = /^\s*Semantic layer comparison found\s+(.+?)\s*$/im.exec(output)?.[1]?.trim();
  if (semanticComparison) {
    return semanticComparison;
  }

  return 'no table changes';
}

function shortenScanReportPath(path: string): string {
  const normalized = path.trim();
  const liveDatabaseMarker = '/live-database/';
  const markerIndex = normalized.indexOf(liveDatabaseMarker);
  if (markerIndex === -1) {
    return normalized;
  }
  const filename = normalized.split('/').at(-1);
  if (!filename) {
    return normalized;
  }
  return `${normalized.slice(0, markerIndex + liveDatabaseMarker.length)}.../${filename}`;
}

function writeSetupSection(io: KtxCliIo, title: string, lines: string[]): void {
  io.stdout.write(`◇  ${title}\n`);
  for (const line of lines) {
    io.stdout.write(`│  ${line}\n`);
  }
  io.stdout.write('│\n');
}

async function writeConnectionConfig(input: {
  projectDir: string;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
}): Promise<void> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const config = {
    ...project.config,
    connections: {
      ...project.config.connections,
      [input.connectionId]: input.connection,
    },
  };
  await writeFile(project.configPath, serializeKtxProjectConfig(stripKtxSetupCompletedSteps(config)), 'utf-8');

  const historicSql =
    typeof input.connection.historicSql === 'object' &&
    input.connection.historicSql !== null &&
    !Array.isArray(input.connection.historicSql)
      ? (input.connection.historicSql as Record<string, unknown>)
      : null;
  if (historicSql?.enabled === true) {
    await ensureHistoricSqlIngestDefaults(input.projectDir);
  }
}

function configuredScopeValues(
  connection: KtxProjectConnectionConfig | undefined,
  spec: ScopeDiscoverySpec,
): string[] {
  if (!connection) return [];
  const arrayVal = connection[spec.configArrayField];
  if (Array.isArray(arrayVal)) {
    return arrayVal
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
  }
  const singleVal = connection[spec.configSingleField];
  return typeof singleVal === 'string' && singleVal.trim().length > 0 ? [singleVal.trim()] : [];
}

async function writeScopeConfig(input: {
  projectDir: string;
  connectionId: string;
  values: string[];
  spec: ScopeDiscoverySpec;
}): Promise<void> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  if (!connection) return;
  const cleaned = Object.fromEntries(
    Object.entries(connection).filter(([key]) => key !== input.spec.configSingleField),
  ) as KtxProjectConnectionConfig;
  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: {
      ...cleaned,
      [input.spec.configArrayField]: unique(input.values),
    },
  });
}

async function maybeConfigureSchemaScope(input: {
  projectDir: string;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  deps: KtxSetupDatabasesDeps;
  io: KtxCliIo;
}): Promise<boolean> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  const driver = normalizeDriver(connection?.driver);
  if (!driver) return true;

  const spec = SCOPE_DISCOVERY_SPECS[driver];
  if (!spec) return true;

  const arrayVal = connection?.[spec.configArrayField];
  if (Array.isArray(arrayVal) && arrayVal.length > 0) {
    return true;
  }

  if (input.args.databaseSchemas.length > 0) {
    await writeScopeConfig({
      projectDir: input.projectDir,
      connectionId: input.connectionId,
      values: input.args.databaseSchemas,
      spec,
    });
    return true;
  }

  writeSetupSection(input.io, `Discovering ${spec.promptLabel.toLowerCase()}`, [
    `Connecting to ${input.connectionId}…`,
  ]);

  let discovered: string[];
  try {
    discovered = unique(
      await (input.deps.listSchemas ?? defaultListSchemas)(input.projectDir, input.connectionId),
    );
  } catch (error) {
    input.io.stderr.write(
      `Could not discover ${spec.promptLabel.toLowerCase()} for ${input.connectionId}; continuing with existing ${spec.noun} scope. ` +
        `Pass --database-schema to set it explicitly. ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return true;
  }
  if (discovered.length === 0) {
    return true;
  }

  let selected: string[];
  if (input.args.inputMode === 'disabled' || discovered.length === 1) {
    const preconfigured = configuredScopeValues(connection, spec).filter((v) => discovered.includes(v));
    selected = preconfigured.length > 0 ? preconfigured : discovered;
  } else {
    const preconfigured = configuredScopeValues(connection, spec).filter((v) => discovered.includes(v));
    const initialValues = preconfigured.length > 0 ? preconfigured : spec.defaultSelection(discovered);
    const choices = await input.prompts.multiselect({
      message: withMultiselectNavigation(
        `${spec.promptLabel} to scan\n` +
          `KTX found multiple ${spec.nounPlural}. Select every ${spec.noun} agents should use.`,
      ),
      options: discovered.map((v) => ({ value: v, label: v })),
      initialValues,
      required: true,
    });
    if (choices.includes('back')) {
      return false;
    }
    selected = choices.length > 0 ? choices : initialValues;
  }

  await writeScopeConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    values: selected,
    spec,
  });
  const capitalNounPlural = spec.nounPlural[0]!.toUpperCase() + spec.nounPlural.slice(1);
  writeSetupSection(input.io, `${capitalNounPlural} saved for ${input.connectionId}`, [
    `✓ ${selected.join(', ')}`,
  ]);
  return true;
}

async function ensureHistoricSqlIngestDefaults(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const adapters = project.config.ingest.adapters.includes('historic-sql')
    ? project.config.ingest.adapters
    : [...project.config.ingest.adapters, 'historic-sql'];
  const maxConcurrency = Math.max(
    project.config.ingest.workUnits.maxConcurrency,
    HISTORIC_SQL_WORK_UNIT_MAX_CONCURRENCY,
  );
  if (
    adapters === project.config.ingest.adapters &&
    maxConcurrency === project.config.ingest.workUnits.maxConcurrency
  ) {
    return;
  }
  await writeFile(
    project.configPath,
    serializeKtxProjectConfig(
      stripKtxSetupCompletedSteps({
        ...project.config,
        ingest: {
          ...project.config.ingest,
          adapters,
          workUnits: {
            ...project.config.ingest.workUnits,
            maxConcurrency,
          },
        },
      }),
    ),
    'utf-8',
  );
}

async function markDatabasesComplete(projectDir: string, connectionIds: string[]): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const config = setKtxSetupDatabaseConnectionIds(project.config, unique(connectionIds));
  await writeFile(project.configPath, serializeKtxProjectConfig(stripKtxSetupCompletedSteps(config)), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'databases');
}

async function maybeRunHistoricSqlSetupProbe(input: {
  projectDir: string;
  connectionId: string;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
}): Promise<void> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  const historicSql = historicSqlConfigRecord(connection);
  if (historicSql?.enabled !== true || historicSql.dialect !== 'postgres') {
    return;
  }

  input.io.stdout.write('Historic SQL probe...\n');
  const probe = input.deps.historicSqlProbe ?? defaultHistoricSqlProbe;
  const result = await probe({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    dialect: 'postgres',
  });
  for (const line of result.lines) {
    input.io.stdout.write(`${line}\n`);
  }
  if (!result.ok) {
    input.io.stdout.write('Setup written; first ingest run will fail until fixed.\n');
  }
}

async function applyHistoricSqlConfigToExistingConnection(input: {
  projectDir: string;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<'back' | void> {
  if (input.args.enableHistoricSql !== true && input.args.disableHistoricSql !== true) {
    return;
  }

  const project = await loadKtxProject({ projectDir: input.projectDir });
  const existing = project.config.connections[input.connectionId];
  const driver = normalizeDriver(existing?.driver);
  if (!existing || !driver) {
    return;
  }

  const withHistoricSql = await maybeApplyHistoricSqlConfig({
    connection: existing,
    driver,
    args: input.args,
    prompts: input.prompts,
  });
  if (withHistoricSql === 'back') return 'back';
  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: withHistoricSql,
  });
}

async function validateAndScanConnection(input: {
  projectDir: string;
  connectionId: string;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<boolean> {
  const testConnection = input.deps.testConnection ?? defaultTestConnection;
  const scanConnection = input.deps.scanConnection ?? defaultScanConnection;
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const configuredDriver = normalizeDriver(project.config.connections[input.connectionId]?.driver);
  const configuredDriverLabel = configuredDriver ? driverLabel(configuredDriver) : undefined;
  const testIo = createBufferedCommandIo();
  const testCode = await testConnection(input.projectDir, input.connectionId, testIo);
  if (testCode !== 0) {
    flushBufferedCommandOutput(input.io, testIo);
    input.io.stderr.write(`Connection test failed for ${input.connectionId}.\n`);
    return false;
  }
  const testOutput = testIo.stdoutText();
  const outputDriver = normalizeDriver(readOutputValue(testOutput, 'Driver'));
  const driverDisplay = outputDriver ? driverLabel(outputDriver) : (configuredDriverLabel ?? 'Unknown driver');
  const tableCount = Number(readOutputValue(testOutput, 'Tables') ?? NaN);
  const testLines = ['✓ Connection test passed'];
  testLines.push(`Driver: ${driverDisplay}${Number.isFinite(tableCount) ? ` · Tables: ${tableCount}` : ''}`);
  writeSetupSection(input.io, `Testing ${input.connectionId}`, testLines);

  if (!(await maybeConfigureSchemaScope(input))) {
    return false;
  }

  await maybeRunHistoricSqlSetupProbe({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    io: input.io,
    deps: input.deps,
  });
  writeSetupSection(input.io, `Scanning ${input.connectionId}`, [
    'Running structural scan…',
  ]);
  const scanIo = createBufferedCommandIo();
  const scanCode = await scanConnection(input.projectDir, input.connectionId, scanIo);
  if (scanCode !== 0) {
    flushBufferedCommandOutput(input.io, scanIo);
    input.io.stderr.write(`Structural scan failed for ${input.connectionId}.\n`);
    input.io.stderr.write(`Debug command: ktx scan --project-dir ${input.projectDir} ${input.connectionId}\n`);
    return false;
  }
  const scanOutput = scanIo.stdoutText();
  const reportPath = readOutputValue(scanOutput, 'Report');
  writeSetupSection(
    input.io,
    `Scan complete for ${input.connectionId}`,
    [
      `Changes: ${summarizeScanChanges(scanOutput)}`,
      ...(reportPath ? [`Report: ${shortenScanReportPath(reportPath)}`] : []),
    ],
  );
  writeSetupSection(input.io, 'Primary source ready', [
    `${input.connectionId} · ${driverDisplay} · structural scan complete`,
  ]);
  return true;
}

async function chooseDrivers(
  args: KtxSetupDatabasesArgs,
  io: KtxCliIo,
  prompts: KtxSetupDatabasesPromptAdapter,
  options?: { hasPrimarySources?: boolean },
): Promise<KtxSetupDatabaseDriver[] | 'back' | 'missing-input'> {
  if (args.databaseDrivers && args.databaseDrivers.length > 0) {
    return [...new Set(args.databaseDrivers)];
  }
  if (args.databaseConnectionIds && args.databaseConnectionIds.length > 0) {
    return [];
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write(
      'KTX cannot work without a primary source. Pass --database or --database-connection-id, or pass --skip-databases to leave setup incomplete.\n',
    );
    return 'missing-input';
  }
  while (true) {
    const choices = await prompts.multiselect({
      message: withMultiselectNavigation('Which primary sources should KTX connect to?'),
      options: [...DRIVER_OPTIONS],
      required: false,
    });
    if (choices.includes('back')) {
      return 'back';
    }
    if (choices.length > 0) {
      return choices as KtxSetupDatabaseDriver[];
    }

    if (options?.hasPrimarySources) {
      return 'back';
    }

    io.stdout.write('KTX cannot work without at least one primary source. Select a source or press Escape to go back.\n');
  }
}

async function chooseConnectionIdForDriver(input: {
  driver: KtxSetupDatabaseDriver;
  connections: Record<string, KtxProjectConnectionConfig>;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<{ kind: 'existing' | 'new'; connectionId: string } | 'back' | 'missing-input'> {
  if (input.args.databaseConnectionId) {
    return { kind: 'new', connectionId: input.args.databaseConnectionId };
  }
  if (input.args.inputMode === 'disabled') {
    if (!input.args.databaseConnectionId) return 'missing-input';
    return { kind: 'new', connectionId: input.args.databaseConnectionId };
  }

  const existingIds = existingConnectionIdsByDriver(input.connections, input.driver);
  const defaultId = defaultConnectionIdForDriver(input.connections, input.driver);
  const label = driverLabel(input.driver);

  if (existingIds.length === 0) {
    const entered = await input.prompts.text({
      message: withTextInputNavigation(connectionNamePrompt(label)),
      placeholder: defaultId,
      initialValue: defaultId,
    });
    if (entered === undefined) return 'back';
    const connectionId = entered.trim() || defaultId;
    return connectionId ? { kind: 'new', connectionId } : 'missing-input';
  }

  while (true) {
    const choice = await input.prompts.select({
      message: `Configure ${label}`,
      options: [
        ...existingIds.map((connectionId) => ({
          value: `existing:${connectionId}`,
          label: `Use existing ${label} connection: ${connectionId}`,
        })),
        { value: 'new', label: `Add new ${label} connection` },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    if (choice.startsWith('existing:')) return { kind: 'existing', connectionId: choice.slice('existing:'.length) };
    const entered = await input.prompts.text({
      message: withTextInputNavigation(connectionNamePrompt(label)),
      placeholder: defaultId,
      initialValue: defaultId,
    });
    if (entered === undefined) continue;
    const connectionId = entered.trim() || defaultId;
    return connectionId ? { kind: 'new', connectionId } : 'missing-input';
  }
}

export async function runKtxSetupDatabasesStep(
  args: KtxSetupDatabasesArgs,
  io: KtxCliIo,
  deps: KtxSetupDatabasesDeps = {},
): Promise<KtxSetupDatabasesResult> {
  if (args.skipDatabases) {
    io.stdout.write('Primary source setup skipped. KTX cannot work until you add a primary source.\n');
    return { status: 'skipped', projectDir: args.projectDir };
  }

  const prompts = deps.prompts ?? createPromptAdapter();

  if (args.databaseConnectionIds && args.databaseConnectionIds.length > 0) {
    const selectedConnectionIds: string[] = [];
    for (const connectionId of unique(args.databaseConnectionIds)) {
      const historicSqlResult = await applyHistoricSqlConfigToExistingConnection({
        projectDir: args.projectDir,
        connectionId,
        args,
        prompts,
      });
      if (historicSqlResult === 'back') return { status: 'back', projectDir: args.projectDir };
      if (!(await validateAndScanConnection({ projectDir: args.projectDir, connectionId, io, deps, args, prompts }))) {
        return { status: 'failed', projectDir: args.projectDir };
      }
      selectedConnectionIds.push(connectionId);
    }
    await markDatabasesComplete(args.projectDir, selectedConnectionIds);
    return { status: 'ready', projectDir: args.projectDir, connectionIds: selectedConnectionIds };
  }

  const canReturnToDriverSelection = args.databaseDrivers === undefined || args.databaseDrivers.length === 0;
  const initialProject = await loadKtxProject({ projectDir: args.projectDir });
  const selectedConnectionIds =
    args.inputMode !== 'disabled' && canReturnToDriverSelection
      ? configuredPrimaryConnectionIds(initialProject.config.connections, initialProject.config.setup?.database_connection_ids)
      : [];
  let showConfiguredPrimaryMenu = selectedConnectionIds.length > 0;

  while (true) {
    if (showConfiguredPrimaryMenu) {
      const action = await prompts.select(configuredPrimarySourcesPrompt(selectedConnectionIds));
      if (action === 'continue') {
        await markDatabasesComplete(args.projectDir, selectedConnectionIds);
        return { status: 'ready', projectDir: args.projectDir, connectionIds: selectedConnectionIds };
      }
      if (action === 'back') {
        return { status: 'back', projectDir: args.projectDir };
      }
    }
    showConfiguredPrimaryMenu = false;

    const drivers = await chooseDrivers(args, io, prompts, { hasPrimarySources: selectedConnectionIds.length > 0 });
    if (drivers === 'back') {
      if (selectedConnectionIds.length > 0 && canReturnToDriverSelection && args.inputMode !== 'disabled') {
        showConfiguredPrimaryMenu = true;
        continue;
      }
      return { status: 'back', projectDir: args.projectDir };
    }
    if (drivers === 'missing-input') return { status: 'missing-input', projectDir: args.projectDir };
    if (drivers.length === 0) {
      await markDatabasesComplete(args.projectDir, []);
      io.stdout.write('KTX cannot work without a primary source.\n');
      return { status: 'skipped', projectDir: args.projectDir };
    }

    let returnToDriverSelection = false;

    for (const driver of drivers) {
      const project = await loadKtxProject({ projectDir: args.projectDir });
      const connectionChoice = await chooseConnectionIdForDriver({
        driver,
        connections: project.config.connections,
        args,
        prompts,
      });
      if (connectionChoice === 'back') {
        if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
        returnToDriverSelection = true;
        break;
      }
      if (connectionChoice === 'missing-input') {
        io.stderr.write('Missing database connection id: pass --database-connection-id.\n');
        return { status: 'missing-input', projectDir: args.projectDir };
      }

      if (connectionChoice.kind === 'new') {
        let connection = await buildConnectionConfig({
          driver,
          connectionId: connectionChoice.connectionId,
          args,
          prompts,
        });
        if (connection === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        while (!connection && args.inputMode !== 'disabled') {
          const label = driverLabel(driver);
          const action = await prompts.select(missingConnectionDetailsPrompt(label, canReturnToDriverSelection));
          if (action === 'back') {
            if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
            returnToDriverSelection = true;
            break;
          }
          connection = await buildConnectionConfig({
            driver,
            connectionId: connectionChoice.connectionId,
            args,
            prompts,
          });
          if (connection === 'back') {
            if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
            returnToDriverSelection = true;
            break;
          }
        }
        if (returnToDriverSelection) {
          break;
        }
        if (connection === 'back') {
          break;
        }
        if (!connection) {
          io.stderr.write(`Missing connection details for ${driverLabel(driver)}.\n`);
          return { status: 'missing-input', projectDir: args.projectDir };
        }
        const withHistoricSql = await maybeApplyHistoricSqlConfig({ connection, driver, args, prompts });
        if (withHistoricSql === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        await writeConnectionConfig({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          connection: withHistoricSql,
        });
      } else {
        const existing = project.config.connections[connectionChoice.connectionId];
        const withHistoricSql = await maybeApplyHistoricSqlConfig({ connection: existing, driver, args, prompts });
        if (withHistoricSql === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        await writeConnectionConfig({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          connection: withHistoricSql,
        });
      }

      let connectionSkipped = false;
      while (
        !(await validateAndScanConnection({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          io,
          deps,
          args,
          prompts,
        }))
      ) {
        if (args.inputMode === 'disabled') return { status: 'failed', projectDir: args.projectDir };
        const action = await prompts.select({
          message: `Primary source setup failed for ${connectionChoice.connectionId}`,
          options: [
            { value: 'retry', label: 'Retry connection test' },
            { value: 're-enter', label: 'Re-enter connection details' },
            { value: 'skip', label: 'Skip this primary source' },
            { value: 'back', label: 'Back' },
          ],
        });
        if (action === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        if (action === 'skip') {
          connectionSkipped = true;
          break;
        }
        if (action === 're-enter') {
          const connection = await buildConnectionConfig({
            driver,
            connectionId: connectionChoice.connectionId,
            args,
            prompts,
          });
          if (connection === 'back') {
            if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
            returnToDriverSelection = true;
            break;
          }
          if (!connection) continue;
          const withHistoricSql = await maybeApplyHistoricSqlConfig({ connection, driver, args, prompts });
          if (withHistoricSql === 'back') {
            if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
            returnToDriverSelection = true;
            break;
          }
          await writeConnectionConfig({
            projectDir: args.projectDir,
            connectionId: connectionChoice.connectionId,
            connection: withHistoricSql,
          });
        }
      }
      if (returnToDriverSelection) break;
      if (connectionSkipped) continue;

      pushUniqueConnectionId(selectedConnectionIds, connectionChoice.connectionId);
    }

    if (returnToDriverSelection) {
      if (selectedConnectionIds.length > 0 && canReturnToDriverSelection && args.inputMode !== 'disabled') {
        showConfiguredPrimaryMenu = true;
      }
      continue;
    }

    if (selectedConnectionIds.length === 0) {
      io.stderr.write('No primary source connections completed setup.\n');
      return { status: 'failed', projectDir: args.projectDir };
    }

    if (canReturnToDriverSelection && args.inputMode !== 'disabled') {
      showConfiguredPrimaryMenu = true;
      continue;
    }

    await markDatabasesComplete(args.projectDir, selectedConnectionIds);
    return { status: 'ready', projectDir: args.projectDir, connectionIds: selectedConnectionIds };
  }
}
