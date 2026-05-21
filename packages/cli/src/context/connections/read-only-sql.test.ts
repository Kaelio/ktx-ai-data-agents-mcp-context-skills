import { describe, expect, it } from 'vitest';
import { assertReadOnlySql, limitSqlForExecution } from './read-only-sql.js';

describe('assertReadOnlySql', () => {
  it('allows select and with queries', () => {
    expect(assertReadOnlySql('select * from orders')).toBe('select * from orders');
    expect(assertReadOnlySql('with paid as (select * from orders) select * from paid')).toContain('with paid');
  });

  it('rejects mutating statements before opening a database connection', () => {
    expect(() => assertReadOnlySql('delete from orders')).toThrow(
      'Only read-only SELECT/WITH queries can be executed locally',
    );
    expect(() => assertReadOnlySql('create table x(id int)')).toThrow(
      'Only read-only SELECT/WITH queries can be executed locally',
    );
  });
});

describe('limitSqlForExecution', () => {
  it('wraps compiled SQL and strips trailing semicolons', () => {
    expect(limitSqlForExecution('select * from public.orders; ', 25)).toBe(
      'select * from (select * from public.orders) as ktx_query_result limit 25',
    );
  });

  it('returns the trimmed SQL when no maxRows value is provided', () => {
    expect(limitSqlForExecution('select * from orders; ', undefined)).toBe('select * from orders');
  });
});
