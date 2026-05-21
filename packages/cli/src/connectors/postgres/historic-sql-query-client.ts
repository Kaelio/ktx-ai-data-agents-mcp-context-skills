import type { KtxPostgresQueryClient } from '../../context/ingest/index.js';
import { KtxPostgresScanConnector, type KtxPostgresScanConnectorOptions } from './connector.js';

export type KtxPostgresHistoricSqlQueryClientOptions = KtxPostgresScanConnectorOptions;

export class KtxPostgresHistoricSqlQueryClient implements KtxPostgresQueryClient {
  private readonly connectionId: string;
  private readonly connector: KtxPostgresScanConnector;

  constructor(options: KtxPostgresHistoricSqlQueryClientOptions) {
    this.connectionId = options.connectionId;
    this.connector = new KtxPostgresScanConnector(options);
  }

  async executeQuery(
    sql: string,
    params?: unknown[],
  ): Promise<{ headers: string[]; rows: unknown[][]; totalRows: number }> {
    const result = await this.connector.executeReadOnly(
      {
        connectionId: this.connectionId,
        sql,
        params,
      },
      {} as never,
    );
    return {
      headers: result.headers,
      rows: result.rows,
      totalRows: result.totalRows,
    };
  }

  async cleanup(): Promise<void> {
    await this.connector.cleanup();
  }
}
