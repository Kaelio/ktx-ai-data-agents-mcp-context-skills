import { type KtxSqlQueryExecutorPort, localConnectionInfoFromConfig } from '../connections/index.js';
import type { KtxEmbeddingPort } from '../core/index.js';
import type { KtxSemanticLayerComputePort } from '../daemon/index.js';
import type { KtxLocalProject } from '../project/index.js';
import { createKtxEntityDetailsService, type KtxScanConnector, type LocalScanMcpOptions } from '../scan/index.js';
import { createKtxDiscoverDataService } from '../search/index.js';
import type { SqlAnalysisDialect, SqlAnalysisPort } from '../sql-analysis/index.js';
import { compileLocalSlQuery, createKtxDictionarySearchService } from '../sl/index.js';
import { readLocalKnowledgePage, searchLocalKnowledgePages } from '../wiki/local-knowledge.js';
import type { KtxMcpContextPorts, KtxMcpProgressCallback, KtxSqlExecutionResponse } from './types.js';

interface CreateLocalProjectMcpContextPortsOptions {
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  sqlAnalysis?: SqlAnalysisPort;
  localScan?: LocalScanMcpOptions;
  embeddingService: KtxEmbeddingPort | null;
}

function dialectForDriver(driver: string | undefined): string {
  const normalized = (driver ?? 'postgres').toUpperCase();
  const map: Record<string, string> = {
    POSTGRESQL: 'postgres',
    POSTGRES: 'postgres',
    BIGQUERY: 'bigquery',
    SNOWFLAKE: 'snowflake',
    MYSQL: 'mysql',
    SQLSERVER: 'tsql',
    MSSQL: 'tsql',
    SQLITE: 'sqlite',
    DUCKDB: 'duckdb',
    CLICKHOUSE: 'clickhouse',
    REDSHIFT: 'redshift',
    DATABRICKS: 'databricks',
  };
  return map[normalized] ?? 'postgres';
}

function sqlAnalysisDialectForDriver(driver: string | undefined): SqlAnalysisDialect {
  return dialectForDriver(driver) as SqlAnalysisDialect;
}

function assertSafePathToken(kind: string, value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes('..') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.includes('//')
  ) {
    throw new Error(`Unsafe ${kind}: ${value}`);
  }
  return value;
}

function assertSafeConnectionId(connectionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
  return assertSafePathToken('connection id', connectionId);
}

function assertSafeSourceName(sourceName: string): string {
  if (!/^[a-z0-9][a-z0-9_]*$/.test(sourceName)) {
    throw new Error(`Unsafe semantic-layer source name: ${sourceName}`);
  }
  return assertSafePathToken('semantic-layer source name', sourceName);
}

async function cleanupConnector(connector: KtxScanConnector | null): Promise<void> {
  if (connector?.cleanup) {
    await connector.cleanup();
  }
}

function slPath(connectionId: string, sourceName: string): string {
  return `semantic-layer/${assertSafeConnectionId(connectionId)}/${assertSafeSourceName(sourceName)}.yaml`;
}

async function executeValidatedReadOnlySql(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions,
  input: { connectionId: string; sql: string; maxRows: number },
  onProgress?: KtxMcpProgressCallback,
): Promise<KtxSqlExecutionResponse> {
  await onProgress?.({ progress: 0, message: 'Validating SQL' });
  const connectionId = assertSafeConnectionId(input.connectionId);
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  if (!options.sqlAnalysis) {
    throw new Error('sql_execution requires parser-backed SQL validation.');
  }
  const validation = await options.sqlAnalysis.validateReadOnly(input.sql, sqlAnalysisDialectForDriver(connection.driver));
  if (!validation.ok) {
    throw new Error(validation.error ?? 'SQL is not read-only.');
  }
  const createConnector = options.localScan?.createConnector;
  if (!createConnector) {
    throw new Error('sql_execution requires a local scan connector factory.');
  }

  let connector: KtxScanConnector | null = null;
  try {
    connector = await createConnector(connectionId);
    if (!connector.capabilities.readOnlySql || !connector.executeReadOnly) {
      throw new Error(`Connection "${connectionId}" does not support read-only SQL execution.`);
    }
    await onProgress?.({ progress: 0.3, message: 'Executing' });
    const result = await connector.executeReadOnly(
      {
        connectionId,
        sql: input.sql,
        maxRows: input.maxRows,
      },
      { runId: 'mcp-sql-execution' },
    );
    const response = {
      headers: result.headers,
      ...(result.headerTypes ? { headerTypes: result.headerTypes } : {}),
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
    await onProgress?.({ progress: 1, message: `Fetched ${response.rowCount} rows` });
    return response;
  } finally {
    await cleanupConnector(connector);
  }
}

export function createLocalProjectMcpContextPorts(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions,
): KtxMcpContextPorts {
  const embeddingService = options.embeddingService;
  const ports: KtxMcpContextPorts = {
    connections: {
      async list() {
        return Object.entries(project.config.connections)
          .map(([id, config]) => localConnectionInfoFromConfig(id, config))
          .filter(
            (connection): connection is { id: string; name: string; connectionType: string } => connection !== null,
          )
          .sort((a, b) => a.id.localeCompare(b.id));
      },
    },
    knowledge: {
      async search(input) {
        const results = await searchLocalKnowledgePages(project, {
          query: input.query,
          userId: input.userId,
          limit: input.limit,
          embeddingService,
        });
        return {
          results: results.slice(0, input.limit).map((result) => ({
            key: result.key,
            path: result.path,
            scope: result.scope,
            summary: result.summary,
            score: result.score,
            matchReasons: result.matchReasons,
            lanes: result.lanes,
          })),
          totalFound: results.length,
        };
      },
      async read(input) {
        const page = await readLocalKnowledgePage(project, {
          key: input.key,
          userId: input.userId,
        });
        return page
          ? {
              key: page.key,
              scope: page.scope,
              summary: page.summary,
              content: page.content,
              tags: page.tags,
              refs: page.refs,
              slRefs: page.slRefs,
            }
          : null;
      },
    },
    semanticLayer: {
      async readSource(input) {
        const path = slPath(input.connectionId, input.sourceName);
        try {
          const result = await project.fileStore.readFile(path);
          return { sourceName: input.sourceName, yaml: result.content };
        } catch {
          return null;
        }
      },
      async query(input, executionOptions) {
        if (!options.semanticLayerCompute) {
          throw new Error('sl_query requires a semantic-layer query adapter.');
        }
        return compileLocalSlQuery(project, {
          connectionId: input.connectionId,
          query: input.query,
          compute: options.semanticLayerCompute,
          execute: Boolean(options.queryExecutor),
          maxRows: input.query.limit,
          queryExecutor: options.queryExecutor,
          onProgress: executionOptions?.onProgress,
        });
      },
    },
    entityDetails: {
      async read(input) {
        return createKtxEntityDetailsService(project).read(input);
      },
    },
    dictionarySearch: {
      async search(input) {
        return createKtxDictionarySearchService(project).search(input);
      },
    },
    discover: {
      async search(input) {
        return createKtxDiscoverDataService(project, { userId: 'local', embeddingService }).search(input);
      },
    },
  };

  if (options.sqlAnalysis && options.localScan?.createConnector) {
    ports.sqlExecution = {
      async execute(input, executionOptions) {
        return executeValidatedReadOnlySql(project, options, input, executionOptions?.onProgress);
      },
    };
  }

  return ports;
}
