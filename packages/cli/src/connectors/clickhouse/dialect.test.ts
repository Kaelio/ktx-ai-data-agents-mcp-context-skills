import { describe, expect, it } from 'vitest';
import { KtxClickHouseDialect } from './dialect.js';

describe('KtxClickHouseDialect', () => {
  const dialect = new KtxClickHouseDialect();

  it('quotes identifiers and formats database-qualified table names', () => {
    expect(dialect.quoteIdentifier('events')).toBe('`events`');
    expect(dialect.quoteIdentifier('odd`name')).toBe('`odd``name`');
    expect(dialect.formatTableName({ catalog: null, db: 'analytics', name: 'events' })).toBe(
      '`analytics`.`events`',
    );
    expect(dialect.formatTableName({ catalog: null, db: null, name: 'events' })).toBe('`events`');
  });

  it('maps nullable and low-cardinality ClickHouse types to KTX dimension types', () => {
    expect(dialect.mapToDimensionType('Nullable(DateTime64(3))')).toBe('time');
    expect(dialect.mapToDimensionType('LowCardinality(Nullable(String))')).toBe('string');
    expect(dialect.mapToDimensionType('UInt64')).toBe('number');
    expect(dialect.mapToDimensionType('Decimal(18, 4)')).toBe('number');
    expect(dialect.mapToDimensionType('Bool')).toBe('boolean');
    expect(dialect.mapToDimensionType('IPv4')).toBe('string');
    expect(dialect.mapToDimensionType('')).toBe('string');
  });

  it('builds sampling, distinct-value, and pagination SQL', () => {
    expect(dialect.generateSampleQuery('`analytics`.`events`', 25, ['id', 'event_name'])).toBe(
      'SELECT `id`, `event_name` FROM `analytics`.`events` LIMIT 25',
    );
    expect(dialect.generateColumnSampleQuery('`analytics`.`events`', 'event_name', 10)).toBe(
      "SELECT `event_name` FROM `analytics`.`events` WHERE `event_name` IS NOT NULL AND trim(toString(`event_name`)) != '' LIMIT 10",
    );
    expect(dialect.generateDistinctValuesQuery('`analytics`.`events`', '`event_name`', 5)).toContain(
      'SELECT DISTINCT toString(`event_name`) AS val',
    );
    expect(dialect.getLimitOffsetClause(10, 20)).toBe('LIMIT 10 OFFSET 20');
  });

  it('prepares named parameters using ClickHouse typed placeholders', () => {
    expect(dialect.prepareQuery('select * from events where id = :id and event_name = :name', {
      id: 10,
      name: 'signup',
    })).toEqual({
      sql: 'select * from events where id = {id:Int64} and event_name = {name:String}',
      params: { id: 10, name: 'signup' },
    });
  });
});
