import { describe, expect, it } from 'vitest';
import { KtxMysqlDialect } from './dialect.js';

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

  it('builds sampling, distinct-value, pagination, and time SQL', () => {
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
    expect(dialect.getTimeTruncExpression('created_at', 'month')).toBe("DATE_FORMAT(created_at, '%Y-%m-01')");
  });

  it('prepares named parameters in deterministic SQL placeholder order', () => {
    expect(dialect.prepareQuery('select * from orders where id = :id and status = :status', {
      status: 'paid',
      id: 10,
    })).toEqual({
      sql: 'select * from orders where id = ? and status = ?',
      params: [10, 'paid'],
    });
  });
});
