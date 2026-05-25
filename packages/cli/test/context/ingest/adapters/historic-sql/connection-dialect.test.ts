import { describe, expect, it } from 'vitest';
import { queryHistoryDialectForConnection } from '../../../../../src/context/ingest/adapters/historic-sql/connection-dialect.js';

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
