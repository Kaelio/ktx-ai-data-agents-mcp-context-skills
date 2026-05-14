import { describe, expect, it } from 'vitest';
import { connectionConfigSchema } from './driver-schemas.js';

describe('connectionConfigSchema (driver discriminated union)', () => {
  it.each([
    ['postgres', 'postgres://user:pass@host:5432/db'],
    ['postgresql', 'postgresql://user:pass@host:5432/db'],
    ['mysql', 'mysql://user:pass@host:3306/db'],
    ['snowflake', 'snowflake://account/db'],
    ['bigquery', 'bigquery://project/dataset'],
    ['sqlite', 'sqlite:///tmp/db.sqlite'],
    ['clickhouse', 'clickhouse://host:8123/db'],
    ['sqlserver', 'sqlserver://host:1433;database=db'],
  ])('parses %s warehouse connection', (driver, url) => {
    expect(connectionConfigSchema.parse({ driver, url })).toMatchObject({ driver, url });
  });

  it('preserves unknown warehouse fields via looseObject passthrough', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'postgres',
      url: 'postgres://x',
      historicSql: { enabled: true },
      context: { queryHistory: { enabled: false } },
    });
    expect(parsed).toMatchObject({
      driver: 'postgres',
      historicSql: { enabled: true },
      context: { queryHistory: { enabled: false } },
    });
  });

  it('rejects an unknown driver', () => {
    expect(() => connectionConfigSchema.parse({ driver: 'nope', url: 'x' })).toThrow();
  });
});

describe('connectionConfigSchema - context source drivers with mappings', () => {
  it('parses a metabase connection with mappings', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key_ref: 'env:METABASE_API_KEY',
      mappings: {
        databaseMappings: { '3': 'prod-warehouse' },
        syncEnabled: { '3': true },
        syncMode: 'ONLY',
      },
    });
    expect(parsed).toMatchObject({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      mappings: {
        databaseMappings: { '3': 'prod-warehouse' },
        syncMode: 'ONLY',
      },
    });
  });

  it('parses a looker connection with connectionMappings', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'looker',
      base_url: 'https://looker.example.com',
      client_id: 'abc',
      client_secret_ref: 'env:LOOKER_CLIENT_SECRET',
      mappings: { connectionMappings: { bigquery_prod: 'wh' } },
    });
    expect(parsed.mappings).toEqual({ connectionMappings: { bigquery_prod: 'wh' } });
  });

  it('parses a lookml connection with expectedLookerConnectionName', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'lookml',
      repoUrl: 'https://github.com/acme/looker.git',
      branch: 'main',
      mappings: { expectedLookerConnectionName: 'bigquery_prod' },
    });
    expect(parsed.mappings).toEqual({ expectedLookerConnectionName: 'bigquery_prod' });
  });

  it('rejects metabase mapping with non-integer database key', () => {
    expect(() =>
      connectionConfigSchema.parse({
        driver: 'metabase',
        api_url: 'https://x',
        mappings: { databaseMappings: { abc: 'wh' } },
      }),
    ).toThrow();
  });
});
