import { KtxSnowflakeScanConnector, type KtxSnowflakeScanConnectorOptions } from './connector.js';

export type KtxSnowflakeHistoricSqlQueryClientOptions = KtxSnowflakeScanConnectorOptions;

export class KtxSnowflakeHistoricSqlQueryClient {
  private readonly connectionId: string;
  private readonly connector: KtxSnowflakeScanConnector;

  constructor(options: KtxSnowflakeHistoricSqlQueryClientOptions) {
    this.connectionId = options.connectionId;
    this.connector = new KtxSnowflakeScanConnector(options);
  }

  async executeQuery(
    sql: string,
  ): Promise<{ headers: string[]; rows: unknown[][]; totalRows: number }> {
    const result = await this.connector.executeReadOnly(
      { connectionId: this.connectionId, sql },
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
