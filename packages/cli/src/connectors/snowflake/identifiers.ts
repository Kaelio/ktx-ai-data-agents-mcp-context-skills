const SNOWFLAKE_SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function assertSafeSnowflakeIdentifier(value: string, field: string): string {
  if (!SNOWFLAKE_SIMPLE_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid Snowflake ${field} identifier ${JSON.stringify(value)}; use a simple unquoted identifier matching ${SNOWFLAKE_SIMPLE_IDENTIFIER}`,
    );
  }
  return value;
}

export function quoteSnowflakeIdentifier(value: string, field: string): string {
  return `"${assertSafeSnowflakeIdentifier(value, field)}"`;
}
