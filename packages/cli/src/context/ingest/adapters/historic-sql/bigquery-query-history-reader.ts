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

export interface BigQueryHistoricSqlQueryHistoryReaderOptions {
  projectId: string;
  region: string;
}

const BIGQUERY_GRANTS_REMEDIATION =
  'Grant roles/bigquery.resourceViewer on the BigQuery project, or grant a custom role containing bigquery.jobs.listAll.';

function queryClient(client: unknown): QueryClientLike {
  if (
    client &&
    typeof client === 'object' &&
    'executeQuery' in client &&
    typeof (client as { executeQuery?: unknown }).executeQuery === 'function'
  ) {
    return client as QueryClientLike;
  }
  throw new Error('Historic SQL BigQuery reader requires a query client with executeQuery(query)');
}

function grantsError(cause: unknown): HistoricSqlGrantsMissingError {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : 'BigQuery principal cannot query INFORMATION_SCHEMA.JOBS_BY_PROJECT.';
  return new HistoricSqlGrantsMissingError({
    dialect: 'bigquery',
    message: `Missing BigQuery audit grants for historic-SQL ingest: ${message}`,
    remediation: BIGQUERY_GRANTS_REMEDIATION,
    cause,
  });
}

function normalizeProjectId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid BigQuery project id for historic-SQL ingest: ${value}`);
  }
  return value;
}

function normalizeRegion(value: string): string {
  const region = value.trim().toLowerCase().replace(/^region-/, '');
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new Error(`Invalid BigQuery region for historic-SQL ingest: ${value}`);
  }
  return region;
}

function timestampExpression(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid BigQuery query-history timestamp: ${String(value)}`);
  }
  return `TIMESTAMP('${date.toISOString().replace(/'/g, "\\'")}')`;
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
    throw new Error(`BigQuery JOBS_BY_PROJECT row is missing ${field}`);
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
  return Math.max(0, number);
}

function requiredNumber(raw: unknown, field: string): number {
  const number = nullableNumber(raw);
  if (number === null) {
    throw new Error(`BigQuery JOBS_BY_PROJECT row has invalid ${field}: ${String(raw)}`);
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
    throw new Error(`BigQuery JOBS_BY_PROJECT row has invalid ${field}: ${text}`);
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
    dialect: 'bigquery',
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

export class BigQueryHistoricSqlQueryHistoryReader {
  private readonly viewPath: string;

  constructor(options: BigQueryHistoricSqlQueryHistoryReaderOptions) {
    const projectId = normalizeProjectId(options.projectId);
    const region = normalizeRegion(options.region);
    this.viewPath = `\`${projectId}.region-${region}.INFORMATION_SCHEMA.JOBS_BY_PROJECT\``;
  }

  async probe(client: unknown): Promise<{ warnings: string[]; info: string[] }> {
    let result: QueryResultLike;
    try {
      result = await queryClient(client).executeQuery(`SELECT 1 FROM ${this.viewPath} LIMIT 1`);
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
SELECT
  query_hash AS template_id,
  MIN(query) AS canonical_sql,
  COUNT(*) AS executions,
  COUNT(DISTINCT user_email) AS distinct_users,
  MIN(creation_time) AS first_seen,
  MAX(creation_time) AS last_seen,
  APPROX_QUANTILES(TIMESTAMP_DIFF(end_time, creation_time, MILLISECOND), 100)[OFFSET(50)] AS p50_ms,
  APPROX_QUANTILES(TIMESTAMP_DIFF(end_time, creation_time, MILLISECOND), 100)[OFFSET(95)] AS p95_ms,
  SAFE_DIVIDE(COUNTIF(error_result IS NOT NULL), COUNT(*)) AS error_rate,
  CAST(NULL AS INT64) AS rows_produced,
  TO_JSON_STRING(ARRAY_AGG(STRUCT(user_email AS user, 1 AS executions) ORDER BY creation_time DESC LIMIT 5)) AS top_users
FROM ${this.viewPath}
WHERE job_type = 'QUERY'
  AND statement_type IN ('SELECT', 'MERGE')
  AND creation_time >= ${timestampExpression(window.start)}
  AND creation_time < ${timestampExpression(window.end)}
  AND query IS NOT NULL
GROUP BY query_hash
HAVING COUNT(*) >= ${config.minExecutions}
ORDER BY executions DESC`.trim();
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
