import { join } from 'node:path';
import { localConnectionToWarehouseDescriptor, notionConnectionToPullConfig, parseNotionConnectionConfig } from '../connections/index.js';
import { resolveKtxConfigReference } from '../core/config-reference.js';
import type { KtxLocalProject } from '../project/index.js';
import type { SqlAnalysisPort } from '../sql-analysis/index.js';
import { DbtSourceAdapter } from './adapters/dbt/dbt.adapter.js';
import { FakeSourceAdapter } from './adapters/fake/fake.adapter.js';
import { HistoricSqlSourceAdapter } from './adapters/historic-sql/historic-sql.adapter.js';
import { PostgresPgssReader } from './adapters/historic-sql/postgres-pgss-reader.js';
import {
  HISTORIC_SQL_SOURCE_KEY,
  historicSqlUnifiedPullConfigSchema,
  type HistoricSqlReader,
  type KtxPostgresQueryClient,
} from './adapters/historic-sql/types.js';
import {
  createDaemonLiveDatabaseIntrospection,
  type DaemonLiveDatabaseIntrospectionOptions,
} from './adapters/live-database/daemon-introspection.js';
import { LiveDatabaseSourceAdapter } from './adapters/live-database/live-database.adapter.js';
import { createDaemonLookerTableIdentifierParser } from './adapters/looker/daemon-table-identifier-parser.js';
import { DefaultLookerConnectionClientFactory } from './adapters/looker/factory.js';
import { createLocalLookerCredentialResolver } from './adapters/looker/local-looker.adapter.js';
import { LocalLookerRuntimeStore } from './adapters/looker/local-runtime-store.js';
import { LookerSourceAdapter } from './adapters/looker/looker.adapter.js';
import {
  buildLookerPullConfigFromInputs,
  type LookerMappingClient,
  type LookerTableIdentifierParser,
} from './adapters/looker/mapping.js';
import type { LookerRuntimeClient } from './adapters/looker/fetch.js';
import { LookmlSourceAdapter } from './adapters/lookml/lookml.adapter.js';
import { pullConfigFromIntegrationConfig } from './adapters/lookml/pull-config.js';
import { createLocalMetabaseSourceAdapter } from './adapters/metabase/local-metabase.adapter.js';
import { MetricflowSourceAdapter } from './adapters/metricflow/metricflow.adapter.js';
import { pullConfigFromMetricflowIntegration } from './adapters/metricflow/pull-config.js';
import { NotionSourceAdapter } from './adapters/notion/notion.adapter.js';
import { seedLocalMappingStateFromKtxYaml } from './local-mapping-reconcile.js';
import type { SourceAdapter } from './types.js';

export interface DefaultLocalIngestAdaptersOptions {
  databaseIntrospectionUrl?: string;
  databaseIntrospection?: Omit<DaemonLiveDatabaseIntrospectionOptions, 'connections' | 'baseUrl'>;
  historicSql?: {
    sqlAnalysis: SqlAnalysisPort;
    reader?: HistoricSqlReader;
    queryClient?: unknown;
    postgresQueryClient?: KtxPostgresQueryClient;
    postgresBaselineRootDir?: string;
    now?: () => Date;
  };
  looker?: {
    daemonBaseUrl?: string;
    client?: Pick<LookerMappingClient, 'listLookmlModels' | 'getExplore'>;
    runtimeClient?: LookerRuntimeClient;
    parser?: LookerTableIdentifierParser;
    env?: NodeJS.ProcessEnv;
  };
}

