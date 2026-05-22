import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import {
  KtxMysqlScanConnector,
  type KtxMysqlConnectionConfig,
  type KtxMysqlEndpointResolver,
  type KtxMysqlPoolFactory,
} from './connector.js';

interface CreateMysqlLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  poolFactory?: KtxMysqlPoolFactory;
  endpointResolver?: KtxMysqlEndpointResolver;
  now?: () => Date;
}

export function createMysqlLiveDatabaseIntrospection(
  options: CreateMysqlLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxMysqlConnectionConfig | undefined;
      const connector = new KtxMysqlScanConnector({
        connectionId,
        connection,
        poolFactory: options.poolFactory,
        endpointResolver: options.endpointResolver,
        now: options.now,
      });
      try {
        return await connector.introspect(
          {
            connectionId,
            driver: 'mysql',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `mysql-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
