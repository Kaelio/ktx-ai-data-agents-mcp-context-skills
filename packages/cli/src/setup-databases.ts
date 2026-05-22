import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { HistoricSqlDialect } from './context/ingest/adapters/historic-sql/types.js';
import { type KtxProjectConnectionConfig, serializeKtxProjectConfig } from './context/project/config.js';
import { loadKtxProject } from './context/project/project.js';
import { markKtxSetupStateStepComplete, setKtxSetupDatabaseConnectionIds } from './context/project/setup-config.js';
import type { KtxTableListEntry } from './context/scan/types.js';
import type { KtxCliIo } from './cli-runtime.js';
import { runKtxConnection } from './connection.js';
import {
  pickDatabaseScope as defaultPickDatabaseScope,
  type DatabaseScopePickResult,
  type PickDatabaseScopeArgs,
} from './database-tree-picker.js';
import { withMultiselectNavigation, withTextInputNavigation } from './prompt-navigation.js';
import { runKtxScan } from './scan.js';
import { applySetupDatabaseContextDepth } from './setup-database-context-depth.js';
import { writeProjectLocalSecretReference } from './setup-secrets.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

const HISTORIC_SQL_WORK_UNIT_MAX_CONCURRENCY = 6;
const execFileAsync = promisify(execFileCallback);

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
  enableQueryHistory?: boolean;
  disableQueryHistory?: boolean;
  queryHistoryWindowDays?: number;
  queryHistoryMinExecutions?: number;
  queryHistoryServiceAccountPatterns?: string[];
  queryHistoryRedactionPatterns?: string[];
  skipDatabases: boolean;
}

export type KtxSetupDatabasesResult =
  | { status: 'ready'; projectDir: string; connectionIds: string[] }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

