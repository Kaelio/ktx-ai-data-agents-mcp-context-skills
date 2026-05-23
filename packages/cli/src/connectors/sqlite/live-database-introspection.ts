import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import { KtxSqliteScanConnector, type KtxSqliteConnectionConfig } from './connector.js';

export interface CreateSqliteLiveDatabaseIntrospectionOptions {
  projectDir?: string;
  connections: Record<string, KtxProjectConnectionConfig>;
  now?: () => Date;
}

export function createSqliteLiveDatabaseIntrospection(
  options: CreateSqliteLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxSqliteConnectionConfig | undefined;
      const connector = new KtxSqliteScanConnector({
        connectionId,
        connection,
        projectDir: options.projectDir,
        now: options.now,
      });
      try {
        return await connector.introspect(
          {
            connectionId,
            driver: 'sqlite',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `sqlite-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
