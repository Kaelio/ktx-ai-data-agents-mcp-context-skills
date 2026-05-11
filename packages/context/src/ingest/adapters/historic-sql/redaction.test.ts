import { describe, expect, it } from 'vitest';
import { compileHistoricSqlRedactionPatterns, redactHistoricSqlText } from './redaction.js';

describe('historic-SQL redaction', () => {
  it('redacts regex matches and supports the (?i) case-insensitive prefix', () => {
    const redactors = compileHistoricSqlRedactionPatterns([
      'sk_live_[A-Za-z0-9]+',
      '(?i)secret_token_[a-z0-9]+',
    ]);

    const sql =
      "select * from public.api_events where api_key = 'sk_live_abc123' and note = 'Secret_Token_9f'";

    expect(redactHistoricSqlText(sql, redactors)).toBe(
      "select * from public.api_events where api_key = '[REDACTED]' and note = '[REDACTED]'",
    );
  });

  it('returns the original SQL text when no redaction patterns are configured', () => {
    const sql = "select * from public.orders where status = 'paid'";

    expect(redactHistoricSqlText(sql, compileHistoricSqlRedactionPatterns([]))).toBe(sql);
  });

  it('throws a config-focused error for invalid redaction regex patterns', () => {
    expect(() => compileHistoricSqlRedactionPatterns(['[broken'])).toThrow(
      'Invalid historicSql.redactionPatterns entry "[broken"',
    );
  });

  it('throws a config-focused error for empty redaction regex patterns', () => {
    expect(() => compileHistoricSqlRedactionPatterns(['   '])).toThrow(
      'Invalid historicSql.redactionPatterns entry "   "',
    );
  });
});
