import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type {
  KtxSqlQueryExecutionInput,
  KtxSqlQueryExecutionResult,
  KtxSqlQueryExecutorPort,
} from './query-executor.js';
import { normalizeQueryRows } from './query-executor.js';
import { limitSqlForExecution } from './read-only-sql.js';

type SqliteConnectionConfig = Record<string, unknown> | undefined;

function connectionDriver(input: KtxSqlQueryExecutionInput): string {
  return String(input.connection?.driver ?? '').toLowerCase();
}

function stringConfigValue(connection: SqliteConnectionConfig, key: string): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(key, value.trim()) : undefined;
}

function resolveStringReference(key: string, value: string): string {
  if (value.startsWith('env:')) {
    return process.env[value.slice('env:'.length)] ?? '';
  }
  if (key !== 'url' && value.startsWith('file:')) {
    const rawPath = value.slice('file:'.length);
    const path = rawPath.startsWith('~') ? resolve(homedir(), rawPath.slice(1)) : rawPath;
    return readFileSync(path, 'utf-8').trim();
  }
  return value;
}

function sqlitePathFromUrl(url: string): string {
  if (url.startsWith('file:')) {
    return fileURLToPath(url);
  }

  if (url.startsWith('sqlite:')) {
    const parsed = new URL(url);
    if (parsed.pathname.length > 0) {
      return decodeURIComponent(parsed.pathname);
    }
  }

  return url;
}

/** @internal */
export function sqliteDatabasePathFromConnection(input: KtxSqlQueryExecutionInput): string {
  const driver = connectionDriver(input);
  if (driver !== 'sqlite' && driver !== 'sqlite3') {
    throw new Error(`Local SQLite execution cannot run driver "${input.connection?.driver ?? 'unknown'}".`);
  }

  const pathValue = stringConfigValue(input.connection, 'path');
  const urlValue = stringConfigValue(input.connection, 'url');
  if (!pathValue && !urlValue) {
    throw new Error(
      `Local SQLite execution requires connections.${input.connectionId}.path or connections.${input.connectionId}.url.`,
    );
  }

  const candidate = pathValue ?? sqlitePathFromUrl(urlValue as string);
  return isAbsolute(candidate) ? candidate : resolve(input.projectDir ?? process.cwd(), candidate);
}

export function createSqliteQueryExecutor(): KtxSqlQueryExecutorPort {
  return {
    async execute(input: KtxSqlQueryExecutionInput): Promise<KtxSqlQueryExecutionResult> {
      const sql = limitSqlForExecution(input.sql, input.maxRows);
      const dbPath = sqliteDatabasePathFromConnection(input);
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const statement = db.prepare(sql);
        const rows = statement.all() as unknown[];
        return {
          headers: statement.columns().map((column) => column.name),
          rows: normalizeQueryRows(rows),
          totalRows: rows.length,
          command: 'SELECT',
          rowCount: rows.length,
        };
      } finally {
        db.close();
      }
    },
  };
}
