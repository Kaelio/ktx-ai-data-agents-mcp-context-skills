import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  duckDbDatabasePathFromConfig,
  isKtxDuckDbConnectionConfig,
  KtxDuckDbScanConnector,
} from './connector.js';

describe('DuckDB connection config and path resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-duckdb-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.KTX_DUCKDB_FIXTURE;
  });

  it('recognizes duckdb configs', () => {
    expect(isKtxDuckDbConnectionConfig({ driver: 'duckdb', path: 'warehouse.duckdb' })).toBe(true);
    expect(isKtxDuckDbConnectionConfig({ driver: 'sqlite', path: 'warehouse.duckdb' })).toBe(false);
  });

  it('resolves project-relative path, env refs, file refs, and file URLs', async () => {
    const dbPath = join(tempDir, 'warehouse.duckdb');
    const pathRefFile = join(tempDir, 'warehouse-path.txt');
    await writeFile(dbPath, '', 'utf-8');
    await writeFile(pathRefFile, dbPath, 'utf-8');
    process.env.KTX_DUCKDB_FIXTURE = dbPath;

    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: 'warehouse.duckdb' },
      }),
    ).toBe(resolve(tempDir, 'warehouse.duckdb'));
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: 'env:KTX_DUCKDB_FIXTURE' },
      }),
    ).toBe(dbPath);
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: `file:${pathRefFile}` },
      }),
    ).toBe(dbPath);
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', url: pathToFileURL(dbPath).href },
      }),
    ).toBe(dbPath);
  });

  it('rejects in-memory, missing, and directory targets before opening DuckDB', async () => {
    await mkdir(join(tempDir, 'directory.duckdb'));
    expect(() =>
      new KtxDuckDbScanConnector({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: ':memory:' },
      }),
    ).toThrow('DuckDB in-memory connections are not supported');

    const missing = join(tempDir, 'missing.duckdb');
    const missingConnector = new KtxDuckDbScanConnector({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'duckdb', path: missing },
    });
    await expect(missingConnector.testConnection()).resolves.toEqual({
      success: false,
      error: `File not found: ${missing}`,
    });
    await expect(stat(missing)).rejects.toThrow();

    const directory = join(tempDir, 'directory.duckdb');
    const directoryConnector = new KtxDuckDbScanConnector({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'duckdb', path: directory },
    });
    await expect(directoryConnector.testConnection()).resolves.toEqual({
      success: false,
      error: `Expected a DuckDB database file, got directory: ${directory}`,
    });

    await expect(readFile(directory)).rejects.toThrow();
  });
});
