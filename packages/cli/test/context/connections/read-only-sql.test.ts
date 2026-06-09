import { describe, expect, it } from 'vitest';
import { assertReadOnlySql, limitSqlForExecution } from '../../../src/context/connections/read-only-sql.js';

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

  it('accepts read-only queries that begin with leading comments', () => {
    expect(assertReadOnlySql('-- signups per day\nselect count(*) from public.signed_up')).toBe(
      'select count(*) from public.signed_up',
    );
    expect(assertReadOnlySql('/* block */\n  with paid as (select 1) select * from paid')).toContain('with paid');
  });

  it('still rejects mutating statements hidden behind leading comments', () => {
    expect(() => assertReadOnlySql('-- harmless\n  delete from orders')).toThrow(
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

  it('strips leading comments before wrapping with a row limit', () => {
    expect(limitSqlForExecution('-- top customers\nselect * from public.orders', 25)).toBe(
      'select * from (select * from public.orders) as ktx_query_result limit 25',
    );
  });
});
