import type { LiveDatabaseIntrospectionPort } from '../../context/ingest/index.js';
import type { KtxProjectConnectionConfig } from '../../context/project/index.js';
import {
  KtxClickHouseScanConnector,
  type KtxClickHouseClientFactory,
  type KtxClickHouseConnectionConfig,
  type KtxClickHouseEndpointResolver,
} from './connector.js';

interface CreateClickHouseLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  clientFactory?: KtxClickHouseClientFactory;
  endpointResolver?: KtxClickHouseEndpointResolver;
  now?: () => Date;
}

export function createClickHouseLiveDatabaseIntrospection(
  options: CreateClickHouseLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxClickHouseConnectionConfig | undefined;
      const connector = new KtxClickHouseScanConnector({
        connectionId,
        connection,
        clientFactory: options.clientFactory,
        endpointResolver: options.endpointResolver,
        now: options.now,
      });
      try {
        return await connector.introspect(
          { connectionId, driver: 'clickhouse' },
          { runId: `clickhouse-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
