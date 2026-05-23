import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import {
  KtxSqlServerScanConnector,
  type KtxSqlServerConnectionConfig,
  type KtxSqlServerEndpointResolver,
  type KtxSqlServerPoolFactory,
} from './connector.js';

interface CreateSqlServerLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  poolFactory?: KtxSqlServerPoolFactory;
  endpointResolver?: KtxSqlServerEndpointResolver;
  now?: () => Date;
}

export function createSqlServerLiveDatabaseIntrospection(
  options: CreateSqlServerLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxSqlServerConnectionConfig | undefined;
      const connector = new KtxSqlServerScanConnector({
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
            driver: 'sqlserver',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `sqlserver-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
