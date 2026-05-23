import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import {
  KtxSnowflakeScanConnector,
  type KtxSnowflakeConnectionConfig,
  type KtxSnowflakeDriverFactory,
  type KtxSnowflakeSdkOptionsProvider,
} from './connector.js';

interface CreateSnowflakeLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  projectDir?: string;
  driverFactory?: KtxSnowflakeDriverFactory;
  sdkOptionsProvider?: KtxSnowflakeSdkOptionsProvider;
  now?: () => Date;
}

export function createSnowflakeLiveDatabaseIntrospection(
  options: CreateSnowflakeLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxSnowflakeConnectionConfig | undefined;
      const connector = new KtxSnowflakeScanConnector({
        connectionId,
        connection,
        ...(options.projectDir ? { projectDir: options.projectDir } : {}),
        driverFactory: options.driverFactory,
        sdkOptionsProvider: options.sdkOptionsProvider,
        now: options.now,
      });
      try {
        return await connector.introspect(
          {
            connectionId,
            driver: 'snowflake',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `snowflake-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
