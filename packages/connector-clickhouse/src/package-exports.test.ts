import { describe, expect, it } from 'vitest';

describe('@ktx/connector-clickhouse package exports', () => {
  it(
    'exports public connector APIs during package bootstrap',
    async () => {
      const connector = await import('./index.js');

      expect(connector.KtxClickHouseDialect).toBeTypeOf('function');
      expect(connector.KtxClickHouseScanConnector).toBeTypeOf('function');
      expect(connector.clickHouseClientConfigFromConfig).toBeTypeOf('function');
      expect(connector.createClickHouseLiveDatabaseIntrospection).toBeTypeOf('function');
    },
    20_000,
  );
});
