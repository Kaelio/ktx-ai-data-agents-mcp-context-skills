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
