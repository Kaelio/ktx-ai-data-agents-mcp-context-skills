export interface HistoricSqlRedactionPattern {
  pattern: string;
  expression: RegExp;
}

const CASE_INSENSITIVE_PREFIX = '(?i)';
const REDACTION_TOKEN = '[REDACTED]';

export function compileHistoricSqlRedactionPatterns(patterns: readonly string[]): HistoricSqlRedactionPattern[] {
  return patterns.map((pattern) => {
    const trimmed = pattern.trim();
    const caseInsensitive = trimmed.startsWith(CASE_INSENSITIVE_PREFIX);
    const source = caseInsensitive ? trimmed.slice(CASE_INSENSITIVE_PREFIX.length) : trimmed;
    if (source.length === 0) {
      throw new Error(`Invalid historicSql.redactionPatterns entry "${pattern}": pattern must not be empty`);
    }

    try {
      return {
        pattern,
        expression: new RegExp(source, caseInsensitive ? 'gi' : 'g'),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid historicSql.redactionPatterns entry "${pattern}": ${reason}`);
    }
  });
}

export function redactHistoricSqlText(text: string, redactors: readonly HistoricSqlRedactionPattern[]): string {
  let next = text;
  for (const redactor of redactors) {
    redactor.expression.lastIndex = 0;
    next = next.replace(redactor.expression, REDACTION_TOKEN);
  }
  return next;
}
