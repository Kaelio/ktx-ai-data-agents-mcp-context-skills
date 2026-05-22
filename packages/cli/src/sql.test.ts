import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from './context/project/project.js';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from './context/project/config.js';
import type { KtxScanConnector } from './context/scan/types.js';
import type { SqlAnalysisPort } from './context/sql-analysis/ports.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxSql } from './sql.js';

function makeIo(options: { isTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.isTTY,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function makeSqlAnalysis(result: Awaited<ReturnType<SqlAnalysisPort['validateReadOnly']>>): SqlAnalysisPort {
  return {
    analyzeForFingerprint: vi.fn(),
    analyzeBatch: vi.fn(async () => new Map([['cli-sql', { tablesTouched: ['orders'], columnsByClause: {} }]])),
    validateReadOnly: vi.fn(async () => result),
  };
}

function makeConnector(overrides: Partial<KtxScanConnector> = {}): KtxScanConnector {
  return {
    id: 'sqlite:warehouse',
    driver: 'sqlite',
    capabilities: {
      structuralIntrospection: true,
      tableSampling: true,
      columnSampling: true,
      columnStats: true,
      readOnlySql: true,
      nestedAnalysis: false,
      eventStreamDiscovery: false,
      formalForeignKeys: true,
      estimatedRowCounts: true,
    },
    introspect: vi.fn(),
    executeReadOnly: vi.fn(async () => ({
      headers: ['id', 'status'],
      headerTypes: ['integer', 'text'],
      rows: [
        [1, 'paid'],
        [2, 'open'],
      ],
      totalRows: 2,
      rowCount: 2,
    })),
    cleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('runKtxSql', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-sql-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConnections(
    projectDir: string,
    connections: ReturnType<typeof parseKtxProjectConfig>['connections'],
  ): Promise<void> {
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(join(projectDir, 'ktx.yaml'), serializeKtxProjectConfig({ ...config, connections }), 'utf-8');
  }

  it('validates SQL, executes through the scan connector, and prints a pretty table', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, { warehouse: { driver: 'sqlite', path: 'warehouse.db' } });
    const sqlAnalysis = makeSqlAnalysis({ ok: true, error: null });
    const connector = makeConnector();
    const createScanConnector = vi.fn(async () => connector);
    const io = makeIo();

    await expect(
      runKtxSql(
        {
          command: 'execute',
          projectDir,
          connectionId: 'warehouse',
          sql: 'select id, status from orders',
          maxRows: 1000,
          output: 'pretty',
          json: false,
          cliVersion: '0.0.0-test',
        },
        io.io,
        {
          createSqlAnalysis: () => sqlAnalysis,
          createScanConnector,
        },
      ),
    ).resolves.toBe(0);

    expect(sqlAnalysis.validateReadOnly).toHaveBeenCalledWith('select id, status from orders', 'sqlite');
    expect(createScanConnector).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), 'warehouse');
    expect(connector.executeReadOnly).toHaveBeenCalledWith(
      { connectionId: 'warehouse', sql: 'select id, status from orders', maxRows: 1000 },
      { runId: 'cli-sql' },
    );
    expect(connector.cleanup).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('id  status');
    expect(io.stdout()).toContain('1   paid');
    expect(io.stdout()).toContain('2   open');
    expect(io.stdout()).toContain('2 rows');
    expect(io.stderr()).toBe('');
  });

  it('emits debug telemetry for SQL without raw query text', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, { warehouse: { driver: 'sqlite', path: 'warehouse.db' } });
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxSql(
        {
          command: 'execute',
          projectDir,
          connectionId: 'warehouse',
          sql: 'select count(*) from orders',
          maxRows: 10,
          output: 'json',
          json: true,
          cliVersion: '0.0.0-test',
        },
        io.io,
        {
          createSqlAnalysis: () => makeSqlAnalysis({ ok: true, error: null }),
          createScanConnector: vi.fn(async () => makeConnector()),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('"event":"sql_completed"');
    expect(io.stderr()).toContain('"queryVerb":"select"');
    expect(io.stderr()).not.toContain('select count(*)');
  });

  it('prints JSON output', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, { warehouse: { driver: 'sqlite', path: 'warehouse.db' } });
    const io = makeIo();

    await expect(
      runKtxSql(
        {
          command: 'execute',
          projectDir,
          connectionId: 'warehouse',
          sql: 'select id from orders',
          maxRows: 10,
          output: undefined,
          json: true,
          cliVersion: '0.0.0-test',
        },
        io.io,
        {
          createSqlAnalysis: () => makeSqlAnalysis({ ok: true, error: null }),
          createScanConnector: vi.fn(async () => makeConnector()),
        },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toEqual({
      connectionId: 'warehouse',
      headers: ['id', 'status'],
      headerTypes: ['integer', 'text'],
      rows: [
        [1, 'paid'],
        [2, 'open'],
      ],
      rowCount: 2,
    });
  });

  it('prints plain TSV output', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, { warehouse: { driver: 'sqlite', path: 'warehouse.db' } });
    const io = makeIo();

    await expect(
      runKtxSql(
        {
          command: 'execute',
          projectDir,
          connectionId: 'warehouse',
          sql: 'select id from orders',
          maxRows: 10,
          output: 'plain',
          json: false,
          cliVersion: '0.0.0-test',
        },
        io.io,
        {
          createSqlAnalysis: () => makeSqlAnalysis({ ok: true, error: null }),
          createScanConnector: vi.fn(async () => makeConnector()),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toBe('id\tstatus\n1\tpaid\n2\topen\n');
    expect(io.stderr()).toBe('');
  });

  it('rejects non-read-only SQL before executing connector SQL', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, { warehouse: { driver: 'sqlite', path: 'warehouse.db' } });
    const connector = makeConnector();
    const io = makeIo();

    await expect(
      runKtxSql(
        {
          command: 'execute',
          projectDir,
          connectionId: 'warehouse',
          sql: 'delete from orders',
          maxRows: 1000,
          output: 'pretty',
          json: false,
          cliVersion: '0.0.0-test',
        },
        io.io,
        {
          createSqlAnalysis: () => makeSqlAnalysis({ ok: false, error: 'SQL contains read/write operation: Delete' }),
          createScanConnector: vi.fn(async () => connector),
        },
      ),
    ).resolves.toBe(1);

    expect(connector.executeReadOnly).not.toHaveBeenCalled();
    expect(connector.cleanup).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('SQL contains read/write operation: Delete');
  });

  it('rejects missing connections', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    const io = makeIo();

    await expect(
      runKtxSql(
        {
          command: 'execute',
          projectDir,
          connectionId: 'warehouse',
          sql: 'select 1',
          maxRows: 1000,
          output: 'pretty',
          json: false,
          cliVersion: '0.0.0-test',
        },
        io.io,
        {
          createSqlAnalysis: () => makeSqlAnalysis({ ok: true, error: null }),
        },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('Connection "warehouse" is not configured in ktx.yaml');
  });

  it('rejects connectors without read-only SQL support and still cleans up', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, { warehouse: { driver: 'sqlite', path: 'warehouse.db' } });
    const connector = makeConnector({
      capabilities: {
        ...makeConnector().capabilities,
        readOnlySql: false,
      },
    });
    const io = makeIo();

    await expect(
      runKtxSql(
        {
          command: 'execute',
          projectDir,
          connectionId: 'warehouse',
          sql: 'select 1',
          maxRows: 1000,
          output: 'pretty',
          json: false,
          cliVersion: '0.0.0-test',
        },
        io.io,
        {
          createSqlAnalysis: () => makeSqlAnalysis({ ok: true, error: null }),
          createScanConnector: vi.fn(async () => connector),
        },
      ),
    ).resolves.toBe(1);

    expect(connector.executeReadOnly).not.toHaveBeenCalled();
    expect(connector.cleanup).toHaveBeenCalledTimes(1);
    expect(io.stderr()).toContain('Connection "warehouse" does not support read-only SQL execution.');
  });
});
