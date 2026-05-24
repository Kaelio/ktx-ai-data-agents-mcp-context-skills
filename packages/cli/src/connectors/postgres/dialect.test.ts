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

});
