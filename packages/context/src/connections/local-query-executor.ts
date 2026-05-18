import { createPostgresQueryExecutor } from './postgres-query-executor.js';
import type {
  KtxSqlQueryExecutionInput,
  KtxSqlQueryExecutionResult,
  KtxSqlQueryExecutorPort,
} from './query-executor.js';
import { createSqliteQueryExecutor } from './sqlite-query-executor.js';

export interface DefaultLocalQueryExecutorOptions {
  postgres?: KtxSqlQueryExecutorPort;
  sqlite?: KtxSqlQueryExecutorPort;
  duckdb?: KtxSqlQueryExecutorPort;
}

function driverFor(input: KtxSqlQueryExecutionInput): string {
  return String(input.connection?.driver ?? '').toLowerCase();
}

export function createDefaultLocalQueryExecutor(options: DefaultLocalQueryExecutorOptions = {}): KtxSqlQueryExecutorPort {
  const postgres = options.postgres ?? createPostgresQueryExecutor();
  const sqlite = options.sqlite ?? createSqliteQueryExecutor();

  return {
    async execute(input: KtxSqlQueryExecutionInput): Promise<KtxSqlQueryExecutionResult> {
      const driver = driverFor(input);
      if (driver === 'postgres' || driver === 'postgresql') {
        return postgres.execute(input);
      }
      if (driver === 'sqlite' || driver === 'sqlite3') {
        return sqlite.execute(input);
      }
      if (driver === 'duckdb') {
        if (!options.duckdb) {
          throw new Error(`No local query executor is configured for driver "${input.connection?.driver ?? 'unknown'}".`);
        }
        return options.duckdb.execute(input);
      }
      throw new Error(`No local query executor is configured for driver "${input.connection?.driver ?? 'unknown'}".`);
    },
  };
}
