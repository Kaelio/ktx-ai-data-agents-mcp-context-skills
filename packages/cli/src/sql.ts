import { loadKtxProject, type KtxLocalProject } from '@ktx/context/project';
import type { KtxQueryResult, KtxScanConnector } from '@ktx/context/scan';
import type { SqlAnalysisDialect, SqlAnalysisPort } from '@ktx/context/sql-analysis';
import type { KtxCliIo } from './cli-runtime.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { createManagedDaemonSqlAnalysisPort } from './managed-python-http.js';
import { profileMark } from './startup-profile.js';

profileMark('module:sql');

type KtxSqlOutputMode = 'pretty' | 'plain' | 'json';

export type KtxSqlArgs = {
  command: 'execute';
  projectDir: string;
  connectionId: string;
  sql: string;
  maxRows: number;
  output?: KtxSqlOutputMode;
  json?: boolean;
  cliVersion: string;
};

export interface KtxSqlDeps {
  loadProject?: typeof loadKtxProject;
  createSqlAnalysis?: () => SqlAnalysisPort;
  createScanConnector?: typeof createKtxCliScanConnector;
}

interface SqlExecutionOutput {
  connectionId: string;
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  rowCount: number;
}

function sqlAnalysisDialectForDriver(driver: string | undefined): SqlAnalysisDialect {
  const normalized = String(driver ?? '').trim().toLowerCase();
  const map: Record<string, SqlAnalysisDialect> = {
    postgres: 'postgres',
    postgresql: 'postgres',
    bigquery: 'bigquery',
    snowflake: 'snowflake',
    mysql: 'mysql',
    sqlserver: 'tsql',
    mssql: 'tsql',
    sqlite: 'sqlite',
    sqlite3: 'sqlite',
    clickhouse: 'clickhouse',
    redshift: 'redshift',
  };
  return map[normalized] ?? 'postgres';
}

function resolveOutputMode(args: KtxSqlArgs): KtxSqlOutputMode {
  if (args.json === true) return 'json';
  return args.output ?? 'pretty';
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

function printJson(output: SqlExecutionOutput, io: KtxCliIo): void {
  io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function printPlain(output: SqlExecutionOutput, io: KtxCliIo): void {
  io.stdout.write(`${output.headers.join('\t')}\n`);
  for (const row of output.rows) {
    io.stdout.write(`${row.map(formatValue).join('\t')}\n`);
  }
}

function printPretty(output: SqlExecutionOutput, io: KtxCliIo): void {
  const rows = output.rows.map((row) => row.map(formatValue));
  const widths = output.headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ').trimEnd();

  if (output.headers.length > 0) {
    io.stdout.write(`${renderRow(output.headers)}\n`);
    io.stdout.write(`${renderRow(widths.map((width) => '-'.repeat(width)))}\n`);
  }
  for (const row of rows) {
    io.stdout.write(`${renderRow(row)}\n`);
  }
  io.stdout.write(`\n${output.rowCount} ${output.rowCount === 1 ? 'row' : 'rows'}\n`);
}

function printSqlResult(output: SqlExecutionOutput, mode: KtxSqlOutputMode, io: KtxCliIo): void {
  if (mode === 'json') {
    printJson(output, io);
    return;
  }
  if (mode === 'plain') {
    printPlain(output, io);
    return;
  }
  printPretty(output, io);
}

async function cleanupConnector(connector: KtxScanConnector | null): Promise<void> {
  if (connector?.cleanup) {
    await connector.cleanup();
  }
}

function resultOutput(connectionId: string, result: KtxQueryResult): SqlExecutionOutput {
  return {
    connectionId,
    headers: result.headers,
    ...(result.headerTypes ? { headerTypes: result.headerTypes } : {}),
    rows: result.rows,
    rowCount: result.rowCount ?? result.rows.length,
  };
}

export async function runKtxSql(args: KtxSqlArgs, io: KtxCliIo = process, deps: KtxSqlDeps = {}): Promise<number> {
  try {
    const project = await (deps.loadProject ?? loadKtxProject)({ projectDir: args.projectDir });
    const connection = project.config.connections[args.connectionId];
    if (!connection) {
      throw new Error(`Connection "${args.connectionId}" is not configured in ktx.yaml`);
    }

    const sqlAnalysis =
      deps.createSqlAnalysis ??
      (() =>
        createManagedDaemonSqlAnalysisPort({
          cliVersion: args.cliVersion,
          projectDir: args.projectDir,
          installPolicy: 'auto',
          io,
        }));
    const validation = await sqlAnalysis().validateReadOnly(args.sql, sqlAnalysisDialectForDriver(connection.driver));
    if (!validation.ok) {
      throw new Error(validation.error ?? 'SQL is not read-only.');
    }

    const createScanConnector = deps.createScanConnector ?? createKtxCliScanConnector;
    let connector: KtxScanConnector | null = null;
    try {
      connector = await createScanConnector(project as KtxLocalProject, args.connectionId);
      if (!connector.capabilities.readOnlySql || !connector.executeReadOnly) {
        throw new Error(`Connection "${args.connectionId}" does not support read-only SQL execution.`);
      }
      const result = await connector.executeReadOnly(
        {
          connectionId: args.connectionId,
          sql: args.sql,
          maxRows: args.maxRows,
        },
        { runId: 'cli-sql' },
      );
      printSqlResult(resultOutput(args.connectionId, result), resolveOutputMode(args), io);
      return 0;
    } finally {
      await cleanupConnector(connector);
    }
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
