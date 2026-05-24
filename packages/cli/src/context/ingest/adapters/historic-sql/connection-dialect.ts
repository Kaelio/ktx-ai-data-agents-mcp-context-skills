import type { HistoricSqlDialect } from './types.js';

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function queryHistoryRecord(connection: unknown): Record<string, unknown> | null {
  const conn = recordOrNull(connection);
  const context = conn ? recordOrNull(conn.context) : null;
  return context ? recordOrNull(context.queryHistory) : null;
}

export function isQueryHistoryEnabled(connection: unknown): boolean {
  return queryHistoryRecord(connection)?.enabled === true;
}

/**
 * Resolves the query-history dialect for a connection. Returns null when
 * query history is disabled, or when the connection's driver has no
 * query-history reader.
 */
export function queryHistoryDialectForConnection(connection: unknown): HistoricSqlDialect | null {
  if (!isQueryHistoryEnabled(connection)) {
    return null;
  }
  const conn = recordOrNull(connection);
  const driver = String(conn?.driver ?? '').toLowerCase();
  if (driver === 'postgres') return 'postgres';
  if (driver === 'bigquery') return 'bigquery';
  if (driver === 'snowflake') return 'snowflake';
  return null;
}