/** @internal */
export interface KtxSetupDatabasesPromptAdapter {
  multiselect(options: {
    message: string;
    options: KtxSetupPromptOption[];
    required?: boolean;
    initialValues?: string[];
  }): Promise<string[]>;
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
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
  rebuildNativeSqlite?: (io: KtxCliIo) => Promise<number>;
  listSchemas?: (projectDir: string, connectionId: string) => Promise<string[]>;
  listTables?: (projectDir: string, connectionId: string, schemas?: string[]) => Promise<KtxTableListEntry[]>;
  pickDatabaseScope?: (args: PickDatabaseScopeArgs, io: KtxCliIo) => Promise<DatabaseScopePickResult>;
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
type ConnectionSetupStatus = 'ready' | 'back' | 'failed';

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
  const backDestination = canReturnToDriverSelection ? 'database selection' : 'the previous setup step';
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
  return createKtxSetupPromptAdapter({
    selectCancelValue: 'back',
    multiselectCancelValue: 'back',
    confirmEmptyOptionalMultiselect: true,
  });
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

function assertSafeDatabaseConnectionId(connectionId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
}

function stringConfigField(connection: KtxProjectConnectionConfig | undefined, field: string): string | undefined {
  const value = connection?.[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberConfigField(connection: KtxProjectConnectionConfig | undefined, field: string): number | undefined {
  const value = connection?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function historicSqlConfigRecord(connection: KtxProjectConnectionConfig | undefined): Record<string, unknown> | null {
  const historicSql = connection?.historicSql;
  return historicSql && typeof historicSql === 'object' && !Array.isArray(historicSql)
    ? (historicSql as Record<string, unknown>)
    : null;
}

function contextRecord(connection: KtxProjectConnectionConfig | undefined): Record<string, unknown> {
  const context = connection?.context;
  return context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
}

function queryHistoryConfigRecord(connection: KtxProjectConnectionConfig | undefined): Record<string, unknown> | null {
  const queryHistory = contextRecord(connection).queryHistory;
  return queryHistory && typeof queryHistory === 'object' && !Array.isArray(queryHistory)
    ? (queryHistory as Record<string, unknown>)
    : null;
}

function stripLegacyHistoricSql(connection: KtxProjectConnectionConfig): KtxProjectConnectionConfig {
  const { historicSql: _historicSql, ...rest } = connection as KtxProjectConnectionConfig & {
    historicSql?: unknown;
  };
  return rest;
}

function withQueryHistoryConfig(
  connection: KtxProjectConnectionConfig,
  queryHistory: Record<string, unknown>,
): KtxProjectConnectionConfig {
  return {
    ...stripLegacyHistoricSql(connection),
    context: {
      ...contextRecord(connection),
      queryHistory,
    },
  };
}

function migrateLegacyHistoricSqlConnection(connection: KtxProjectConnectionConfig): KtxProjectConnectionConfig {
  const existingQueryHistory = queryHistoryConfigRecord(connection);
  const legacy = historicSqlConfigRecord(connection);
  if (existingQueryHistory || !legacy) {
    return existingQueryHistory ? stripLegacyHistoricSql(connection) : connection;
  }
  const { dialect: _dialect, ...queryHistory } = legacy;
  return withQueryHistoryConfig(connection, queryHistory);
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
  return [`  FAIL Query history probe failed: ${error instanceof Error ? error.message : String(error)}`];
}

async function defaultHistoricSqlProbe(input: KtxSetupHistoricSqlProbeInput): Promise<KtxSetupHistoricSqlProbeResult> {
  if (input.dialect !== 'postgres') {
    return { ok: true, lines: [] };
  }

  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  const [{ PostgresPgssReader }, { KtxPostgresHistoricSqlQueryClient }, { isKtxPostgresConnectionConfig }] =
    await Promise.all([
      import('./context/ingest/adapters/historic-sql/postgres-pgss-reader.js'),
      import('./connectors/postgres/historic-sql-query-client.js'),
      import('./connectors/postgres/connector.js'),
    ]);

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
    const { KtxPostgresScanConnector, isKtxPostgresConnectionConfig } = await import('./connectors/postgres/connector.js');;
    if (!isKtxPostgresConnectionConfig(connection)) return [];
    const connector = new KtxPostgresScanConnector({ connectionId, connection });
    try {
      return await connector.listSchemas();
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'sqlserver') {
    const { KtxSqlServerScanConnector, isKtxSqlServerConnectionConfig } = await import('./connectors/sqlserver/connector.js');;
    if (!isKtxSqlServerConnectionConfig(connection)) return [];
    const connector = new KtxSqlServerScanConnector({ connectionId, connection });
    try {
      return await connector.listSchemas();
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'bigquery') {
    const { KtxBigQueryScanConnector, isKtxBigQueryConnectionConfig } = await import('./connectors/bigquery/connector.js');;
    if (!isKtxBigQueryConnectionConfig(connection)) return [];
    const connector = new KtxBigQueryScanConnector({ connectionId, connection });
    try {
      return await connector.listDatasets();
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'snowflake') {
    const { KtxSnowflakeScanConnector, isKtxSnowflakeConnectionConfig } = await import('./connectors/snowflake/connector.js');;
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

function configuredSchemas(connection: KtxProjectConnectionConfig | undefined, driver: KtxSetupDatabaseDriver): string[] | undefined {
  if (!connection) return undefined;
  const spec = SCOPE_DISCOVERY_SPECS[driver];
  if (!spec) return undefined;
  const values = configuredScopeValues(connection, spec);
  return values.length > 0 ? values : undefined;
}

async function defaultListTables(
  projectDir: string,
  connectionId: string,
  schemasOverride?: string[],
): Promise<KtxTableListEntry[]> {
  const project = await loadKtxProject({ projectDir });
  const connection = project.config.connections[connectionId];
  const driver = normalizeDriver(connection?.driver);
  const schemas = schemasOverride ?? (driver ? configuredSchemas(connection, driver) : undefined);

  if (driver === 'postgres') {
    const { KtxPostgresScanConnector, isKtxPostgresConnectionConfig } = await import('./connectors/postgres/connector.js');;
    if (!isKtxPostgresConnectionConfig(connection)) return [];
    const connector = new KtxPostgresScanConnector({ connectionId, connection });
    try {
      return await connector.listTables(schemas);
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'mysql') {
    const { KtxMysqlScanConnector, isKtxMysqlConnectionConfig } = await import('./connectors/mysql/connector.js');;
    if (!isKtxMysqlConnectionConfig(connection)) return [];
    const connector = new KtxMysqlScanConnector({ connectionId, connection });
    try {
      return await connector.listTables(schemas);
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'sqlserver') {
    const { KtxSqlServerScanConnector, isKtxSqlServerConnectionConfig } = await import('./connectors/sqlserver/connector.js');;
    if (!isKtxSqlServerConnectionConfig(connection)) return [];
    const connector = new KtxSqlServerScanConnector({ connectionId, connection });
    try {
      return await connector.listTables(schemas);
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'bigquery') {
    const { KtxBigQueryScanConnector, isKtxBigQueryConnectionConfig } = await import('./connectors/bigquery/connector.js');;
    if (!isKtxBigQueryConnectionConfig(connection)) return [];
    const connector = new KtxBigQueryScanConnector({ connectionId, connection });
    try {
      return await connector.listTables(schemas);
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'snowflake') {
    const { KtxSnowflakeScanConnector, isKtxSnowflakeConnectionConfig } = await import('./connectors/snowflake/connector.js');;
    if (!isKtxSnowflakeConnectionConfig(connection)) return [];
    const connector = new KtxSnowflakeScanConnector({ connectionId, connection });
    try {
      return await connector.listTables(schemas);
    } finally {
      await connector.cleanup();
    }
  }

  if (driver === 'clickhouse') {
    const { KtxClickHouseScanConnector, isKtxClickHouseConnectionConfig } = await import('./connectors/clickhouse/connector.js');;
    if (!isKtxClickHouseConnectionConfig(connection)) return [];
    const connector = new KtxClickHouseScanConnector({ connectionId, connection });
    try {
      return await connector.listTables(schemas);
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

function configuredPrimaryDrivers(
  connections: Record<string, KtxProjectConnectionConfig>,
  connectionIds: string[],
): KtxSetupDatabaseDriver[] {
  const configured = new Set(
    connectionIds
      .map((connectionId) => normalizeDriver(connections[connectionId]?.driver))
      .filter((driver): driver is KtxSetupDatabaseDriver => driver !== null),
  );
  return DRIVER_OPTIONS.map((option) => option.value).filter((driver) => configured.has(driver));
}

function configuredPrimarySourcesPrompt(connectionIds: string[]): {
  message: string;
  options: Array<{ value: string; label: string }>;
} {
  return {
    message: `Databases configured: ${connectionIds.join(', ')}\nWhat would you like to do?`,
    options: [
      { value: 'continue', label: 'Continue to context sources' },
      { value: 'edit', label: 'Edit an existing database' },
      { value: 'add', label: 'Add another database' },
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
  existingConnection?: KtxProjectConnectionConfig;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const label = driverLabel(input.driver);
  const defaults = DRIVER_CONNECTION_DEFAULTS[input.driver];

  const host = await promptText(
    input.prompts,
    `${label} host`,
    stringConfigField(input.existingConnection, 'host') ?? 'localhost',
  );
  if (host === undefined) return 'back';
  if (!host) return null;

  const portStr = await promptText(
    input.prompts,
    `${label} port`,
    String(numberConfigField(input.existingConnection, 'port') ?? defaults.port),
  );
  if (portStr === undefined) return 'back';
  const port = Number(portStr || defaults.port);

  const database = await promptText(
    input.prompts,
    `${label} database name`,
    stringConfigField(input.existingConnection, 'database'),
  );
  if (database === undefined) return 'back';
  if (!database) return null;

  const username = await promptText(
    input.prompts,
    `${label} username`,
    stringConfigField(input.existingConnection, 'username'),
  );
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
    if (!credentialResult) passwordRef = stringConfigField(input.existingConnection, 'password');
  }

  return {
    driver: input.driver,
    host,
    port,
    database,
    username,
    ...(passwordRef ? { password: passwordRef } : {}),
    ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
  };
}

async function buildPastedUrlConnectionConfig(input: {
  driver: UrlDriverType;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  existingConnection?: KtxProjectConnectionConfig;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const label = driverLabel(input.driver);
  const rawUrl = await promptText(
    input.prompts,
    `${label} connection URL`,
    stringConfigField(input.existingConnection, 'url'),
  );
  if (rawUrl === undefined) return 'back';
  if (!rawUrl) return null;

  const url = normalizeInputReference(rawUrl);

  if (url.startsWith('env:') || url.startsWith('file:')) {
    return {
      driver: input.driver,
      url,
      ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
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
    };
  }

  return {
    driver: input.driver,
    url,
    ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
  };
}

async function buildUrlConnectionConfig(input: {
  driver: UrlDriverType;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  existingConnection?: KtxProjectConnectionConfig;
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
      };
    }
    return {
      driver: input.driver,
      url,
      ...(input.args.databaseSchemas.length > 0 ? { schemas: input.args.databaseSchemas } : {}),
    };
  }

  const label = driverLabel(input.driver);
  while (true) {
    const choice = await input.prompts.select({
      message: `How do you want to connect to ${label}?`,
      options: [
        { value: 'url', label: 'Paste a connection URL' },
        { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
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
  existingConnection?: KtxProjectConnectionConfig;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const { driver, args, prompts } = input;
  if (driver === 'sqlite') {
    if (args.inputMode === 'disabled' && !args.databaseUrl) return null;
    const path =
      args.databaseUrl ??
      (await promptText(
        prompts,
        'SQLite database file\nEnter a relative or absolute path, for example ./warehouse.sqlite.',
        stringConfigField(input.existingConnection, 'path'),
      ));
    if (path === undefined) return 'back';
    return path ? { driver: 'sqlite', path } : null;
  }
  if (driver === 'postgres' || driver === 'mysql' || driver === 'clickhouse' || driver === 'sqlserver') {
    return await buildUrlConnectionConfig({
      driver,
      connectionId: input.connectionId,
      args,
      prompts,
      existingConnection: input.existingConnection,
    });
  }
  if (driver === 'bigquery') {
    const datasetId = await promptText(
      prompts,
      'BigQuery dataset\nFor example analytics.',
      stringConfigField(input.existingConnection, 'dataset_id'),
    );
    if (datasetId === undefined) return 'back';
    const credentialsPath = await promptText(
      prompts,
      'Path to service account JSON file',
      stringConfigField(input.existingConnection, 'credentials_json'),
    );
    if (credentialsPath === undefined) return 'back';
    const location = await promptText(
      prompts,
      'BigQuery location\nPress Enter for US, or enter a location like EU.',
      stringConfigField(input.existingConnection, 'location') ?? 'US',
    );
    if (location === undefined) return 'back';
    if (!datasetId || !credentialsPath) return null;
    return {
      driver: 'bigquery',
      dataset_id: datasetId,
      credentials_json: normalizeFileReference(credentialsPath),
      ...(location ? { location } : {}),
    };
  }
  if (driver === 'snowflake') {
    const account = await promptText(
      prompts,
      'Snowflake account identifier',
      stringConfigField(input.existingConnection, 'account'),
    );
    if (account === undefined) return 'back';
    const warehouse = await promptText(
      prompts,
      'Snowflake warehouse\nFor example ANALYTICS_WH.',
      stringConfigField(input.existingConnection, 'warehouse'),
    );
    if (warehouse === undefined) return 'back';
    const database = await promptText(
      prompts,
      'Snowflake database name',
      stringConfigField(input.existingConnection, 'database'),
    );
    if (database === undefined) return 'back';
    const username = await promptText(
      prompts,
      'Snowflake username',
      stringConfigField(input.existingConnection, 'username'),
    );
    if (username === undefined) return 'back';
    const passwordRef = await promptCredential({
      prompts,
      message: 'Snowflake password',
      projectDir: args.projectDir,
      connectionId: input.connectionId,
      secretName: 'password', // pragma: allowlist secret
    });
    if (passwordRef === 'back') return 'back'; // pragma: allowlist secret
    const role = await promptText(
      prompts,
      'Snowflake role (optional)\nPress Enter to skip.',
      stringConfigField(input.existingConnection, 'role'),
    );
    if (role === undefined) return 'back';
    const resolvedPasswordRef = passwordRef ?? stringConfigField(input.existingConnection, 'password');
    if (!account || !warehouse || !database || !username || !resolvedPasswordRef) return null;
    return {
      driver: 'snowflake',
      authMethod: 'password',
      account,
      warehouse,
      database,
      username,
      password: resolvedPasswordRef,
      ...(role ? { role } : {}),
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
    if (input.args.enableQueryHistory === true) {
      throw new Error(
        `Query history setup is only supported for Snowflake, BigQuery, and Postgres, not ${driverLabel(input.driver)}.`,
      );
    }
    return input.connection;
  }

  let enabled = input.args.enableQueryHistory === true;
  if (input.args.disableQueryHistory === true) {
    enabled = false;
  } else if (input.args.inputMode !== 'disabled' && input.args.enableQueryHistory !== true) {
    const choice = await input.prompts.select({
      message: `Enable query-history ingest for this ${driverLabel(input.driver)} connection?`,
      options: [
        { value: 'yes', label: 'Enable query history (recommended)' },
        { value: 'no', label: 'Do not enable query history' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    if (choice === 'yes') {
      enabled = true;
    } else if (choice === 'no') {
      enabled = false;
    } else {
      return input.connection;
    }
  }

  const existingRecord = queryHistoryConfigRecord(input.connection) ?? historicSqlConfigRecord(input.connection) ?? {};
  const { dialect: _dialect, ...existing } = existingRecord;

  if (!enabled) {
    return withQueryHistoryConfig(input.connection, { ...existing, enabled: false });
  }

  const common: Record<string, unknown> = {
    ...existing,
    enabled: true,
    filters: historicSqlFiltersForSetup(input.args.queryHistoryServiceAccountPatterns),
  };

  if (dialect === 'postgres') {
    return withQueryHistoryConfig(input.connection, {
      ...common,
      minExecutions: input.args.queryHistoryMinExecutions ?? 5,
    });
  }

  return withQueryHistoryConfig(input.connection, {
    ...common,
    windowDays: input.args.queryHistoryWindowDays ?? 90,
    redactionPatterns: input.args.queryHistoryRedactionPatterns ?? [],
  });
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

function writePrefixedLines(write: (chunk: string) => void, output: string): void {
  for (const line of output.split(/\r?\n/)) {
    if (line.length > 0) {
      write(`│  ${line}\n`);
    }
  }
}

function envWithCurrentNodeFirst(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}`,
  };
}

function errorTextProperty(error: unknown, property: 'stderr' | 'stdout'): string {
  if (typeof error !== 'object' || error === null || !(property in error)) {
    return '';
  }
  const value = (error as Record<typeof property, unknown>)[property];
  return typeof value === 'string' ? value : '';
}

function commandFailureOutput(error: unknown): string {
  const stderr = errorTextProperty(error, 'stderr');
  const stdout = errorTextProperty(error, 'stdout');
  const message = error instanceof Error ? error.message : String(error);
  return [stderr.trim(), stdout.trim(), message.trim()].filter((line) => line.length > 0).join('\n');
}

type PackageJsonScriptStatus = 'has-script' | 'exists' | 'missing';

async function packageJsonScriptStatus(
  packageJsonPath: string,
  scriptName: string,
): Promise<PackageJsonScriptStatus> {
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) {
      return 'exists';
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    return typeof scripts === 'object' && scripts !== null && scriptName in scripts ? 'has-script' : 'exists';
  } catch {
    return 'missing';
  }
}

async function nativeSqliteRebuildCommand(): Promise<{ cwd: string; args: string[] }> {
  let dir = dirname(fileURLToPath(import.meta.url));
  let packageRoot: string | undefined;
  while (true) {
    const status = await packageJsonScriptStatus(join(dir, 'package.json'), 'native:rebuild');
    if (status === 'has-script') {
      return { cwd: dir, args: ['run', 'native:rebuild'] };
    }
    if (status === 'exists') {
      packageRoot ??= dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return { cwd: packageRoot ?? process.cwd(), args: ['rebuild', 'better-sqlite3'] };
    }
    dir = parent;
  }
}

async function defaultRebuildNativeSqlite(io: KtxCliIo): Promise<number> {
  const command = await nativeSqliteRebuildCommand();
  try {
    await execFileAsync('pnpm', command.args, {
      cwd: command.cwd,
      env: envWithCurrentNodeFirst(),
      maxBuffer: 1024 * 1024 * 16,
    });
    return 0;
  } catch (error) {
    writePrefixedLines((chunk) => io.stderr.write(chunk), commandFailureOutput(error));
    return typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : 1;
  }
}

function flushPrefixedBufferedCommandOutput(io: KtxCliIo, bufferedIo: BufferedCommandIo): void {
  writePrefixedLines((chunk) => io.stdout.write(chunk), bufferedIo.stdoutText());
  writePrefixedLines((chunk) => io.stderr.write(chunk), bufferedIo.stderrText());
}

function nativeSqliteAbiMismatchDetail(output: string): string | null {
  const mentionsBetterSqlite = /\bbetter-sqlite3\b|better_sqlite3/i.test(output);
  const mentionsAbiMismatch = /compiled against a different Node\.js version|NODE_MODULE_VERSION/i.test(output);
  if (!mentionsBetterSqlite || !mentionsAbiMismatch) {
    return null;
  }

  const versionMatch = output.match(
    /compiled against[\s\S]*?NODE_MODULE_VERSION\s+(\d+)[\s\S]*?requires[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/i,
  );
  if (!versionMatch) {
    return 'better-sqlite3 native module could not load for the current Node.js runtime.';
  }

  return `better-sqlite3 was compiled for NODE_MODULE_VERSION ${versionMatch[1]}, but this Node.js requires ${versionMatch[2]}.`;
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
  const migratedConnections = Object.fromEntries(
    Object.entries(project.config.connections).map(([connectionId, connection]) => [
      connectionId,
      migrateLegacyHistoricSqlConnection(connection),
    ]),
  );
  const nextConnection = migrateLegacyHistoricSqlConnection(input.connection);
  const config = {
    ...project.config,
    connections: {
      ...migratedConnections,
      [input.connectionId]: nextConnection,
    },
  };
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');

  const queryHistory = queryHistoryConfigRecord(nextConnection);
  if (queryHistory?.enabled === true) {
    await ensureHistoricSqlIngestDefaults(input.projectDir);
  }
}

async function createConnectionConfigRollback(projectDir: string, connectionId: string): Promise<() => Promise<void>> {
  const project = await loadKtxProject({ projectDir });
  const previousConnection = project.config.connections[connectionId];
  const hadPreviousConnection = previousConnection !== undefined;
  return async () => {
    const latest = await loadKtxProject({ projectDir });
    const connections = { ...latest.config.connections };
    if (hadPreviousConnection) {
      connections[connectionId] = previousConnection;
    } else {
      delete connections[connectionId];
    }
    await writeFile(
      latest.configPath,
      serializeKtxProjectConfig({
        ...latest.config,
        connections,
      }),
      'utf-8',
    );
  };
}

function withExistingPrimaryEditPromptDefaults(input: {
  previous: KtxProjectConnectionConfig;
  next: KtxProjectConnectionConfig;
  driver: KtxSetupDatabaseDriver;
}): KtxProjectConnectionConfig {
  const merged: KtxProjectConnectionConfig = { ...input.next };
  const spec = SCOPE_DISCOVERY_SPECS[input.driver];
  if (spec) {
    const nextArray = input.next[spec.configArrayField];
    const previousArray = input.previous[spec.configArrayField];
    if (
      !(Array.isArray(nextArray) && nextArray.length > 0) &&
      Array.isArray(previousArray) &&
      previousArray.length > 0
    ) {
      delete merged[spec.configSingleField];
      merged[spec.configArrayField] = previousArray;
    } else if (!Object.hasOwn(input.next, spec.configArrayField) && !Object.hasOwn(input.next, spec.configSingleField)) {
      const previousSingle = input.previous[spec.configSingleField];
      if (typeof previousSingle === 'string' && previousSingle.trim().length > 0) {
        merged[spec.configSingleField] = previousSingle;
      }
    }
  }
  if (!Object.hasOwn(input.next, 'enabled_tables') && Array.isArray(input.previous.enabled_tables)) {
    merged.enabled_tables = input.previous.enabled_tables;
  }
  return merged;
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

async function promptCommaSeparatedScope(input: {
  prompts: KtxSetupDatabasesPromptAdapter;
  connectionId: string;
  spec: ScopeDiscoverySpec;
}): Promise<string[] | undefined> {
  const example =
    input.spec.nounPlural === 'datasets' ? 'sales, marketing' : 'SALES, MARKETING';
  const value = await promptText(
    input.prompts,
    `Enter ${input.spec.nounPlural} for ${input.connectionId} as a comma-separated list (e.g. ${example}).`,
  );
  if (value === undefined) return undefined;
  return unique(value.split(',').map((part) => part.trim()));
}

async function maybeConfigureDatabaseScope(input: {
  projectDir: string;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  deps: KtxSetupDatabasesDeps;
  io: KtxCliIo;
  forcePrompt?: boolean;
}): Promise<ConnectionSetupStatus> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  const driver = normalizeDriver(connection?.driver);
  if (!driver || driver === 'sqlite') return 'ready';

  const spec = SCOPE_DISCOVERY_SPECS[driver];
  const existingTables = connection?.enabled_tables;
  const hasExistingTables = Array.isArray(existingTables) && existingTables.length > 0;
  const existingScope = spec ? configuredScopeValues(connection, spec) : [];
  const hasExistingScope = !spec || existingScope.length > 0;

  if (hasExistingTables && hasExistingScope && input.forcePrompt !== true) {
    return 'ready';
  }

  const cliSchemas = input.args.databaseSchemas;

  if (input.args.inputMode === 'disabled') {
    if (spec) {
      let scopeToWrite: string[] = cliSchemas;
      if (scopeToWrite.length === 0) {
        try {
          scopeToWrite = unique(
            await (input.deps.listSchemas ?? defaultListSchemas)(input.projectDir, input.connectionId),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          input.io.stderr.write(
            `Could not discover ${spec.promptLabel.toLowerCase()} for ${input.connectionId}; ${detail}\n`,
          );
          return 'ready';
        }
      }
      if (scopeToWrite.length > 0) {
        await writeScopeConfig({
          projectDir: input.projectDir,
          connectionId: input.connectionId,
          values: scopeToWrite,
          spec,
        });
        const capitalNounPlural = spec.nounPlural[0]!.toUpperCase() + spec.nounPlural.slice(1);
        writeSetupSection(input.io, `${capitalNounPlural} saved for ${input.connectionId}`, [
          `✓ ${scopeToWrite.join(', ')}`,
        ]);
      }
    }
    return 'ready';
  }

  if (spec && cliSchemas.length > 0) {
    await writeScopeConfig({
      projectDir: input.projectDir,
      connectionId: input.connectionId,
      values: cliSchemas,
      spec,
    });
  }

  writeSetupSection(input.io, 'Discovering tables', [
    `Connecting to ${input.connectionId}…`,
  ]);

  let effectiveCliSchemas = cliSchemas;
  let schemasFilter: string[];
  if (effectiveCliSchemas.length > 0) {
    schemasFilter = effectiveCliSchemas;
  } else if (!spec) {
    schemasFilter = [];
  } else {
    try {
      schemasFilter = unique(
        await (input.deps.listSchemas ?? defaultListSchemas)(input.projectDir, input.connectionId),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      input.io.stderr.write(
        `Could not discover ${spec.promptLabel.toLowerCase()} for ${input.connectionId}; ${detail}\n`,
      );
      const prompts = input.deps.prompts ?? createPromptAdapter();
      const typed = await promptCommaSeparatedScope({ prompts, connectionId: input.connectionId, spec });
      if (typed === undefined) return 'back';
      effectiveCliSchemas = typed;
      schemasFilter = typed;
      if (typed.length > 0) {
        await writeScopeConfig({
          projectDir: input.projectDir,
          connectionId: input.connectionId,
          values: typed,
          spec,
        });
      }
    }
  }

  let discovered: KtxTableListEntry[];
  try {
    discovered = await (input.deps.listTables ?? defaultListTables)(
      input.projectDir,
      input.connectionId,
      schemasFilter.length > 0 ? schemasFilter : undefined,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.io.stderr.write(
      input.forcePrompt === true
        ? `Could not discover tables for ${input.connectionId}; edit was not saved. ${detail}\n`
        : `Could not discover tables for ${input.connectionId}; continuing without table filter. ${detail}\n`,
    );
    return input.forcePrompt === true ? 'failed' : 'ready';
  }

  if (discovered.length === 0) {
    if (input.forcePrompt === true) {
      input.io.stderr.write(`No tables discovered for ${input.connectionId}; edit was not saved.\n`);
    }
    return input.forcePrompt === true ? 'failed' : 'ready';
  }

  const allQualified = discovered.map((t) => `${t.schema}.${t.name}`);
  const schemasInDiscovery = unique(discovered.map((t) => t.schema));

  const defaultSchemas = (() => {
    if (effectiveCliSchemas.length > 0) return effectiveCliSchemas;
    if (!spec) return schemasInDiscovery;
    return spec.defaultSelection(schemasInDiscovery);
  })();

  const existingEnabled =
    hasExistingTables && input.forcePrompt === true
      ? (existingTables ?? []).filter(
          (table): table is string => typeof table === 'string' && allQualified.includes(table),
        )
      : [];

  let activeSchemas: string[];
  let enabledTables: string[];

  if (discovered.length === 1) {
    enabledTables = allQualified;
    activeSchemas = spec ? schemasInDiscovery : [];
  } else {
    const pickResult = await (input.deps.pickDatabaseScope ?? defaultPickDatabaseScope)(
      {
        connectionId: input.connectionId,
        schemaNoun: spec?.noun ?? 'schema',
        schemaNounPlural: spec?.nounPlural ?? 'schemas',
        discovered,
        existing: { enabledTables: existingEnabled },
        defaultSchemas,
        supportsSchemaScope: spec !== undefined,
      },
      input.io,
    );
    if (pickResult.kind === 'back') {
      return 'back';
    }
    enabledTables = pickResult.enabledTables;
    activeSchemas = pickResult.activeSchemas;
  }

  if (spec) {
    await writeScopeConfig({
      projectDir: input.projectDir,
      connectionId: input.connectionId,
      values: activeSchemas,
      spec,
    });
  }
  const refreshedProject = await loadKtxProject({ projectDir: input.projectDir });
  const currentConnection = refreshedProject.config.connections[input.connectionId];
  if (!currentConnection) return 'ready';
  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: { ...currentConnection, enabled_tables: enabledTables },
  });

  if (spec && activeSchemas.length > 0) {
    const capitalNounPlural = spec.nounPlural[0]!.toUpperCase() + spec.nounPlural.slice(1);
    writeSetupSection(input.io, `${capitalNounPlural} saved for ${input.connectionId}`, [
      `✓ ${activeSchemas.join(', ')}`,
    ]);
  }
  writeSetupSection(input.io, `Tables enabled for ${input.connectionId}`, [
    `✓ ${enabledTables.length}/${discovered.length} tables enabled`,
  ]);
  return 'ready';
}

async function ensureHistoricSqlIngestDefaults(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const maxConcurrency = Math.max(
    project.config.ingest.workUnits.maxConcurrency,
    HISTORIC_SQL_WORK_UNIT_MAX_CONCURRENCY,
  );
  if (maxConcurrency === project.config.ingest.workUnits.maxConcurrency) {
    return;
  }
  await writeFile(
    project.configPath,
    serializeKtxProjectConfig({
      ...project.config,
      ingest: {
        ...project.config.ingest,
        workUnits: {
          ...project.config.ingest.workUnits,
          maxConcurrency,
        },
      },
    }),
    'utf-8',
  );
}

async function markDatabasesComplete(projectDir: string, connectionIds: string[]): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const config = setKtxSetupDatabaseConnectionIds(
    {
      ...project.config,
      connections: Object.fromEntries(
        Object.entries(project.config.connections).map(([connectionId, connection]) => [
          connectionId,
          migrateLegacyHistoricSqlConnection(connection),
        ]),
      ),
    },
    unique(connectionIds),
  );
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
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
  const queryHistory = queryHistoryConfigRecord(connection) ?? historicSqlConfigRecord(connection);
  const driver = normalizeDriver(connection?.driver);
  if (queryHistory?.enabled !== true || driver !== 'postgres') {
    return;
  }

  input.io.stdout.write('│  Query history probe...\n');
  const probe = input.deps.historicSqlProbe ?? defaultHistoricSqlProbe;
  const result = await probe({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    dialect: 'postgres',
  });
  for (const line of result.lines) {
    input.io.stdout.write(`│${line}\n`);
  }
  if (!result.ok) {
    input.io.stdout.write('│  Setup written; first ingest run will fail until fixed.\n');
  }
}

async function applyHistoricSqlConfigToExistingConnection(input: {
  projectDir: string;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<'back' | void> {
  if (
    input.args.inputMode === 'disabled' &&
    input.args.enableQueryHistory !== true &&
    input.args.disableQueryHistory !== true
  ) {
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
  const withContextDepth = await maybeApplyContextDepthConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: withHistoricSql,
    args: input.args,
    prompts: input.prompts,
  });
  if (withContextDepth === 'back') return 'back';
  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: withContextDepth,
  });
}

async function maybeApplyContextDepthConfig(input: {
  projectDir: string;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<KtxProjectConnectionConfig | 'back'> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  return await applySetupDatabaseContextDepth({
    project: {
      ...project,
      config: {
        ...project.config,
        connections: {
          ...project.config.connections,
          [input.connectionId]: input.connection,
        },
      },
    },
    connection: input.connection,
    args: {
      inputMode: input.args.inputMode === 'disabled' || input.args.databaseUrl ? 'disabled' : input.args.inputMode,
    },
    prompts: input.prompts,
  });
}

async function validateAndScanConnection(input: {
  projectDir: string;
  connectionId: string;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  forceScopeAndTables?: boolean;
}): Promise<ConnectionSetupStatus> {
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
    return 'failed';
  }
  const testOutput = testIo.stdoutText();
  const outputDriver = normalizeDriver(readOutputValue(testOutput, 'Driver'));
  const driverDisplay = outputDriver ? driverLabel(outputDriver) : (configuredDriverLabel ?? 'Unknown driver');
  const testLines = ['✓ Connection test passed', `Driver: ${driverDisplay}`];
  writeSetupSection(input.io, `Testing ${input.connectionId}`, testLines);

  const scopeStatus = await maybeConfigureDatabaseScope({ ...input, forcePrompt: input.forceScopeAndTables });
  if (scopeStatus !== 'ready') {
    return scopeStatus;
  }

  await maybeRunHistoricSqlSetupProbe({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    io: input.io,
    deps: input.deps,
  });
  writeSetupSection(input.io, `Building schema context for ${input.connectionId}`, [
    'Running fast database ingest…',
  ]);
  let scanIo = createBufferedCommandIo();
  let scanCode = await scanConnection(input.projectDir, input.connectionId, scanIo);
  if (scanCode !== 0) {
    const nativeSqliteDetail = nativeSqliteAbiMismatchDetail(`${scanIo.stderrText()}\n${scanIo.stdoutText()}`);
    if (nativeSqliteDetail) {
      writePrefixedLines(
        (chunk) => input.io.stderr.write(chunk),
          [
            `Fast database ingest failed for ${input.connectionId}.`,
            'Native SQLite is built for a different Node.js ABI.',
            `Detail: ${nativeSqliteDetail}`,
            'Rebuilding Native SQLite with pnpm run native:rebuild…',
        ].join('\n'),
      );
      const rebuildNativeSqlite = input.deps.rebuildNativeSqlite ?? defaultRebuildNativeSqlite;
      const rebuildCode = await rebuildNativeSqlite(input.io);
      if (rebuildCode === 0) {
        writePrefixedLines(
          (chunk) => input.io.stderr.write(chunk),
          'Native SQLite rebuild complete. Retrying fast database ingest…',
        );
        const retryScanIo = createBufferedCommandIo();
        scanCode = await scanConnection(input.projectDir, input.connectionId, retryScanIo);
        scanIo = retryScanIo;
      }
      if (scanCode !== 0) {
        writePrefixedLines(
          (chunk) => input.io.stderr.write(chunk),
          [
            rebuildCode === 0
              ? `Fast database ingest still failed for ${input.connectionId} after rebuilding Native SQLite.`
              : `Native SQLite rebuild failed for ${input.connectionId}.`,
            'Fix: pnpm run native:rebuild',
            `Retry: ktx ingest ${input.connectionId} --project-dir ${input.projectDir} --fast`,
          ].join('\n'),
        );
      }
    } else {
      flushPrefixedBufferedCommandOutput(input.io, scanIo);
      writePrefixedLines(
        (chunk) => input.io.stderr.write(chunk),
        [
          `Fast database ingest failed for ${input.connectionId}.`,
          `Debug command: ktx ingest ${input.connectionId} --project-dir ${input.projectDir} --fast --debug`,
        ].join('\n'),
      );
    }
    if (scanCode !== 0) {
      return 'failed';
    }
  }
  const scanOutput = scanIo.stdoutText();
  writeSetupSection(
    input.io,
    `Schema context complete for ${input.connectionId}`,
    [`Changes: ${summarizeScanChanges(scanOutput)}`],
  );
  writeSetupSection(input.io, 'Database ready', [
    `${input.connectionId} · ${driverDisplay} · schema context complete`,
  ]);
  return 'ready';
}

async function chooseDrivers(
  args: KtxSetupDatabasesArgs,
  io: KtxCliIo,
  prompts: KtxSetupDatabasesPromptAdapter,
  options?: { hasPrimarySources?: boolean; initialDrivers?: KtxSetupDatabaseDriver[] },
): Promise<KtxSetupDatabaseDriver[] | 'back' | 'missing-input'> {
  if (args.databaseDrivers && args.databaseDrivers.length > 0) {
    return [...new Set(args.databaseDrivers)];
  }
  if (args.databaseConnectionIds && args.databaseConnectionIds.length > 0) {
    return [];
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write(
      'KTX cannot work without a database. Pass --database or --database-connection-id, or pass --skip-databases to leave setup incomplete.\n',
    );
    return 'missing-input';
  }
  const initialValues = unique(options?.initialDrivers ?? []);
  const choices = await prompts.multiselect({
    message: withMultiselectNavigation('Which databases should KTX connect to?'),
    options: [...DRIVER_OPTIONS],
    ...(initialValues.length > 0 ? { initialValues } : {}),
    required: true,
  });
  if (choices.includes('back')) {
    return 'back';
  }
  return choices as KtxSetupDatabaseDriver[];
}

async function chooseConnectionIdForDriver(input: {
  driver: KtxSetupDatabaseDriver;
  connections: Record<string, KtxProjectConnectionConfig>;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<{ kind: 'existing' | 'new' | 'edit'; connectionId: string } | 'back' | 'missing-input'> {
  if (input.args.databaseConnectionId) {
    assertSafeDatabaseConnectionId(input.args.databaseConnectionId);
    return { kind: 'new', connectionId: input.args.databaseConnectionId };
  }
  if (input.args.inputMode === 'disabled') {
    if (!input.args.databaseConnectionId) return 'missing-input';
    assertSafeDatabaseConnectionId(input.args.databaseConnectionId);
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
    assertSafeDatabaseConnectionId(connectionId);
    return connectionId ? { kind: 'new', connectionId } : 'missing-input';
  }

  while (true) {
    const choice = await input.prompts.select({
      message: `Configure ${label}`,
      options: [
        ...existingIds.map((connectionId) => ({
          value: `existing:${connectionId}`,
          label: `Keep existing ${label} connection: ${connectionId}`,
        })),
        ...existingIds.map((connectionId) => ({
          value: `edit:${connectionId}`,
          label: `Edit ${label} connection: ${connectionId}`,
        })),
        { value: 'new', label: `Add another ${label} connection` },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    if (choice.startsWith('existing:')) return { kind: 'existing', connectionId: choice.slice('existing:'.length) };
    if (choice.startsWith('edit:')) return { kind: 'edit', connectionId: choice.slice('edit:'.length) };
    const entered = await input.prompts.text({
      message: withTextInputNavigation(connectionNamePrompt(label)),
      placeholder: defaultId,
      initialValue: defaultId,
    });
    if (entered === undefined) continue;
    const connectionId = entered.trim() || defaultId;
    assertSafeDatabaseConnectionId(connectionId);
    return connectionId ? { kind: 'new', connectionId } : 'missing-input';
  }
}

async function choosePrimarySourceToEdit(input: {
  projectDir: string;
  connectionIds: string[];
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<string | 'back'> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const options = input.connectionIds
    .map((connectionId) => {
      const driver = normalizeDriver(project.config.connections[connectionId]?.driver);
      if (!driver) return null;
      return { value: connectionId, label: `${connectionId} (${driverLabel(driver)})` };
    })
    .filter((option): option is { value: string; label: string } => option !== null);
  if (options.length === 0) return 'back';
  const choice = await input.prompts.select({
    message: 'Database to edit',
    options: [...options, { value: 'back', label: 'Back' }],
  });
  return choice === 'back' ? 'back' : choice;
}

async function runPrimarySourceFullEdit(input: {
  projectDir: string;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
}): Promise<'ready' | 'back' | 'failed'> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const existing = project.config.connections[input.connectionId];
  const driver = normalizeDriver(existing?.driver);
  if (!existing || !driver) {
    input.io.stderr.write(`Connection "${input.connectionId}" is not a configured database.\n`);
    return 'failed';
  }

  const rollback = await createConnectionConfigRollback(input.projectDir, input.connectionId);
  const replacement = await buildConnectionConfig({
    driver,
    connectionId: input.connectionId,
    args: input.args,
    prompts: input.prompts,
    existingConnection: existing,
  });
  if (replacement === 'back') {
    await rollback();
    return 'back';
  }
  if (!replacement) {
    await rollback();
    return 'failed';
  }

  const withHistoricSql = await maybeApplyHistoricSqlConfig({
    connection: replacement,
    driver,
    args: input.args,
    prompts: input.prompts,
  });
  if (withHistoricSql === 'back') {
    await rollback();
    return 'back';
  }

  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: withExistingPrimaryEditPromptDefaults({
      previous: existing,
      next: {
        ...withHistoricSql,
        ...(!Object.hasOwn(withHistoricSql, 'historicSql') && existing.historicSql !== undefined
          ? { historicSql: existing.historicSql }
          : {}),
      },
      driver,
    }),
  });

  const validated = await validateAndScanConnection({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    io: input.io,
    deps: input.deps,
    args: input.args,
    prompts: input.prompts,
    forceScopeAndTables: true,
  });
  if (validated !== 'ready') {
    await rollback();
    return validated;
  }
  return 'ready';
}

export async function runKtxSetupDatabasesStep(
  args: KtxSetupDatabasesArgs,
  io: KtxCliIo,
  deps: KtxSetupDatabasesDeps = {},
): Promise<KtxSetupDatabasesResult> {
  if (args.skipDatabases) {
    io.stdout.write('│  Database setup skipped. KTX cannot work until you add a database.\n');
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
      const setupStatus = await validateAndScanConnection({
        projectDir: args.projectDir,
        connectionId,
        io,
        deps,
        args,
        prompts,
      });
      if (setupStatus === 'back') {
        return { status: 'back', projectDir: args.projectDir };
      }
      if (setupStatus === 'failed') {
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
      if (action === 'continue' || action === 'back') {
        await markDatabasesComplete(args.projectDir, selectedConnectionIds);
        return { status: 'ready', projectDir: args.projectDir, connectionIds: selectedConnectionIds };
      }
      if (action === 'edit') {
        const connectionId = await choosePrimarySourceToEdit({
          projectDir: args.projectDir,
          connectionIds: selectedConnectionIds,
          prompts,
        });
        if (connectionId === 'back') {
          showConfiguredPrimaryMenu = true;
          continue;
        }
        const editResult = await runPrimarySourceFullEdit({
          projectDir: args.projectDir,
          connectionId,
          args,
          prompts,
          io,
          deps,
        });
        if (editResult === 'back') {
          showConfiguredPrimaryMenu = true;
          continue;
        }
        if (editResult === 'failed') {
          return { status: 'failed', projectDir: args.projectDir };
        }
        pushUniqueConnectionId(selectedConnectionIds, connectionId);
        showConfiguredPrimaryMenu = true;
        continue;
      }
    }
    showConfiguredPrimaryMenu = false;

    const driverProject = await loadKtxProject({ projectDir: args.projectDir });
    const drivers = await chooseDrivers(args, io, prompts, {
      hasPrimarySources: selectedConnectionIds.length > 0,
      initialDrivers: configuredPrimaryDrivers(driverProject.config.connections, selectedConnectionIds),
    });
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
      io.stdout.write('│  KTX cannot work without a database.\n');
      return { status: 'skipped', projectDir: args.projectDir };
    }

    let returnToDriverSelection = false;

    for (const driver of drivers) {
      const project = await loadKtxProject({ projectDir: args.projectDir });
      let connectionChoice: Awaited<ReturnType<typeof chooseConnectionIdForDriver>>;
      try {
        connectionChoice = await chooseConnectionIdForDriver({
          driver,
          connections: project.config.connections,
          args,
          prompts,
        });
      } catch (error) {
        io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return { status: 'failed', projectDir: args.projectDir };
      }
      if (connectionChoice === 'back') {
        if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
        returnToDriverSelection = true;
        break;
      }
      if (connectionChoice === 'missing-input') {
        io.stderr.write('Missing database connection id: pass --database-connection-id.\n');
        return { status: 'missing-input', projectDir: args.projectDir };
      }

      let connectionAlreadyValidated = false;
      if (connectionChoice.kind === 'edit') {
        const editResult = await runPrimarySourceFullEdit({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          args,
          prompts,
          io,
          deps,
        });
        if (editResult === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        if (editResult === 'failed') {
          return { status: 'failed', projectDir: args.projectDir };
        }
        connectionAlreadyValidated = true;
      } else if (connectionChoice.kind === 'new') {
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
        const withContextDepth = await maybeApplyContextDepthConfig({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          connection: withHistoricSql,
          args,
          prompts,
        });
        if (withContextDepth === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        await writeConnectionConfig({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          connection: withContextDepth,
        });
      } else {
        const existing = project.config.connections[connectionChoice.connectionId];
        const withHistoricSql = await maybeApplyHistoricSqlConfig({ connection: existing, driver, args, prompts });
        if (withHistoricSql === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        const withContextDepth = await maybeApplyContextDepthConfig({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          connection: withHistoricSql,
          args,
          prompts,
        });
        if (withContextDepth === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        await writeConnectionConfig({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          connection: withContextDepth,
        });
      }

      let connectionSkipped = false;
      let setupStatus: ConnectionSetupStatus = connectionAlreadyValidated
        ? 'ready'
        : await validateAndScanConnection({
            projectDir: args.projectDir,
            connectionId: connectionChoice.connectionId,
            io,
            deps,
            args,
            prompts,
          });
      while (!connectionAlreadyValidated && setupStatus !== 'ready') {
        if (setupStatus === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        if (args.inputMode === 'disabled') return { status: 'failed', projectDir: args.projectDir };
        const action = await prompts.select({
          message: `Database setup failed for ${connectionChoice.connectionId}`,
          options: [
            { value: 'retry', label: 'Retry connection test' },
            { value: 're-enter', label: 'Re-enter connection details' },
            { value: 'skip', label: 'Skip this database' },
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
        if (action === 'retry') {
          setupStatus = await validateAndScanConnection({
            projectDir: args.projectDir,
            connectionId: connectionChoice.connectionId,
            io,
            deps,
            args,
            prompts,
          });
        } else if (action === 're-enter') {
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
          const withContextDepth = await maybeApplyContextDepthConfig({
            projectDir: args.projectDir,
            connectionId: connectionChoice.connectionId,
            connection: withHistoricSql,
            args,
            prompts,
          });
          if (withContextDepth === 'back') {
            if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
            returnToDriverSelection = true;
            break;
          }
          await writeConnectionConfig({
            projectDir: args.projectDir,
            connectionId: connectionChoice.connectionId,
            connection: withContextDepth,
          });
          setupStatus = await validateAndScanConnection({
            projectDir: args.projectDir,
            connectionId: connectionChoice.connectionId,
            io,
            deps,
            args,
            prompts,
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
      io.stderr.write('No database connections completed setup.\n');
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
