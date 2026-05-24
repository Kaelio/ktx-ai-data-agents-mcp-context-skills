import { HistoricSqlGrantsMissingError } from '../adapters/historic-sql/errors.js';
import { SnowflakeHistoricSqlQueryHistoryReader } from '../adapters/historic-sql/snowflake-query-history-reader.js';
import {
  type HistoricSqlFixAdvice,
  type HistoricSqlProbeInput,
  type HistoricSqlProbeRunner,
  type HistoricSqlSuccessDetail,
} from '../historic-sql-probes.js';
import {
  isKtxSnowflakeConnectionConfig,
  type KtxSnowflakeConnectionConfig,
} from '../../../connectors/snowflake/connector.js';
import { KtxSnowflakeHistoricSqlQueryClient } from '../../../connectors/snowflake/historic-sql-query-client.js';

interface GenericProbeResult {
  warnings: string[];
  info?: string[];
}

interface ClientHandle {
  client: unknown;
  cleanup(): Promise<void>;
}

interface SnowflakeAccountUsageProbeRunnerOptions {
  reader?: { probe(client: unknown): Promise<GenericProbeResult> };
  createClient?: (
    input: HistoricSqlProbeInput & { connection: KtxSnowflakeConnectionConfig },
  ) => ClientHandle;
}

function infoSuffix(info: readonly string[] | undefined): string {
  return info && info.length > 0 ? `; ${info.join('; ')}` : '';
}

export class SnowflakeAccountUsageProbeRunner implements HistoricSqlProbeRunner {
  readonly dialect = 'snowflake' as const;
  readonly catalogName = 'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY';

  private readonly reader: { probe(client: unknown): Promise<GenericProbeResult> };
  private readonly createClient: (
    input: HistoricSqlProbeInput & { connection: KtxSnowflakeConnectionConfig },
  ) => ClientHandle;

  constructor(options: SnowflakeAccountUsageProbeRunnerOptions = {}) {
    this.reader = options.reader ?? new SnowflakeHistoricSqlQueryHistoryReader();
    this.createClient =
      options.createClient ??
      ((input) => {
        const client = new KtxSnowflakeHistoricSqlQueryClient({
          connectionId: input.connectionId,
          connection: input.connection,
          projectDir: input.projectDir,
          env: input.env,
        });
        return { client, cleanup: () => client.cleanup() };
      });
  }

  async run(input: HistoricSqlProbeInput): Promise<GenericProbeResult> {
    const inputDriver = input.connection.driver ?? 'unknown';
    if (!isKtxSnowflakeConnectionConfig(input.connection)) {
      throw new Error(`Native Snowflake connector cannot run driver "${inputDriver}"`);
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
    const probeResult = result as GenericProbeResult;
    return {
      detail: `${this.catalogName} ready${infoSuffix(probeResult.info)}`,
      warnings: probeResult.warnings,
    };
  }

  fixAdvice(error: unknown): HistoricSqlFixAdvice {
    if (error instanceof HistoricSqlGrantsMissingError) {
      return {
        failHeadline: 'Snowflake role cannot read SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
        remediation: error.remediation,
      };
    }
    return {
      failHeadline: `${this.catalogName} readiness check failed`,
      remediation: error instanceof Error ? error.message : String(error),
    };
  }
}
