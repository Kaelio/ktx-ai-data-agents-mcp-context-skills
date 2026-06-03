import { HistoricSqlGrantsMissingError } from './errors.js';
import {
  aggregatedTemplateSchema,
  type AggregatedTemplate,
  type HistoricSqlTimeWindow,
  type HistoricSqlUnifiedPullConfig,
} from './types.js';

interface QueryResultLike {
  headers: string[];
  rows: unknown[][];
  totalRows: number;
  error?: string;
}

interface QueryClientLike {
  executeQuery(query: string): Promise<QueryResultLike>;
}

const PROBE_SQL = 'SELECT 1 FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY LIMIT 1';

const SNOWFLAKE_GRANTS_REMEDIATION =
  'GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE <connection role>;';

function queryClient(client: unknown): QueryClientLike {
  if (
    client &&
    typeof client === 'object' &&
    'executeQuery' in client &&
    typeof (client as { executeQuery?: unknown }).executeQuery === 'function'
  ) {
    return client as QueryClientLike;
  }
  throw new Error('Historic SQL Snowflake reader requires a query client with executeQuery(query)');
}

function grantsError(cause: unknown): HistoricSqlGrantsMissingError {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : 'Snowflake role cannot query SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY.';
  return new HistoricSqlGrantsMissingError({
    dialect: 'snowflake',
    message: `Missing Snowflake audit grants for historic-SQL ingest: ${message}`,
    remediation: SNOWFLAKE_GRANTS_REMEDIATION,
    cause,
  });
}

function timestampLiteral(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Snowflake query-history timestamp: ${String(value)}`);
  }
  return `'${date.toISOString().replace(/'/g, "''")}'::TIMESTAMP_TZ`;
}

function indexByHeader(headers: string[]): Map<string, number> {
  const out = new Map<string, number>();
  headers.forEach((header, index) => {
    out.set(header.toUpperCase(), index);
  });
  return out;
}

function value(row: unknown[], indexes: Map<string, number>, name: string): unknown {
  const index = indexes.get(name.toUpperCase());
  return index === undefined ? null : row[index];
}

function nullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const text = String(raw);
  return text.length > 0 ? text : null;
}

function requiredString(raw: unknown, field: string): string {
  const text = nullableString(raw);
  if (!text) {
    throw new Error(`Snowflake QUERY_HISTORY row is missing ${field}`);
  }
  return text;
}

function nullableNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const number = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(number)) {
    return null;
  }
  return number;
}

function requiredNumber(raw: unknown, field: string): number {
  const number = nullableNumber(raw);
  if (number === null) {
    throw new Error(`Snowflake QUERY_HISTORY row has invalid ${field}: ${String(raw)}`);
  }
  return number;
}

function requiredInteger(raw: unknown, field: string): number {
  return Math.trunc(requiredNumber(raw, field));
}

function nullableInteger(raw: unknown): number | null {
  const number = nullableNumber(raw);
  return number === null ? null : Math.trunc(number);
}

