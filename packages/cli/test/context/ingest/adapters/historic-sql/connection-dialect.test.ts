import { describe, expect, it } from 'vitest';
import {
  historicSqlDialectForConnectionDriver,
  queryHistoryDialectForConnection,
} from '../../../../../src/context/ingest/adapters/historic-sql/connection-dialect.js';

describe('queryHistoryDialectForConnection', () => {
  it.each([
    ['postgres', 'postgres'],
    ['bigquery', 'bigquery'],
    ['snowflake', 'snowflake'],
  ] as const)('returns %s when query history is enabled', (driver, dialect) => {
    expect(queryHistoryDialectForConnection({ driver, context: { queryHistory: { enabled: true } } })).toBe(dialect);
  });

  it.each(['sqlite', 'mysql', 'clickhouse', 'sqlserver'] as const)(
    'returns null for %s because no historic-SQL reader is registered',
    (driver) => {
      expect(queryHistoryDialectForConnection({ driver, context: { queryHistory: { enabled: true } } })).toBeNull();
    },
  );

  it('returns null when query history is disabled', () => {
    expect(queryHistoryDialectForConnection({ driver: 'postgres', context: { queryHistory: { enabled: false } } })).toBeNull();
  });
});

describe('historicSqlDialectForConnectionDriver', () => {
  it('resolves the dialect from driver capability even when query history is disabled', () => {
    expect(
      historicSqlDialectForConnectionDriver({ driver: 'postgres', context: { queryHistory: { enabled: false } } }),
    ).toBe('postgres');
  });

  it('resolves the dialect when no query-history context is present', () => {
    expect(historicSqlDialectForConnectionDriver({ driver: 'bigquery' })).toBe('bigquery');
  });

  it('returns null for drivers without a historic-SQL reader', () => {
    expect(historicSqlDialectForConnectionDriver({ driver: 'mysql', context: { queryHistory: { enabled: true } } })).toBeNull();
  });
});
