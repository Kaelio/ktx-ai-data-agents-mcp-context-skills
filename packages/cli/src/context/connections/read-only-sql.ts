const MUTATING_SQL =
  /^\s*(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh)\b/i;
const READ_SQL = /^\s*(select|with)\b/i;

// Agents (and the daemon's sqlglot validator, which ignores comments) routinely
// emit read-only queries prefixed with `-- ...` or `/* ... */`. Strip leading
// comments so the prefix check sees the real statement; otherwise valid SELECT/WITH
// SQL is rejected here while the parser-backed validator accepts it.
function stripLeadingSqlComments(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    while (/\s/.test(sql[index] ?? '')) {
      index += 1;
    }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) {
        return sql.slice(index);
      }
      index = end + 2;
      continue;
    }
    break;
  }
  return sql.slice(index);
}

export function assertReadOnlySql(sql: string): string {
  const trimmed = stripLeadingSqlComments(sql).trim();
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