export function createDefaultLocalIngestAdapters(
  project: KtxLocalProject,
  options: DefaultLocalIngestAdaptersOptions = {},
): SourceAdapter[] {
  const lookerConnectionFactory = new DefaultLookerConnectionClientFactory(
    createLocalLookerCredentialResolver(project, options.looker?.env),
  );

  const adapters: SourceAdapter[] = [
    new FakeSourceAdapter(),
    new LiveDatabaseSourceAdapter({
      introspection: createDaemonLiveDatabaseIntrospection({
        connections: project.config.connections,
        ...options.databaseIntrospection,
        ...(options.databaseIntrospectionUrl ? { baseUrl: options.databaseIntrospectionUrl } : {}),
      }),
    }),
    new LookmlSourceAdapter({ homeDir: join(project.projectDir, '.ktx/cache') }),
    new DbtSourceAdapter({ homeDir: join(project.projectDir, '.ktx/cache') }),
    createLocalMetabaseSourceAdapter(project),
    new LookerSourceAdapter({
      clientFactory: {
        async createClient(config, ctx) {
          if (options.looker?.runtimeClient) {
            return options.looker.runtimeClient;
          }
          return lookerConnectionFactory.createClient(config.lookerConnectionId ?? ctx.connectionId);
        },
      },
    }),
    new MetricflowSourceAdapter({ homeDir: join(project.projectDir, '.ktx/cache') }),
    new NotionSourceAdapter(),
  ];

  if (options.historicSql) {
    const queryClient = options.historicSql.queryClient ?? options.historicSql.postgresQueryClient;
    if (!queryClient) {
      throw new Error('Historic SQL local adapter requires queryClient or postgresQueryClient');
    }
    adapters.push(
      new HistoricSqlSourceAdapter({
        sqlAnalysis: options.historicSql.sqlAnalysis,
        reader: options.historicSql.reader ?? new PostgresPgssReader(),
        queryClient,
        legacyPostgresBaselineRootDir: options.historicSql.postgresBaselineRootDir,
        now: options.historicSql.now,
      }),
    );
  }

  return adapters;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function localLookmlPullConfigFromConnection(connection: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv) {
  const mappings = isRecord(connection?.mappings) ? connection.mappings : {};
  const authTokenRef = stringField(connection?.auth_token_ref) ?? stringField(connection?.authTokenRef);
  const literalAuthToken = stringField(connection?.authToken) ?? stringField(connection?.auth_token);

  return pullConfigFromIntegrationConfig({
    repoUrl: stringField(connection?.repoUrl) ?? stringField(connection?.repo_url) ?? null,
    branch: stringField(connection?.branch),
    path: stringField(connection?.path),
    authToken: literalAuthToken ?? resolveKtxConfigReference(authTokenRef ?? undefined, env) ?? null,
    expectedLookerConnectionName: stringField(mappings.expectedLookerConnectionName),
  });
}

function localDbtPullConfigFromConnection(connection: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv) {
  const sourceDir = stringField(connection?.source_dir) ?? stringField(connection?.sourceDir);
  const repoUrl = stringField(connection?.repo_url) ?? stringField(connection?.repoUrl);
  if (sourceDir) {
    return {
      sourceDir,
      ...(stringField(connection?.profiles_path) ? { profilesPath: stringField(connection?.profiles_path) } : {}),
      ...(stringField(connection?.profilesPath) ? { profilesPath: stringField(connection?.profilesPath) } : {}),
      ...(stringField(connection?.target) ? { target: stringField(connection?.target) } : {}),
      ...(stringField(connection?.project_name) ? { projectName: stringField(connection?.project_name) } : {}),
      ...(stringField(connection?.projectName) ? { projectName: stringField(connection?.projectName) } : {}),
    };
  }
  if (!repoUrl) {
    return undefined;
  }
  const authToken =
    stringField(connection?.authToken) ??
    resolveKtxConfigReference(
      stringField(connection?.auth_token_ref) ?? stringField(connection?.authTokenRef) ?? undefined,
      env,
    );
  return {
    repoUrl,
    ...(stringField(connection?.branch) ? { branch: stringField(connection?.branch) } : {}),
    ...(stringField(connection?.path) ? { path: stringField(connection?.path) } : {}),
    ...(authToken ? { authToken } : {}),
  };
}

export async function localPullConfigForAdapter(
  project: KtxLocalProject,
  adapter: SourceAdapter,
  connectionId: string,
  options: DefaultLocalIngestAdaptersOptions = {},
): Promise<unknown> {
  if (adapter.source === 'metabase') {
    throw new Error(
      'Metabase scheduled pulls fan out by mapping. Call runLocalMetabaseIngest() or use `ktx ingest run --adapter metabase --connection-id <metabase-source-id>` from the CLI.',
    );
  }
  const connection = project.config.connections[connectionId];
  if (adapter.source === HISTORIC_SQL_SOURCE_KEY) {
    const historicSql = isRecord(connection?.historicSql) ? connection.historicSql : null;
    if (historicSql?.enabled !== true) {
      throw new Error(`Connection "${connectionId}" does not have historicSql.enabled: true`);
    }
    return historicSqlUnifiedPullConfigSchema.parse({
      ...historicSql,
    });
  }
  if (adapter.source === 'looker') {
    await seedLocalMappingStateFromKtxYaml(project, connectionId);
    const store = new LocalLookerRuntimeStore({ dbPath: join(project.projectDir, '.ktx', 'db.sqlite') });
    const targetConnections = new Map(
      Object.entries(project.config.connections).flatMap(([id, config]) => {
        const descriptor = localConnectionToWarehouseDescriptor(id, config);
        return descriptor ? [[id, descriptor]] : [];
      }),
    );
    const parser =
      options.looker?.parser ??
      createDaemonLookerTableIdentifierParser({
        baseUrl: options.looker?.daemonBaseUrl ?? process.env.KTX_DAEMON_URL ?? 'http://127.0.0.1:8765',
      });
    let cleanupClient: Pick<LookerRuntimeClient, 'cleanup'> | null = null;
    let client: Pick<LookerMappingClient, 'listLookmlModels' | 'getExplore'>;
    if (options.looker?.client) {
      client = options.looker.client;
    } else {
      const runtimeClient = await new DefaultLookerConnectionClientFactory(
        createLocalLookerCredentialResolver(project, options.looker?.env),
      ).createClient(connectionId);
      cleanupClient = runtimeClient;
      client = runtimeClient;
    }
    try {
      return await buildLookerPullConfigFromInputs({
        lookerConnectionId: connectionId,
        cursors: await store.readCursors(connectionId),
        refreshedMappings: await store.readMappings(connectionId),
        targetConnections,
        client,
        parser,
      });
    } finally {
      await cleanupClient?.cleanup?.();
    }
  }
  if (adapter.source === 'lookml') {
    return localLookmlPullConfigFromConnection(connection, options.looker?.env ?? process.env);
  }
  if (adapter.source === 'dbt') {
    return localDbtPullConfigFromConnection(connection, options.looker?.env ?? process.env);
  }
  if (adapter.source === 'notion') {
    return notionConnectionToPullConfig(parseNotionConnectionConfig(connection));
  }
  if (adapter.source === 'metricflow') {
    const metricflow = connection.metricflow;
    const metricflowConfig =
      typeof metricflow === 'object' && metricflow !== null && !Array.isArray(metricflow)
        ? (metricflow as Record<string, unknown>)
        : null;
    const authToken =
      typeof metricflowConfig?.authToken === 'string'
        ? metricflowConfig.authToken
        : resolveKtxConfigReference(
            typeof metricflowConfig?.auth_token_ref === 'string' ? metricflowConfig.auth_token_ref : undefined,
            options.looker?.env ?? process.env,
          );
    return pullConfigFromMetricflowIntegration({
      repoUrl: typeof metricflowConfig?.repoUrl === 'string' ? metricflowConfig.repoUrl : null,
      branch: typeof metricflowConfig?.branch === 'string' ? metricflowConfig.branch : null,
      path: typeof metricflowConfig?.path === 'string' ? metricflowConfig.path : null,
      authToken: authToken ?? null,
    });
  }
  return undefined;
}
