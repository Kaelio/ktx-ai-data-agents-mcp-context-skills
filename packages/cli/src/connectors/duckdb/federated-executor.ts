import { DuckDBInstance } from '@duckdb/node-api';
import { resolveStringReference } from '../shared/string-reference.js';
import type {
  KtxSqlQueryExecutionInput,
  KtxSqlQueryExecutionResult,
} from '../../context/connections/query-executor.js';
import { normalizeQueryRows } from '../../context/connections/query-executor.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import type { FederatedMember } from '../../context/connections/federation.js';

const ATTACH_TYPE_BY_DRIVER: Record<string, string> = {
  postgres: 'postgres',
  mysql: 'mysql',
  sqlite: 'sqlite',
};

export function attachTypeForDriver(driver: string): string {
  const type = ATTACH_TYPE_BY_DRIVER[driver.toLowerCase()];
  if (!type) {
    throw new Error(`Driver "${driver}" cannot be attached by DuckDB federation.`);
  }
  return type;
}

function memberUrl(member: FederatedMember, env: NodeJS.ProcessEnv): string {
  const raw = (member.config as { url?: unknown }).url;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`Federated member "${member.connectionId}" has no url in ktx.yaml.`);
  }
  return resolveStringReference(raw, env);
}

/**
 * Builds INSTALL/LOAD + READ_ONLY ATTACH statements, one member per DuckDB
 * catalog aliased by its connectionId. READ_ONLY makes the attach physically
 * non-writable; assertReadOnlySql guards the query text itself.
 */
export function buildAttachStatements(members: FederatedMember[], env: NodeJS.ProcessEnv): string[] {
  const statements: string[] = [];
  for (const member of members) {
    const type = attachTypeForDriver(member.driver);
    const url = memberUrl(member, env);
    const safeUrl = url.replaceAll("'", "''");
    statements.push(`INSTALL ${type}; LOAD ${type};`);
    statements.push(`ATTACH '${safeUrl}' AS ${member.connectionId} (TYPE ${type}, READ_ONLY);`);
  }
  return statements;
}

export async function executeFederatedQuery(
  members: FederatedMember[],
  input: KtxSqlQueryExecutionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KtxSqlQueryExecutionResult> {
  const sql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
  const attachStatements = buildAttachStatements(members, env);

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    for (const statement of attachStatements) {
      await connection.run(statement);
    }
    const reader = await connection.runAndReadAll(sql);
    const rows = normalizeQueryRows(reader.getRows());
    const headers = reader.columnNames();
    return {
      headers,
      rows,
      totalRows: rows.length,
      command: 'SELECT',
      rowCount: rows.length,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
