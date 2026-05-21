import type { LiveDatabaseIntrospectionPort } from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import {
  KtxBigQueryScanConnector,
  type KtxBigQueryClientFactory,
  type KtxBigQueryConnectionConfig,
} from './connector.js';

interface CreateBigQueryLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  clientFactory?: KtxBigQueryClientFactory;
  now?: () => Date;
}

export function createBigQueryLiveDatabaseIntrospection(
  options: CreateBigQueryLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxBigQueryConnectionConfig | undefined;
      const connector = new KtxBigQueryScanConnector({
        connectionId,
        connection,
        clientFactory: options.clientFactory,
        now: options.now,
      });
      try {
        return await connector.introspect({ connectionId, driver: 'bigquery' }, { runId: `bigquery-${connectionId}` });
      } finally {
        await connector.cleanup();
      }
    },
  };
}
