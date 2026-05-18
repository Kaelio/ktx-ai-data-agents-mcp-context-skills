import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKtxConnectorCapabilities,
  type KtxConnectionDriver,
  type KtxScanConnector,
} from '@ktx/context/scan';
import { loadDuckDbNodeApi, type DuckDbNativeLoader } from './native.js';

export interface KtxDuckDbConnectionConfig {
  driver?: string;
  path?: string;
  url?: string;
  [key: string]: unknown;
}

export interface DuckDbDatabasePathInput {
  connectionId: string;
  projectDir?: string;
  connection: KtxDuckDbConnectionConfig | undefined;
}

export interface KtxDuckDbScanConnectorOptions extends DuckDbDatabasePathInput {
  now?: () => Date;
  nativeLoader?: DuckDbNativeLoader;
}

function resolveTilde(path: string): string {
  return path.startsWith('~') ? resolve(homedir(), path.slice(1)) : path;
}

function resolveStringReference(key: 'path' | 'url', value: string): string {
  if (value === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  if (value.startsWith('env:')) {
    return process.env[value.slice('env:'.length)] ?? '';
  }
  if (key === 'path' && value.startsWith('file:')) {
    return readFileSync(resolveTilde(value.slice('file:'.length)), 'utf-8').trim();
  }
  return value;
}

function duckDbPathFromUrl(url: string): string {
  if (url === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  if (url.startsWith('file:')) {
    return fileURLToPath(url);
  }
  return url;
}

function stringConfigValue(
  connection: KtxDuckDbConnectionConfig | undefined,
  key: 'path' | 'url',
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(key, value.trim()) : undefined;
}

export function isKtxDuckDbConnectionConfig(
  connection: KtxDuckDbConnectionConfig | undefined,
): connection is KtxDuckDbConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'duckdb';
}

export function duckDbDatabasePathFromConfig(input: DuckDbDatabasePathInput): string {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxDuckDbConnectionConfig(input.connection)) {
    throw new Error(`Native DuckDB connector cannot run driver "${inputDriver}"`);
  }
  const configuredPath =
    stringConfigValue(input.connection, 'path') ?? duckDbPathFromUrl(stringConfigValue(input.connection, 'url') ?? '');
  if (!configuredPath) {
    throw new Error(`connections.${input.connectionId}.path or url is required`);
  }
  if (configuredPath === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(input.projectDir ?? process.cwd(), configuredPath);
}

export function assertDuckDbDatabaseFile(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`File not found: ${dbPath}`);
  }
  const stats = statSync(dbPath);
  if (stats.isDirectory()) {
    throw new Error(`Expected a DuckDB database file, got directory: ${dbPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Expected a DuckDB database file, got non-file path: ${dbPath}`);
  }
}

export class KtxDuckDbScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'duckdb' as KtxConnectionDriver;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: false,
    formalForeignKeys: true,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly dbPath: string;
  private readonly nativeLoader: DuckDbNativeLoader;

  constructor(options: KtxDuckDbScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.dbPath = duckDbDatabasePathFromConfig(options);
    this.nativeLoader = options.nativeLoader ?? { load: loadDuckDbNodeApi };
    this.id = `duckdb:${options.connectionId}`;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      assertDuckDbDatabaseFile(this.dbPath);
      const { DuckDBInstance } = await this.nativeLoader.load();
      const instance = await DuckDBInstance.create(this.dbPath, { access_mode: 'READ_ONLY' });
      const connection = await instance.connect();
      try {
        await connection.runAndReadAll('SELECT 1');
        return { success: true };
      } finally {
        connection.disconnectSync();
        instance.closeSync();
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async introspect(): Promise<never> {
    throw new Error('DuckDB schema introspection is implemented in Task 2.');
  }

  async cleanup(): Promise<void> {}
}
