import type { KtxSqlQueryExecutionInput, KtxSqlQueryExecutorPort } from './context/connections/index.js';
import type { KtxLocalProject } from './context/project/index.js';
import type { KtxScanConnector, KtxScanContext } from './context/scan/index.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';

type CreateConnector = typeof createKtxCliScanConnector;

export interface KtxCliIngestQueryExecutorDeps {
  createConnector?: CreateConnector;
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
