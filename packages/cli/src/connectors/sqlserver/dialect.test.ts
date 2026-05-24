import { describe, expect, it } from 'vitest';
import { KtxSqlServerDialect } from './dialect.js';

describe('KtxSqlServerDialect', () => {
  const dialect = new KtxSqlServerDialect();

  it('quotes identifiers and formats schema-qualified table names', () => {
    expect(dialect.quoteIdentifier('events')).toBe('[events]');
    expect(dialect.quoteIdentifier('odd]name')).toBe('[odd]]name]');
    expect(dialect.formatTableName({ catalog: 'warehouse', db: 'dbo', name: 'events' })).toBe(
      '[warehouse].[dbo].[events]',
    );
    expect(dialect.formatTableName({ catalog: null, db: null, name: 'events' })).toBe('[events]');
  });

  it('maps SQL Server types to KTX dimension types', () => {
    expect(dialect.mapToDimensionType('datetime2')).toBe('time');
    expect(dialect.mapToDimensionType('decimal(18, 2)')).toBe('number');
    expect(dialect.mapToDimensionType('bigint')).toBe('number');
    expect(dialect.mapToDimensionType('bit')).toBe('boolean');
    expect(dialect.mapToDimensionType('uniqueidentifier')).toBe('string');
    expect(dialect.mapToDimensionType('')).toBe('string');
  });

  it('builds sampling, distinct-value, and pagination SQL', () => {
    expect(dialect.generateSampleQuery('[dbo].[events]', 25, ['id', 'event_name'])).toBe(
      'SELECT TOP 25 [id], [event_name] FROM [dbo].[events]',
    );
    expect(dialect.generateColumnSampleQuery('[dbo].[events]', 'event_name', 10)).toBe(
      "SELECT TOP 10 [event_name] FROM [dbo].[events] WHERE [event_name] IS NOT NULL AND LTRIM(RTRIM(CAST([event_name] AS NVARCHAR(MAX)))) != ''",
    );
    expect(dialect.generateDistinctValuesQuery('[dbo].[events]', '[event_name]', 5)).toContain('SELECT TOP 5 val');
    expect(dialect.getTopClause(10)).toBe('TOP (10)');
    expect(dialect.getLimitOffsetClause(10, 20)).toBe('');
  });

  it('prepares named parameters using SQL Server @ parameters', () => {
    expect(
      dialect.prepareQuery('select * from events where id = :id and name = :name', {
        id: 10,
        name: 'signup',
      }),
    ).toEqual({
      sql: 'select * from events where id = @id and name = @name',
      params: { id: 10, name: 'signup' },
    });
  });
});
