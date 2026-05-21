import { describe, expect, it } from 'vitest';
import { KtxSqliteDialect } from './dialect.js';

describe('KtxSqliteDialect', () => {
  const dialect = new KtxSqliteDialect();

  it('quotes identifiers and formats single-file SQLite table names', () => {
    expect(dialect.quoteIdentifier('orders')).toBe('"orders"');
    expect(dialect.quoteIdentifier('weird"name')).toBe('"weird""name"');
    expect(dialect.formatTableName({ catalog: 'ignored', db: 'ignored', name: 'orders' })).toBe('"orders"');
  });

  it('maps native SQLite types to KTX dimension types', () => {
    expect(dialect.mapToDimensionType('INTEGER')).toBe('number');
    expect(dialect.mapToDimensionType('numeric(10,2)')).toBe('number');
    expect(dialect.mapToDimensionType('timestamp')).toBe('time');
    expect(dialect.mapToDimensionType('VARCHAR(255)')).toBe('string');
    expect(dialect.mapToDimensionType('bool')).toBe('boolean');
    expect(dialect.mapToDimensionType('')).toBe('string');
  });

  it('builds sampling and distinct-value SQL without host-specific state', () => {
    expect(dialect.generateSampleQuery('"orders"', 25, ['id', 'status'])).toBe(
      'SELECT "id", "status" FROM "orders" LIMIT 25',
    );
    expect(dialect.generateColumnSampleQuery('"orders"', 'status', 10)).toBe(
      'SELECT "status" FROM "orders" WHERE "status" IS NOT NULL AND TRIM(CAST("status" AS TEXT)) != \'\' LIMIT 10',
    );
    expect(dialect.generateDistinctValuesQuery('"orders"', '"status"', 5)).toContain(
      'SELECT DISTINCT CAST("status" AS TEXT) AS val',
    );
  });
});
