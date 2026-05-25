import { describe, expect, it, vi } from 'vitest';
import {
  createManagedDaemonHttpJsonRunner,
  createManagedDaemonLookerTableIdentifierParser,
  createManagedDaemonSqlAnalysisPort,
  createManagedPythonDaemonBaseUrlResolver,
  managedDaemonDatabaseIntrospectionOptions,
} from '../src/managed-python-http.js';

function io() {
  let stderr = '';
  return {
    io: {
      stdout: { write: vi.fn() },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stderr: () => stderr,
  };
}

describe('createManagedPythonDaemonBaseUrlResolver', () => {
  it('ensures the core runtime, starts the daemon, reports the URL, and caches the result', async () => {
    const testIo = io();
    const ensureRuntime = vi.fn(async () => ({
      layout: {} as never,
      manifest: {} as never,
    }));
    const startDaemon = vi.fn(async () => ({
      status: 'started' as const,
      layout: {} as never,
      state: { pid: 1234 } as never,
      baseUrl: 'http://127.0.0.1:61234',
    }));
    const resolveBaseUrl = createManagedPythonDaemonBaseUrlResolver({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      installPolicy: 'auto',
      io: testIo.io,
      ensureRuntime,
      startDaemon,
    });

    await expect(resolveBaseUrl()).resolves.toBe('http://127.0.0.1:61234');
    await expect(resolveBaseUrl()).resolves.toBe('http://127.0.0.1:61234');

    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(ensureRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: testIo.io,
      feature: 'core',
    });
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      features: ['core'],
      force: false,
    });
    expect(testIo.stderr()).toContain('Started KTX daemon: http://127.0.0.1:61234');
  });

  it('reports daemon reuse without reinstalling after the first resolved URL', async () => {
    const testIo = io();
    const ensureRuntime = vi.fn(async () => ({
      layout: {} as never,
      manifest: {} as never,
    }));
    const startDaemon = vi.fn(async () => ({
      status: 'reused' as const,
      layout: {} as never,
      state: { pid: 1234 } as never,
      baseUrl: 'http://127.0.0.1:61234',
    }));
    const resolveBaseUrl = createManagedPythonDaemonBaseUrlResolver({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      installPolicy: 'never',
      io: testIo.io,
      ensureRuntime,
      startDaemon,
    });

    await expect(resolveBaseUrl()).resolves.toBe('http://127.0.0.1:61234');
    await expect(resolveBaseUrl()).resolves.toBe('http://127.0.0.1:61234');

    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(testIo.stderr()).toContain('Using existing KTX daemon: http://127.0.0.1:61234');
  });
});

describe('createManagedDaemonHttpJsonRunner', () => {
  it('resolves the managed base URL lazily for each HTTP JSON request', async () => {
    const postJson = vi.fn(async () => ({ ok: true }));
    const runner = createManagedDaemonHttpJsonRunner({
      resolveBaseUrl: async () => 'http://127.0.0.1:61234',
      postJson,
    });

    await expect(runner('/sql/parse-table-identifier', { items: [] })).resolves.toEqual({ ok: true });

    expect(postJson).toHaveBeenCalledWith('http://127.0.0.1:61234', '/sql/parse-table-identifier', { items: [] });
  });
});

describe('KTX daemon ingest ports', () => {
  it('creates a Looker table parser backed by the KTX daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        'model.explore': {
          ok: true,
          catalog: 'warehouse',
          schema: 'public',
          name: 'orders',
          canonical_table: 'public.orders',
        },
      },
    }));
    const parser = createManagedDaemonLookerTableIdentifierParser({ requestJson });

    await expect(
      parser.parse([{ key: 'model.explore', sql_table_name: 'public.orders', dialect: 'postgres' }]),
    ).resolves.toEqual({
      'model.explore': {
        ok: true,
        catalog: 'warehouse',
        schema: 'public',
        name: 'orders',
        canonical_table: 'public.orders',
      },
    });
    expect(requestJson).toHaveBeenCalledWith('/sql/parse-table-identifier', {
      items: [{ key: 'model.explore', sql_table_name: 'public.orders', dialect: 'postgres' }],
    });
  });

  it('creates a SQL analysis port backed by the KTX daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      fingerprint: 'select-orders',
      normalized_sql: 'SELECT * FROM public.orders WHERE id = ?',
      tables_touched: ['public.orders'],
      literal_slots: [{ position: 1, type: 'number', example_value: '42' }],
    }));
    const sqlAnalysis = createManagedDaemonSqlAnalysisPort({ requestJson });

    await expect(sqlAnalysis.analyzeForFingerprint('SELECT * FROM public.orders WHERE id = 42', 'postgres')).resolves
      .toEqual({
        fingerprint: 'select-orders',
        normalizedSql: 'SELECT * FROM public.orders WHERE id = ?',
        tablesTouched: ['public.orders'],
        literalSlots: [{ position: 1, type: 'number', exampleValue: '42' }],
      });
    expect(requestJson).toHaveBeenCalledWith('/api/sql/analyze-for-fingerprint', {
      sql: 'SELECT * FROM public.orders WHERE id = 42',
      dialect: 'postgres',
    });
  });

  it('routes SQL batch analysis through the KTX daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        orders: {
          tables_touched: ['public.orders'],
          columns_by_clause: { select: ['status'] },
          error: null,
        },
      },
    }));
    const sqlAnalysis = createManagedDaemonSqlAnalysisPort({ requestJson });

    await expect(sqlAnalysis.analyzeBatch([{ id: 'orders', sql: 'select status from public.orders' }], 'postgres'))
      .resolves.toEqual(
        new Map([
          [
            'orders',
            {
              tablesTouched: ['public.orders'],
              columnsByClause: { select: ['status'] },
              error: null,
            },
          ],
        ]),
      );
    expect(requestJson).toHaveBeenCalledWith('/sql/analyze-batch', {
      dialect: 'postgres',
      items: [{ id: 'orders', sql: 'select status from public.orders' }],
    });
  });

  it('returns live-database daemon request options backed by the managed runner', async () => {
    const requestJson = vi.fn(async () => ({
      connection_id: 'warehouse',
      tables: [],
    }));
    const options = managedDaemonDatabaseIntrospectionOptions({ requestJson });
    expect(options.requestJson).toBeDefined();

    await expect(options.requestJson?.('/database/introspect', { connection_id: 'warehouse' })).resolves.toEqual({
      connection_id: 'warehouse',
      tables: [],
    });
    expect(requestJson).toHaveBeenCalledWith('/database/introspect', { connection_id: 'warehouse' });
  });
});
