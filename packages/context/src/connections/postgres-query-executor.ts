import { Client, type ClientConfig } from 'pg';
import type {
  KtxSqlQueryExecutionInput,
  KtxSqlQueryExecutionResult,
  KtxSqlQueryExecutorPort,
} from './query-executor.js';
import { limitSqlForExecution } from './read-only-sql.js';

interface PgClientLike {
  connect(): Promise<unknown>;
  query(input: string | { text: string; rowMode: 'array' }): Promise<{
    fields: Array<{ name: string }>;
    rows: unknown[][];
    command: string;
    rowCount: number | null;
  }>;
  end(): Promise<void>;
}

interface PostgresQueryExecutorOptions {
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
  connectionTimeoutMs?: number;
  clientFactory?: (config: ClientConfig) => PgClientLike;
}

function connectionDriver(input: KtxSqlQueryExecutionInput): string {
  return String(input.connection?.driver ?? '').toLowerCase();
}

function createDefaultClient(config: ClientConfig): PgClientLike {
  return new Client(config);
}

export function createPostgresQueryExecutor(options: PostgresQueryExecutorOptions = {}): KtxSqlQueryExecutorPort {
  const clientFactory = options.clientFactory ?? createDefaultClient;
  return {
    async execute(input: KtxSqlQueryExecutionInput): Promise<KtxSqlQueryExecutionResult> {
      const driver = connectionDriver(input);
      const connection = input.connection;
      if (driver !== 'postgres' && driver !== 'postgresql') {
        throw new Error(`Local Postgres execution cannot run driver "${connection?.driver ?? 'unknown'}".`);
      }
      if (typeof connection?.url !== 'string' || connection.url.trim().length === 0) {
        throw new Error(`Local Postgres execution requires connections.${input.connectionId}.url.`);
      }

      const client = clientFactory({
        connectionString: connection.url,
        statement_timeout: options.statementTimeoutMs ?? 30_000,
        query_timeout: options.queryTimeoutMs ?? 35_000,
        connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
        application_name: 'ktx-local-query',
      });
      await client.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const result = await client.query({
          text: limitSqlForExecution(input.sql, input.maxRows),
          rowMode: 'array',
        });
        await client.query('COMMIT');
        return {
          headers: result.fields.map((field) => field.name),
          rows: result.rows,
          totalRows: result.rows.length,
          command: result.command,
          rowCount: result.rowCount,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    },
  };
}
