import type { KtxProjectConfig, KtxProjectConnectionConfig } from '@ktx/context/project';
import type { DoctorCheck } from './doctor.js';

export interface HistoricSqlDoctorProject {
  projectDir: string;
  config: Pick<KtxProjectConfig, 'connections' | 'ingest'>;
}

export interface PostgresHistoricSqlDoctorProbeInput {
  projectDir: string;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
  env: NodeJS.ProcessEnv;
}

export interface PostgresHistoricSqlDoctorProbeResult {
  pgServerVersion: string;
  warnings: string[];
  info?: string[];
}

export type PostgresHistoricSqlDoctorProbe = (
  input: PostgresHistoricSqlDoctorProbeInput,
) => Promise<PostgresHistoricSqlDoctorProbeResult>;

export interface HistoricSqlDoctorDeps {
  env?: NodeJS.ProcessEnv;
  postgresHistoricSqlProbe?: PostgresHistoricSqlDoctorProbe;
}

function check(status: DoctorCheck['status'], id: string, label: string, detail: string, fix?: string): DoctorCheck {
  return fix ? { id, label, status, detail, fix } : { id, label, status, detail };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function queryHistoryRecord(connection: KtxProjectConnectionConfig): Record<string, unknown> | null {
  const context = recordValue(connection.context);
  return recordValue(context?.queryHistory);
}

function legacyHistoricSqlRecord(connection: KtxProjectConnectionConfig): Record<string, unknown> | null {
  return recordValue(connection.historicSql);
}

function isEnabledPostgresQueryHistory(connection: KtxProjectConnectionConfig): boolean {
  const queryHistory = queryHistoryRecord(connection);
  if (queryHistory) {
    return queryHistory.enabled === true;
  }
  const legacy = legacyHistoricSqlRecord(connection);
  return legacy?.enabled === true && legacy.dialect === 'postgres';
}

function isPostgresDriver(connection: KtxProjectConnectionConfig): boolean {
  const driver = String(connection.driver ?? '').toLowerCase();
  return driver === 'postgres' || driver === 'postgresql';
}

function checkId(connectionId: string): string {
  return `query-history-postgres-${connectionId.replace(/[^a-z0-9_-]+/gi, '-')}`;
}

function capabilityFailureFix(error: unknown, connectionId: string, projectDir: string): string {
  if (error instanceof Error && error.name === 'HistoricSqlExtensionMissingError' && 'remediation' in error) {
    return String(error.remediation);
  }
  if (error instanceof Error && error.name === 'HistoricSqlGrantsMissingError' && 'remediation' in error) {
    return String(error.remediation);
  }
  if (error instanceof Error && error.name === 'HistoricSqlVersionUnsupportedError') {
    return 'Use PostgreSQL 14 or newer, or disable query history for this connection';
  }
  return `Fix connections.${connectionId} Postgres settings, then rerun \`ktx status --project-dir ${projectDir}\``;
}

function failureDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().split('\n')[0] ?? error.message.trim();
  }
  return String(error);
}

function readinessDetail(result: PostgresHistoricSqlDoctorProbeResult): string {
  const warningText = result.warnings.length > 0 ? ` with warnings: ${result.warnings.join('; ')}` : '';
  const info = result.info ?? [];
  const infoText = info.length > 0 ? `; info: ${info.join('; ')}` : '';
  return `pg_stat_statements ready (${result.pgServerVersion})${warningText}${infoText}`;
}

async function defaultPostgresHistoricSqlProbe(
  input: PostgresHistoricSqlDoctorProbeInput,
): Promise<PostgresHistoricSqlDoctorProbeResult> {
  const [{ PostgresPgssReader }, { KtxPostgresHistoricSqlQueryClient, isKtxPostgresConnectionConfig }] =
    await Promise.all([import('@ktx/context/ingest'), import('@ktx/connector-postgres')]);

  const inputDriver = input.connection.driver ?? 'unknown';
  if (!isKtxPostgresConnectionConfig(input.connection)) {
    throw new Error(`Native PostgreSQL connector cannot run driver "${inputDriver}"`);
  }

  const client = new KtxPostgresHistoricSqlQueryClient({
    connectionId: input.connectionId,
    connection: input.connection,
    env: input.env,
  });
  try {
    return await new PostgresPgssReader().probe(client);
  } finally {
    await client.cleanup();
  }
}

export async function runPostgresHistoricSqlDoctorChecks(
  project: HistoricSqlDoctorProject,
  deps: HistoricSqlDoctorDeps = {},
): Promise<DoctorCheck[]> {
  const targets = Object.entries(project.config.connections)
    .filter(([, connection]) => isEnabledPostgresQueryHistory(connection))
    .sort(([left], [right]) => left.localeCompare(right));

  if (targets.length === 0) {
    return [
      check('pass', 'query-history-postgres', 'Postgres query history', 'No enabled Postgres query-history connections'),
    ];
  }

  const probe = deps.postgresHistoricSqlProbe ?? defaultPostgresHistoricSqlProbe;
  const env = deps.env ?? process.env;
  const checks: DoctorCheck[] = [];
  for (const [connectionId, connection] of targets) {
    const label = `Postgres query history (${connectionId})`;
    if (!isPostgresDriver(connection)) {
      checks.push(
        check(
          'fail',
          checkId(connectionId),
          label,
          `connections.${connectionId}.context.queryHistory is enabled but driver is ${String(connection.driver)}`,
          `Set connections.${connectionId}.driver to postgres or disable query history for this connection`,
        ),
      );
      continue;
    }

    try {
      const result = await probe({ projectDir: project.projectDir, connectionId, connection, env });
      if (result.warnings.length > 0) {
        checks.push(
          check(
            'warn',
            checkId(connectionId),
            label,
            readinessDetail(result),
            `Update the Postgres parameter group or config, then rerun \`ktx status --project-dir ${project.projectDir}\``,
          ),
        );
      } else {
        checks.push(check('pass', checkId(connectionId), label, readinessDetail(result)));
      }
    } catch (error) {
      checks.push(
        check(
          'fail',
          checkId(connectionId),
          label,
          failureDetail(error),
          capabilityFailureFix(error, connectionId, project.projectDir),
        ),
      );
    }
  }

  return checks;
}
