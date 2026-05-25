import { describe, expect, it } from 'vitest';
import { assertSafeSnowflakeIdentifier, quoteSnowflakeIdentifier } from '../../../src/connectors/snowflake/identifiers.js';

describe('Snowflake identifier guards', () => {
  it('quotes simple Snowflake identifiers', () => {
    expect(quoteSnowflakeIdentifier('ANALYTICS_DB', 'database')).toBe('"ANALYTICS_DB"');
    expect(quoteSnowflakeIdentifier('ROLE_1$', 'role')).toBe('"ROLE_1$"');
  });

  it('rejects configured identifiers with field and value in the error', () => {
    expect(() => assertSafeSnowflakeIdentifier('bad.db', 'database')).toThrow(
      'Invalid Snowflake database identifier "bad.db"; use a simple unquoted identifier matching /^[A-Za-z_][A-Za-z0-9_$]*$/',
    );
    expect(() => assertSafeSnowflakeIdentifier('WH"DROP', 'warehouse')).toThrow(
      'Invalid Snowflake warehouse identifier "WH\\"DROP"; use a simple unquoted identifier matching /^[A-Za-z_][A-Za-z0-9_$]*$/',
    );
  });
});
