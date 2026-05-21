import { describe, expect, it } from 'vitest';
import { KtxSnowflakeDialect } from './dialect.js';

describe('KtxSnowflakeDialect', () => {
  const dialect = new KtxSnowflakeDialect();

  it('quotes identifiers and formats database.schema.table names', () => {
    expect(dialect.quoteIdentifier('order"items')).toBe('"order""items"');
    expect(dialect.formatTableName({ catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' })).toBe(
      '"ANALYTICS"."PUBLIC"."ORDERS"',
    );
    expect(dialect.formatTableName({ db: 'PUBLIC', name: 'ORDERS' })).toBe('"PUBLIC"."ORDERS"');
    expect(dialect.formatTableName({ name: 'ORDERS' })).toBe('"ORDERS"');
  });

  it('maps native Snowflake types to scan dimensions', () => {
    expect(dialect.mapDataType('NUMBER(38,0)')).toBe('NUMBER(38,0)');
    expect(dialect.mapToDimensionType('TIMESTAMP_NTZ')).toBe('time');
    expect(dialect.mapToDimensionType('NUMBER(38,0)')).toBe('number');
    expect(dialect.mapToDimensionType('BOOLEAN')).toBe('boolean');
    expect(dialect.mapToDimensionType('VARIANT')).toBe('string');
  });

  it('generates sampling and dictionary SQL', () => {
    expect(dialect.generateSampleQuery('"PUBLIC"."ORDERS"', 5, ['ID', 'STATUS'])).toBe(
      'SELECT "ID", "STATUS" FROM "PUBLIC"."ORDERS" SAMPLE ROW (5 ROWS)',
    );
    expect(dialect.generateColumnSampleQuery('"PUBLIC"."ORDERS"', 'STATUS', 10)).toBe(
      'SELECT "STATUS" FROM "PUBLIC"."ORDERS" WHERE "STATUS" IS NOT NULL AND TRIM(CAST("STATUS" AS STRING)) != \'\' LIMIT 10',
    );
    expect(dialect.generateCardinalitySampleQuery('"PUBLIC"."ORDERS"', '"STATUS"', 100)).toContain(
      'SELECT COUNT(DISTINCT val) AS cardinality',
    );
    expect(dialect.generateDistinctValuesQuery('"PUBLIC"."ORDERS"', '"STATUS"', 20)).toContain(
      'SELECT DISTINCT "STATUS"::VARCHAR AS val',
    );
  });

  it('passes Snowflake positional parameters as bind arrays', () => {
    expect(dialect.prepareQuery('SELECT * FROM ORDERS WHERE ID = ? AND STATUS = ?', { id: 1, status: 'paid' })).toEqual({
      sql: 'SELECT * FROM ORDERS WHERE ID = ? AND STATUS = ?',
      params: [1, 'paid'],
    });
    expect(dialect.prepareQuery('SELECT * FROM ORDERS')).toEqual({ sql: 'SELECT * FROM ORDERS', params: undefined });
  });

  it('keeps unsupported statistics explicit', () => {
    expect(dialect.generateColumnStatisticsQuery('PUBLIC', 'ORDERS')).toBeNull();
  });
});
