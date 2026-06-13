import type { KtxSqlQueryExecutorPort } from '../../context/connections/query-executor.js';
import { KtxQueryError, isNativeProgrammingFault } from '../../errors.js';
import { executeProjectReadOnlySql } from '../../context/connections/project-sql-executor.js';
import { FEDERATED_CONNECTION_ID } from '../../context/connections/federation.js';
import { localConnectionInfoFromConfig } from '../../context/connections/local-warehouse-descriptor.js';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import type { KtxSemanticLayerComputePort } from '../../context/daemon/semantic-layer-compute.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { createKtxEntityDetailsService } from '../../context/scan/entity-details.js';
import type { KtxScanConnector } from '../../context/scan/types.js';
import type { LocalScanMcpOptions } from '../../context/scan/local-scan.js';
import { createKtxDiscoverDataService } from '../../context/search/discover.js';
import { sqlAnalysisDialectForDriver } from '../../context/sql-analysis/dialect.js';
import type { SqlAnalysisPort } from '../../context/sql-analysis/ports.js';
import { compileLocalSlQuery } from '../../context/sl/local-query.js';
import { createKtxDictionarySearchService } from '../../context/sl/dictionary-search.js';
import { readLocalSlSource } from '../../context/sl/local-sl.js';
import { assertSafeConnectionId } from '../../context/sl/source-files.js';
import { readLocalKnowledgePage, searchLocalKnowledgePages } from '../wiki/local-knowledge.js';
import type { KtxMcpContextPorts, KtxMcpProgressCallback, KtxSqlExecutionResponse } from './types.js';

interface CreateLocalProjectMcpContextPortsOptions {
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  sqlAnalysis?: SqlAnalysisPort;
  localScan?: LocalScanMcpOptions;
  embeddingService: KtxEmbeddingPort | null;
}

async function cleanupConnector(connector: KtxScanConnector | null): Promise<void> {
  if (connector?.cleanup) {
    await connector.cleanup();
  }
}

async function executeValidatedReadOnlySql(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions,
  input: { connectionId: string; sql: string; maxRows: number },
  onProgress?: KtxMcpProgressCallback,
): Promise<KtxSqlExecutionResponse> {
  await onProgress?.({ progress: 0, message: 'Validating SQL' });
  if (!options.sqlAnalysis) {
    throw new Error('sql_execution requires parser-backed SQL validation.');
  }
  const createConnector = options.localScan?.createConnector;
  if (!createConnector) {
    throw new Error('sql_execution requires a local scan connector factory.');
  }

  if (input.connectionId === FEDERATED_CONNECTION_ID) {
    const validation = await options.sqlAnalysis.validateReadOnly(input.sql, sqlAnalysisDialectForDriver('duckdb'));
    if (!validation.ok) {
      throw new Error(validation.error ?? 'SQL is not read-only.');
    }
    await onProgress?.({ progress: 0.3, message: 'Executing' });
    const result = await executeProjectReadOnlySql({
      project,
      input: {
        connectionId: input.connectionId,
        projectDir: project.projectDir,
        connection: undefined,
        sql: input.sql,
        maxRows: input.maxRows,
      },
      createConnector,
      runId: 'mcp-sql-execution',
    });
    const rowCount = result.rowCount ?? result.rows.length;
    await onProgress?.({ progress: 1, message: `Fetched ${rowCount} rows` });
    return { headers: result.headers, rows: result.rows, rowCount };
  }

  const connectionId = assertSafeConnectionId(input.connectionId);
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const validation = await options.sqlAnalysis.validateReadOnly(input.sql, sqlAnalysisDialectForDriver(connection.driver));
  if (!validation.ok) {
    throw new Error(validation.error ?? 'SQL is not read-only.');
  }

  let connector: KtxScanConnector | null = null;
  try {
    connector = await createConnector(connectionId);
    if (!connector.capabilities.readOnlySql || !connector.executeReadOnly) {
      throw new Error(`Connection "${connectionId}" does not support read-only SQL execution.`);
    }
    await onProgress?.({ progress: 0.3, message: 'Executing' });
    const result = await connector
      .executeReadOnly(
        {
          connectionId,
          sql: input.sql,
          maxRows: input.maxRows,
        },
        { runId: 'mcp-sql-execution' },
      )
      .catch((error: unknown) => {
        // A warehouse/driver rejection (e.g. the agent's SQL failed to compile)
        // is a surfaced operational outcome, not a ktx fault: mark it expected
        // while preserving the warehouse's own diagnostics. A native JS error
        // (TypeError, etc.) signals a bug in connector code — let it propagate
        // unchanged so Error Tracking still sees it.
        if (isNativeProgrammingFault(error)) {
          throw error;
        }
        throw new KtxQueryError(error instanceof Error ? error.message : String(error), { cause: error });
      });
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
        const source = await readLocalSlSource(project, {
          connectionId: input.connectionId,
          sourceName: input.sourceName,
        });
        return source ? { sourceName: source.name, yaml: source.yaml } : null;
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
