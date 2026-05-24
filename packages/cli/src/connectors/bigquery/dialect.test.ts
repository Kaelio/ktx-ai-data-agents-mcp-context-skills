import { describe, expect, it } from 'vitest';
import { KtxBigQueryDialect } from './dialect.js';

describe('KtxBigQueryDialect', () => {
  const dialect = new KtxBigQueryDialect();

  it('quotes identifiers and formats project.dataset.table names', () => {
    expect(dialect.quoteIdentifier('order`items')).toBe('`order\\`items`');
    expect(dialect.formatTableName({ catalog: 'project-1', db: 'analytics', name: 'orders' })).toBe(
      '`project-1`.`analytics`.`orders`',
    );
    expect(dialect.formatTableName({ db: 'analytics', name: 'orders' })).toBe('`analytics`.`orders`');
    expect(dialect.formatTableName({ name: 'orders' })).toBe('`orders`');
  });

  it('maps native BigQuery types to normalized types and scan dimensions', () => {
    expect(dialect.mapDataType('INT64')).toBe('BIGINT');
    expect(dialect.mapDataType('STRUCT')).toBe('JSON');
    expect(dialect.mapDataType('GEOGRAPHY')).toBe('GEOGRAPHY');
    expect(dialect.mapToDimensionType('TIMESTAMP')).toBe('time');
    expect(dialect.mapToDimensionType('NUMERIC')).toBe('number');
    expect(dialect.mapToDimensionType('BOOL')).toBe('boolean');
    expect(dialect.mapToDimensionType('JSON')).toBe('string');
  });

  it('generates sampling, cardinality, and distinct-value SQL', () => {
    expect(dialect.generateSampleQuery('`p`.`d`.`orders`', 5, ['id', 'status'])).toBe(
      'SELECT `id`, `status` FROM `p`.`d`.`orders` ORDER BY RAND() LIMIT 5',
    );
    expect(dialect.generateColumnSampleQuery('`p`.`d`.`orders`', 'status', 10)).toBe(
      "SELECT `status` FROM `p`.`d`.`orders` WHERE `status` IS NOT NULL AND TRIM(CAST(`status` AS STRING)) != '' ORDER BY RAND() LIMIT 10",
    );
    expect(dialect.generateCardinalitySampleQuery('`p`.`d`.`orders`', '`status`', 100)).toContain(
      'SELECT APPROX_COUNT_DISTINCT(val) AS cardinality',
    );
    expect(dialect.generateDistinctValuesQuery('`p`.`d`.`orders`', '`status`', 20)).toContain(
      'SELECT DISTINCT CAST(`status` AS STRING) AS val',
    );
  });

  it('keeps unsupported statistics explicit', () => {
    expect(dialect.generateColumnStatisticsQuery('analytics', 'orders')).toBeNull();
  });
});
