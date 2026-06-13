import { executeFederatedQuery } from './connectors/duckdb/federated-executor.js';
import type { KtxSqlQueryExecutionInput, KtxSqlQueryExecutorPort } from './context/connections/query-executor.js';
import { deriveFederatedConnection, FEDERATED_CONNECTION_ID } from './context/connections/federation.js';
import type { KtxLocalProject } from './context/project/project.js';
import type { KtxScanConnector, KtxScanContext } from './context/scan/types.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';

type CreateConnector = typeof createKtxCliScanConnector;

export interface KtxCliIngestQueryExecutorDeps {
  createConnector?: CreateConnector;
  executeFederated?: typeof executeFederatedQuery;
}

async function cleanupConnector(connector: KtxScanConnector | null): Promise<void> {
  await connector?.cleanup?.();
}

export function createKtxCliIngestQueryExecutor(
  project: KtxLocalProject,
  deps: KtxCliIngestQueryExecutorDeps = {},
): KtxSqlQueryExecutorPort {
  const createConnector = deps.createConnector ?? createKtxCliScanConnector;
  return {
    async execute(input: KtxSqlQueryExecutionInput) {
      if (input.connectionId === FEDERATED_CONNECTION_ID) {
        const descriptor = deriveFederatedConnection(project.config.connections, project.projectDir);
        if (!descriptor) {
          throw new Error('Federated execution requested but fewer than 2 attach-compatible connections exist.');
        }
        const runFederated = deps.executeFederated ?? executeFederatedQuery;
        return runFederated(descriptor.members, input);
      }

      let connector: KtxScanConnector | null = null;
      try {
        connector = await createConnector(project, input.connectionId);
        if (!connector.capabilities.readOnlySql || !connector.executeReadOnly) {
          throw new Error(
            `Connection "${input.connectionId}" driver "${connector.driver}" does not support read-only SQL execution.`,
          );
        }

        const ctx: KtxScanContext = { runId: 'ingest-sql-execution' };
        const result = await connector.executeReadOnly(
          { connectionId: input.connectionId, sql: input.sql, maxRows: input.maxRows },
          ctx,
        );
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
          command: 'SELECT',
          rowCount: result.rowCount,
        };
      } finally {
        await cleanupConnector(connector);
      }
    },
  };
}
