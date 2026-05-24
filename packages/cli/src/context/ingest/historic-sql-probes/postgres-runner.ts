import {
  HistoricSqlExtensionMissingError,
  HistoricSqlGrantsMissingError,
  HistoricSqlVersionUnsupportedError,
} from '../adapters/historic-sql/errors.js';
import { PostgresPgssReader } from '../adapters/historic-sql/postgres-pgss-reader.js';
import type { PostgresPgssProbeResult } from '../adapters/historic-sql/types.js';
import {
  type HistoricSqlFixAdvice,
  type HistoricSqlProbeInput,
  type HistoricSqlProbeRunner,
  type HistoricSqlSuccessDetail,
} from '../historic-sql-probes.js';
import {
  isKtxPostgresConnectionConfig,
  type KtxPostgresConnectionConfig,
} from '../../../connectors/postgres/connector.js';
import { KtxPostgresHistoricSqlQueryClient } from '../../../connectors/postgres/historic-sql-query-client.js';

interface ClientHandle {
  client: unknown;
  cleanup(): Promise<void>;
}

interface PostgresPgssProbeRunnerOptions {
  reader?: { probe(client: unknown): Promise<PostgresPgssProbeResult> };
  createClient?: (
    input: HistoricSqlProbeInput & { connection: KtxPostgresConnectionConfig },
  ) => ClientHandle;
}

function genericAdvice(error: unknown, catalogName: string): HistoricSqlFixAdvice {
  return {
    failHeadline: `${catalogName} readiness check failed`,
    remediation: error instanceof Error ? error.message : String(error),
  };
}

function infoSuffix(info: readonly string[] | undefined): string {
  return info && info.length > 0 ? `; ${info.join('; ')}` : '';
}

export class PostgresPgssProbeRunner implements HistoricSqlProbeRunner {
  readonly dialect = 'postgres' as const;
  readonly catalogName = 'pg_stat_statements';

  private readonly reader: { probe(client: unknown): Promise<PostgresPgssProbeResult> };
  private readonly createClient: (
    input: HistoricSqlProbeInput & { connection: KtxPostgresConnectionConfig },
  ) => ClientHandle;

  constructor(options: PostgresPgssProbeRunnerOptions = {}) {
    this.reader = options.reader ?? new PostgresPgssReader();
    this.createClient =
      options.createClient ??
      ((input) => {
        const client = new KtxPostgresHistoricSqlQueryClient({
          connectionId: input.connectionId,
          connection: input.connection,
          env: input.env,
        });
        return { client, cleanup: () => client.cleanup() };
      });
  }

  async run(input: HistoricSqlProbeInput): Promise<PostgresPgssProbeResult> {
    const inputDriver = input.connection.driver ?? 'unknown';
    if (!isKtxPostgresConnectionConfig(input.connection)) {
      throw new Error(`Native PostgreSQL connector cannot run driver "${inputDriver}"`);
    }
    const handle = this.createClient({
      ...input,
      connection: input.connection,
    });
    try {
      return await this.reader.probe(handle.client);
    } finally {
      await handle.cleanup();
    }
  }

  formatSuccessDetail(result: unknown): HistoricSqlSuccessDetail {
    const pgssResult = result as PostgresPgssProbeResult;
    return {
      detail: `pg_stat_statements ready (${pgssResult.pgServerVersion})${infoSuffix(pgssResult.info)}`,
      warnings: pgssResult.warnings,
    };
  }

  fixAdvice(error: unknown): HistoricSqlFixAdvice {
    if (error instanceof HistoricSqlExtensionMissingError) {
      return {
        failHeadline: 'pg_stat_statements extension is missing',
        remediation: error.remediation,
      };
    }
    if (error instanceof HistoricSqlGrantsMissingError) {
      return {
        failHeadline: 'Postgres connection role lacks pg_read_all_stats',
        remediation: error.remediation,
      };
    }
    if (error instanceof HistoricSqlVersionUnsupportedError) {
      return {
        failHeadline: 'Postgres version too old',
        remediation: 'Use PostgreSQL 14 or newer, or disable query history for this connection',
      };
    }
    return genericAdvice(error, this.catalogName);
  }
}
