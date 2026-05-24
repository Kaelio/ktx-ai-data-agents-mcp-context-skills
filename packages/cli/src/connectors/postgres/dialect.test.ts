import { describe, expect, it } from 'vitest';
import { KtxPostgresDialect } from './dialect.js';

describe('KtxPostgresDialect', () => {
  const dialect = new KtxPostgresDialect();

  it('quotes identifiers and formats schema-qualified tables', () => {
    expect(dialect.quoteIdentifier('order"items')).toBe('"order""items"');
    expect(dialect.formatTableName({ catalog: null, db: 'public', name: 'orders' })).toBe('"public"."orders"');
    expect(dialect.formatTableName({ catalog: null, db: null, name: 'orders' })).toBe('"orders"');
  });

  it('maps native PostgreSQL types to KTX dimension types', () => {
    expect(dialect.mapToDimensionType('timestamp with time zone')).toBe('time');
    expect(dialect.mapToDimensionType('numeric(12,2)')).toBe('number');
    expect(dialect.mapToDimensionType('uuid')).toBe('string');
    expect(dialect.mapToDimensionType('boolean')).toBe('boolean');
    expect(dialect.mapToDimensionType('jsonb')).toBe('string');
  });

  it('generates sample, distinct-value, and statistics SQL', () => {
    expect(dialect.generateSampleQuery('"public"."orders"', 5, ['id', 'status'])).toBe(
      'SELECT "id", "status" FROM "public"."orders" LIMIT 5',
    );
    expect(dialect.generateColumnSampleQuery('"public"."orders"', 'status', 10)).toContain(
      'TRIM(CAST("status" AS TEXT)) != \'\'',
    );
    expect(dialect.generateDistinctValuesQuery('"public"."orders"', '"status"', 20)).toContain(
      'SELECT DISTINCT "status"::text AS val',
    );
    expect(dialect.generateColumnStatisticsQuery('public', 'orders')).toContain('FROM pg_stats s');
  });

  it('prepares named parameters with PostgreSQL positional parameters', () => {
    expect(
      dialect.prepareQuery('select * from orders where id = :id and status = :status', { id: 1, status: 'paid' }),
    ).toEqual({
      sql: 'select * from orders where id = $1 and status = $2',
      params: [1, 'paid'],
    });
    expect(
      dialect.prepareQuery('select :Client_Name_10, :Client_Name_1', {
        Client_Name_1: 'short',
        Client_Name_10: 'long',
      }),
    ).toEqual({
      sql: 'select $2, $1',
      params: ['short', 'long'],
    });
  });
});
