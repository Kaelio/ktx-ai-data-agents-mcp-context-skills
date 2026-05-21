const MUTATING_SQL =
  /^\s*(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh)\b/i;
const READ_SQL = /^\s*(select|with)\b/i;

export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim();
  if (!READ_SQL.test(trimmed) || MUTATING_SQL.test(trimmed)) {
    throw new Error('Only read-only SELECT/WITH queries can be executed locally.');
  }
  return trimmed;
}

export function limitSqlForExecution(sql: string, maxRows: number | undefined): string {
  const trimmed = assertReadOnlySql(sql).replace(/;+\s*$/, '');
  if (!maxRows) {
    return trimmed;
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new Error('maxRows must be a positive integer.');
  }
  return `select * from (${trimmed}) as ktx_query_result limit ${maxRows}`;
}
