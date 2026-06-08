import type { KtxProjectConnectionConfig } from '../../context/project/config.js';

export interface KtxSqlQueryExecutionInput {
  connectionId: string;
  projectDir?: string;
  connection: KtxProjectConnectionConfig | undefined;
  sql: string;
  maxRows?: number;
}

interface KtxSqlQueryExecutionResult {
  headers: string[];
  rows: unknown[][];
  totalRows: number;
  command: string;
  rowCount: number | null;
}

export interface KtxSqlQueryExecutorPort {
  execute(input: KtxSqlQueryExecutionInput): Promise<KtxSqlQueryExecutionResult>;
}

export function normalizeQueryRows(rows: unknown[]): unknown[][] {
  return rows.map((row) => (Array.isArray(row) ? row : Object.values(row as Record<string, unknown>)));
}
