import { describe, expect, it } from 'vitest';
import { getDialectForDriver } from './dialects.js';

describe('getDialectForDriver', () => {
  it.each([
    ['postgres', '"public"."orders"'],
    ['postgresql', '"public"."orders"'],
    ['mysql', '`public`.`orders`'],
    ['clickhouse', '`public`.`orders`'],
    ['sqlite', '"orders"'],
    ['duckdb', '"public"."orders"'],
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
      'Unsupported warehouse driver "oracle". Supported drivers: bigquery, clickhouse, duckdb, mysql, postgres, postgresql, sqlite, sqlite3, snowflake, sqlserver',
    );
  });
});