function isoTimestamp(raw: unknown, field: string): string {
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  const text = requiredString(raw, field);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Snowflake QUERY_HISTORY row has invalid ${field}: ${text}`);
  }
  return date.toISOString();
}

function parseTopUsers(raw: unknown): Array<{ user: string | null; executions: number }> {
  const text = nullableString(raw);
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') {
        return [];
      }
      const user = nullableString((entry as { user?: unknown }).user);
      const executions = nullableInteger((entry as { executions?: unknown }).executions);
      return executions === null ? [] : [{ user, executions }];
    });
  } catch {
    return [];
  }
}

function mapAggregatedRow(row: unknown[], indexes: Map<string, number>): AggregatedTemplate {
  return aggregatedTemplateSchema.parse({
    templateId: requiredString(value(row, indexes, 'template_id'), 'template_id'),
    canonicalSql: requiredString(value(row, indexes, 'canonical_sql'), 'canonical_sql'),
    dialect: 'snowflake',
    stats: {
      executions: requiredInteger(value(row, indexes, 'executions'), 'executions'),
      distinctUsers: requiredInteger(value(row, indexes, 'distinct_users'), 'distinct_users'),
      firstSeen: isoTimestamp(value(row, indexes, 'first_seen'), 'first_seen'),
      lastSeen: isoTimestamp(value(row, indexes, 'last_seen'), 'last_seen'),
      p50RuntimeMs: nullableNumber(value(row, indexes, 'p50_ms')),
      p95RuntimeMs: nullableNumber(value(row, indexes, 'p95_ms')),
      errorRate: requiredNumber(value(row, indexes, 'error_rate'), 'error_rate'),
      rowsProduced: nullableInteger(value(row, indexes, 'rows_produced')),
    },
    topUsers: parseTopUsers(value(row, indexes, 'top_users')),
  });
}

export class SnowflakeHistoricSqlQueryHistoryReader {
  async probe(client: unknown): Promise<{ warnings: string[]; info: string[] }> {
    let result: QueryResultLike;
    try {
      result = await queryClient(client).executeQuery(PROBE_SQL);
    } catch (error) {
      throw grantsError(error);
    }
    if (result.error) {
      throw grantsError(result.error);
    }
    return { warnings: [], info: [] };
  }

  async *fetchAggregated(
    client: unknown,
    window: HistoricSqlTimeWindow,
    config: HistoricSqlUnifiedPullConfig,
  ): AsyncIterable<AggregatedTemplate> {
    const sql = `
WITH filtered_queries AS (
  SELECT
    query_hash,
    query_text,
    user_name,
    start_time,
    total_elapsed_time,
    execution_status,
    rows_produced
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
  WHERE query_text IS NOT NULL
    AND query_type IN ('SELECT', 'MERGE')
    AND start_time >= ${timestampLiteral(window.start)}
    AND start_time < ${timestampLiteral(window.end)}
),
template_stats AS (
  SELECT
    query_hash AS template_id,
    MIN(query_text) AS canonical_sql,
    COUNT(*) AS executions,
    COUNT(DISTINCT user_name) AS distinct_users,
    MIN(start_time) AS first_seen,
    MAX(start_time) AS last_seen,
    APPROX_PERCENTILE(total_elapsed_time, 0.50) AS p50_ms,
    APPROX_PERCENTILE(total_elapsed_time, 0.95) AS p95_ms,
    DIV0(COUNT_IF(execution_status != 'SUCCESS'), COUNT(*)) AS error_rate,
    SUM(rows_produced) AS rows_produced
  FROM filtered_queries
  GROUP BY query_hash
  HAVING COUNT(*) >= ${config.minExecutions}
),
template_users AS (
  SELECT
    query_hash AS template_id,
    user_name AS user,
    COUNT(*) AS executions,
    MAX(start_time) AS last_seen
  FROM filtered_queries
  GROUP BY query_hash, user_name
)
SELECT
  stats.template_id,
  stats.canonical_sql,
  stats.executions,
  stats.distinct_users,
  stats.first_seen,
  stats.last_seen,
  stats.p50_ms,
  stats.p95_ms,
  stats.error_rate,
  stats.rows_produced,
  ARRAY_AGG(
    OBJECT_CONSTRUCT('user', users.user, 'executions', users.executions)
  ) WITHIN GROUP (ORDER BY users.executions DESC, users.last_seen DESC)::string AS top_users
FROM template_stats AS stats
JOIN template_users AS users
  ON users.template_id = stats.template_id
GROUP BY
  stats.template_id,
  stats.canonical_sql,
  stats.executions,
  stats.distinct_users,
  stats.first_seen,
  stats.last_seen,
  stats.p50_ms,
  stats.p95_ms,
  stats.error_rate,
  stats.rows_produced
ORDER BY stats.executions DESC`.trim();
    const result = await queryClient(client).executeQuery(sql);
    if (result.error) {
      throw grantsError(result.error);
    }
    const indexes = indexByHeader(result.headers);
    for (const row of result.rows) {
      yield mapAggregatedRow(row, indexes);
    }
  }
}
