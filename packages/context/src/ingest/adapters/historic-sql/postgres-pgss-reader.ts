import {
  HistoricSqlExtensionMissingError,
  HistoricSqlGrantsMissingError,
  HistoricSqlVersionUnsupportedError,
} from './errors.js';
import {
  aggregatedTemplateSchema,
  type AggregatedTemplate,
  type HistoricSqlTimeWindow,
  type HistoricSqlUnifiedPullConfig,
  type KtxPostgresQueryClient,
  type PostgresPgssProbeResult,
} from './types.js';

interface QueryResultLike {
  headers: string[];
  rows: unknown[][];
  totalRows?: number;
  error?: string;
}

const STATS_INFO_SQL = 'SELECT stats_reset, dealloc FROM pg_stat_statements_info';
const VERSION_SQL = `
SELECT current_setting('server_version_num')::int AS server_version_num,
       version()                                  AS server_version
`.trim();
const EXTENSION_PROBE_SQL = 'SELECT 1 FROM pg_stat_statements LIMIT 1';
const GRANTS_PROBE_SQL = "SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS has_role";
const TRACKING_PROBE_SQL = "SELECT current_setting('pg_stat_statements.track') AS track";
const MAX_SETTING_PROBE_SQL = "SELECT current_setting('pg_stat_statements.max') AS max";
const RECOMMENDED_PGSS_MAX = 5000;

const AGGREGATE_SQL = `
SELECT queryid::text AS template_id,
       query AS canonical_sql,
       SUM(calls)::bigint AS executions,
       COUNT(DISTINCT userid) AS distinct_users,
       SUM(total_exec_time) / NULLIF(SUM(calls), 0) AS mean_ms,
       SUM(rows)::bigint AS rows_produced,
       COALESCE(
         json_agg(json_build_object('user', rolname, 'executions', calls) ORDER BY calls DESC)
           FILTER (WHERE userid IS NOT NULL),
         '[]'::json
       )::text AS top_users
FROM pg_stat_statements
LEFT JOIN pg_roles ON pg_roles.oid = pg_stat_statements.userid
WHERE toplevel = true
GROUP BY queryid, query
HAVING SUM(calls) >= $1
ORDER BY SUM(total_exec_time) DESC
`.trim();

const POSTGRES_EXTENSION_REMEDIATION = [
  'Run CREATE EXTENSION pg_stat_statements; against the connection database.',
  "Ensure shared_preload_libraries includes 'pg_stat_statements' in the Postgres parameter group or config.",
].join(' ');

const POSTGRES_GRANTS_REMEDIATION = 'GRANT pg_read_all_stats TO <connection role>;';

function queryClient(client: unknown): KtxPostgresQueryClient {
  if (
    client &&
    typeof client === 'object' &&
    'executeQuery' in client &&
    typeof (client as { executeQuery?: unknown }).executeQuery === 'function'
  ) {
    return client as KtxPostgresQueryClient;
  }
  throw new Error('Historic SQL Postgres PGSS reader requires a query client with executeQuery(sql, params?)');
}

async function execute(client: KtxPostgresQueryClient, sql: string, params?: unknown[]): Promise<QueryResultLike> {
  const result = await client.executeQuery(sql, params);
  if ('error' in result && typeof result.error === 'string' && result.error.length > 0) {
    throw new Error(result.error);
  }
  return result;
}

function indexByHeader(headers: string[]): Map<string, number> {
  const out = new Map<string, number>();
  headers.forEach((header, index) => out.set(header.toLowerCase(), index));
  return out;
}

function value(row: unknown[], headerIndexes: Map<string, number>, header: string): unknown {
  const index = headerIndexes.get(header.toLowerCase());
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
    throw new Error(`Postgres pg_stat_statements row is missing ${field}`);
  }
  return text;
}

function requiredFiniteNumber(raw: unknown, field: string): number {
  const number = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(number)) {
    throw new Error(`Postgres pg_stat_statements row has invalid ${field}: ${String(raw)}`);
  }
  return number;
}

function requiredInteger(raw: unknown, field: string): number {
  return Math.trunc(requiredFiniteNumber(raw, field));
}

function nullableNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const number = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(number) ? number : null;
}

function nullableInteger(raw: unknown): number | null {
  const number = nullableNumber(raw);
  return number === null ? null : Math.trunc(number);
}

