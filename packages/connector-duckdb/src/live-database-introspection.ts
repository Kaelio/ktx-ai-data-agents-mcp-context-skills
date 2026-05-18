import type { LiveDatabaseIntrospectionPort } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import { KtxDuckDbScanConnector, type KtxDuckDbConnectionConfig } from './connector.js';

export interface CreateDuckDbLiveDatabaseIntrospectionOptions {
  projectDir?: string;
  connections: Record<string, KtxProjectConnectionConfig>;
  now?: () => Date;
}

export function createDuckDbLiveDatabaseIntrospection(
  options: CreateDuckDbLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxDuckDbConnectionConfig | undefined;
      const connector = new KtxDuckDbScanConnector({
        connectionId,
        connection,
        projectDir: options.projectDir,
        now: options.now,
      });
      try {
        return await connector.introspect({ connectionId, driver: 'duckdb' as never }, { runId: `duckdb-${connectionId}` });
      } finally {
        await connector.cleanup();
      }
    },
  };
}
