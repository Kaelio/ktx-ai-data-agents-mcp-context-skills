import { describe, expect, it } from 'vitest';
import { KtxMysqlDialect } from '../../../src/connectors/mysql/dialect.js';

describe('KtxMysqlDialect', () => {
  const dialect = new KtxMysqlDialect();

  it('quotes identifiers and formats database-qualified table names', () => {
    expect(dialect.quoteIdentifier('orders')).toBe('`orders`');
    expect(dialect.quoteIdentifier('odd`name')).toBe('`odd``name`');
    expect(dialect.formatTableName({ catalog: null, db: 'analytics', name: 'orders' })).toBe(
      '`analytics`.`orders`',
    );
    expect(dialect.formatTableName({ catalog: null, db: null, name: 'orders' })).toBe('`orders`');
  });

  it('maps native MySQL types to KTX dimension types', () => {
    expect(dialect.mapToDimensionType('tinyint(1)')).toBe('boolean');
    expect(dialect.mapToDimensionType('int')).toBe('number');
    expect(dialect.mapToDimensionType('decimal(10,2)')).toBe('number');
    expect(dialect.mapToDimensionType('timestamp')).toBe('time');
    expect(dialect.mapToDimensionType('varchar(255)')).toBe('string');
    expect(dialect.mapToDimensionType('json')).toBe('string');
    expect(dialect.mapToDimensionType('')).toBe('string');
  });

  it('builds sampling, distinct-value, and pagination SQL', () => {
    expect(dialect.generateSampleQuery('`analytics`.`orders`', 25, ['id', 'status'])).toBe(
      'SELECT `id`, `status` FROM `analytics`.`orders` LIMIT 25',
    );
    expect(dialect.generateColumnSampleQuery('`analytics`.`orders`', 'status', 10)).toBe(
      "SELECT `status` FROM `analytics`.`orders` WHERE `status` IS NOT NULL AND TRIM(CAST(`status` AS CHAR)) != '' LIMIT 10",
    );
    expect(dialect.generateDistinctValuesQuery('`analytics`.`orders`', '`status`', 5)).toContain(
      'SELECT DISTINCT CAST(`status` AS CHAR) AS val',
    );
    expect(dialect.getLimitOffsetClause(10, 20)).toBe('LIMIT 10 OFFSET 20');
  });


  it('generates column statistics query using INFORMATION_SCHEMA.STATISTICS', () => {
    const sql = dialect.generateColumnStatisticsQuery('analytics', 'orders');
    expect(sql).not.toBeNull();
    expect(sql).toContain('INFORMATION_SCHEMA.STATISTICS');
    expect(sql).toContain("TABLE_SCHEMA = 'analytics'");
    expect(sql).toContain("TABLE_NAME = 'orders'");
    expect(sql).toContain('CARDINALITY IS NOT NULL');
    expect(sql).toContain('column_name');
    expect(sql).toContain('estimated_cardinality');
  });

  it('filters to leading index columns only (SEQ_IN_INDEX = 1) to avoid inflated cardinality from composite indexes', () => {
    const sql = dialect.generateColumnStatisticsQuery('analytics', 'orders');
    expect(sql).toContain('SEQ_IN_INDEX = 1');
  });

  it('escapes single quotes in schema and table names for statistics query', () => {
    const sql = dialect.generateColumnStatisticsQuery("andy's_db", "o'rders");
    expect(sql).toContain("TABLE_SCHEMA = 'andy''s_db'");
    expect(sql).toContain("TABLE_NAME = 'o''rders'");
  });
});