function nullableIsoTimestamp(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstRow(result: QueryResultLike, context: string): { row: unknown[]; headers: Map<string, number> } {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Postgres historic-SQL ${context} query returned no rows`);
  }
  return { row, headers: indexByHeader(result.headers) };
}

function isMissingPgssRelation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation ["']?pg_stat_statements["']? does not exist/i.test(message);
}

function isPgssPreloadRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /pg_stat_statements.*shared_preload_libraries/i.test(message);
}

function extensionMissingError(cause: unknown, message?: string): HistoricSqlExtensionMissingError {
  return new HistoricSqlExtensionMissingError({
    dialect: 'postgres',
    message: message ?? 'pg_stat_statements extension is not installed in the connection database.',
    remediation: POSTGRES_EXTENSION_REMEDIATION,
    cause,
  });
}

function grantsMissingError(): HistoricSqlGrantsMissingError {
  return new HistoricSqlGrantsMissingError({
    dialect: 'postgres',
    message: 'Postgres connection role lacks pg_read_all_stats for historic-SQL ingest.',
    remediation: POSTGRES_GRANTS_REMEDIATION,
  });
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

export class PostgresPgssReader {
  async probe(client: unknown): Promise<PostgresPgssProbeResult> {
    const pgClient = queryClient(client);
    const versionResult = await execute(pgClient, VERSION_SQL);
    const { row: versionRow, headers: versionHeaders } = firstRow(versionResult, 'version probe');
    const serverVersionNum = requiredFiniteNumber(
      value(versionRow, versionHeaders, 'server_version_num'),
      'server_version_num',
    );
    const pgServerVersion = requiredString(value(versionRow, versionHeaders, 'server_version'), 'server_version');

    if (serverVersionNum < 140000) {
      throw new HistoricSqlVersionUnsupportedError({
        dialect: 'postgres',
        detectedVersion: pgServerVersion,
        minimumVersion: 'PostgreSQL 14',
      });
    }

    try {
      await execute(pgClient, EXTENSION_PROBE_SQL);
    } catch (error) {
      if (isMissingPgssRelation(error)) {
        throw extensionMissingError(error);
      }
      if (isPgssPreloadRequired(error)) {
        throw extensionMissingError(
          error,
          'pg_stat_statements is installed but not loaded via shared_preload_libraries.',
        );
      }
      throw error;
    }

    const grantsResult = await execute(pgClient, GRANTS_PROBE_SQL);
    const { row: grantsRow, headers: grantsHeaders } = firstRow(grantsResult, 'grant probe');
    if (value(grantsRow, grantsHeaders, 'has_role') !== true) {
      throw grantsMissingError();
    }

    const trackingResult = await execute(pgClient, TRACKING_PROBE_SQL);
    const { row: trackingRow, headers: trackingHeaders } = firstRow(trackingResult, 'tracking probe');
    const track = nullableString(value(trackingRow, trackingHeaders, 'track'));

    const maxResult = await execute(pgClient, MAX_SETTING_PROBE_SQL);
    const { row: maxRow, headers: maxHeaders } = firstRow(maxResult, 'max-setting probe');
    const pgssMax = nullableInteger(value(maxRow, maxHeaders, 'max'));

    const warnings: string[] = [];
    const info: string[] = [];
    if (track === 'none') {
      warnings.push('pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config');
    }
    if (pgssMax !== null && pgssMax < RECOMMENDED_PGSS_MAX) {
      info.push(
        `pg_stat_statements.max is ${pgssMax}; set it to at least ${RECOMMENDED_PGSS_MAX} to reduce query-template eviction churn`,
      );
    }

    return { pgServerVersion, warnings, info };
  }

  async *fetchAggregated(
    client: unknown,
    window: HistoricSqlTimeWindow,
    config: HistoricSqlUnifiedPullConfig,
  ): AsyncIterable<AggregatedTemplate> {
    const pgClient = queryClient(client);
    const statsResult = await execute(pgClient, STATS_INFO_SQL);
    const { row: statsRow, headers: statsHeaders } = firstRow(statsResult, 'stats-info');
    const firstSeen = nullableIsoTimestamp(value(statsRow, statsHeaders, 'stats_reset')) ?? window.start.toISOString();
    const result = await execute(pgClient, AGGREGATE_SQL, [config.minExecutions]);
    const indexes = indexByHeader(result.headers);
    for (const row of result.rows) {
      yield aggregatedTemplateSchema.parse({
        templateId: requiredString(value(row, indexes, 'template_id'), 'template_id'),
        canonicalSql: requiredString(value(row, indexes, 'canonical_sql'), 'canonical_sql'),
        dialect: 'postgres',
        stats: {
          executions: requiredInteger(value(row, indexes, 'executions'), 'executions'),
          distinctUsers: requiredInteger(value(row, indexes, 'distinct_users'), 'distinct_users'),
          firstSeen,
          lastSeen: window.end.toISOString(),
          p50RuntimeMs: nullableNumber(value(row, indexes, 'mean_ms')),
          p95RuntimeMs: nullableNumber(value(row, indexes, 'mean_ms')),
          errorRate: 0,
          rowsProduced: nullableInteger(value(row, indexes, 'rows_produced')),
        },
        topUsers: parseTopUsers(value(row, indexes, 'top_users')),
      });
    }
  }
}
