import { describe, expect, it } from 'vitest';
import { getDialectForDriver } from './dialects.js';

describe('getDialectForDriver', () => {
  it.each([
    ['postgres', '"public"."orders"'],
    ['mysql', '`public`.`orders`'],
    ['clickhouse', '`public`.`orders`'],
    ['sqlite', '"orders"'],
    ['snowflake', '"analytics"."public"."orders"'],
    ['bigquery', '`analytics`.`public`.`orders`'],
    ['sqlserver', '[analytics].[public].[orders]'],
  ] as const)('formats table names for %s', (driver, expected) => {
    const dialect = getDialectForDriver(driver);
    expect(
      dialect.formatTableName({
        catalog: driver === 'snowflake' || driver === 'bigquery' || driver === 'sqlserver' ? 'analytics' : null,
        db: driver === 'sqlite' ? null : 'public',
        name: 'orders',
      }),
    ).toBe(expected);
  });

  it('throws with a supported-driver list for unknown drivers', () => {
    expect(() => getDialectForDriver('oracle')).toThrow(
      'Unsupported warehouse driver "oracle". Supported drivers: bigquery, clickhouse, mysql, postgres, sqlite, snowflake, sqlserver',
    );
  });

  it('rejects legacy driver aliases', () => {
    expect(() => getDialectForDriver('postgresql')).toThrow('Unsupported warehouse driver "postgresql"');
    expect(() => getDialectForDriver('sqlite3')).toThrow('Unsupported warehouse driver "sqlite3"');
  });
});
