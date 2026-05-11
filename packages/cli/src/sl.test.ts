import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initKtxProject } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxSl } from './sl.js';

const ORDERS_YAML = [
  'name: orders',
  'table: public.orders',
  'grain:',
  '  - order_id',
  'columns:',
  '  - name: order_id',
  '    type: string',
  '',
].join('\n');

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
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

describe('runKtxSl', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-sl-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes, validates, reads, and lists semantic-layer sources', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });

    const writeIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'write',
          projectDir,
          connectionId: 'warehouse',
          sourceName: 'orders',
          yaml: ORDERS_YAML,
        },
        writeIo.io,
      ),
    ).resolves.toBe(0);
    expect(writeIo.stdout()).toContain('Wrote semantic-layer/warehouse/orders.yaml');

    const validateIo = makeIo();
    await expect(
      runKtxSl({ command: 'validate', projectDir, connectionId: 'warehouse', sourceName: 'orders' }, validateIo.io),
    ).resolves.toBe(0);
    expect(validateIo.stdout()).toContain('Valid semantic-layer source: warehouse/orders');

    const readIo = makeIo();
    await expect(runKtxSl({ command: 'read', projectDir, connectionId: 'warehouse', sourceName: 'orders' }, readIo.io))
      .resolves.toBe(0);
    expect(readIo.stdout()).toContain('name: orders');

    const listIo = makeIo();
    await expect(runKtxSl({ command: 'list', projectDir, connectionId: 'warehouse' }, listIo.io)).resolves.toBe(0);
    expect(listIo.stdout()).toContain('warehouse\torders\tcolumns=1\tmeasures=0\tjoins=0');
  });

  it('runs sl query and prints SQL output', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir, projectName: 'warehouse' });
    project.config.connections.warehouse = { driver: 'postgres', readonly: true };
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain: [id]
columns:
  - name: id
    type: number
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const loadProject = vi.fn(async () => project);
    const createSemanticLayerCompute = vi.fn(() => ({
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    }));

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir: '/tmp/project',
          connectionId: 'warehouse',
          query: { measures: ['orders.order_count'], dimensions: [] },
          format: 'sql',
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        { stdout, stderr },
        { loadProject, createSemanticLayerCompute },
      ),
    ).resolves.toBe(0);

    expect(stdout.write).toHaveBeenCalledWith('select count(*) as order_count from public.orders\n');
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('creates default sl query compute through the managed runtime helper', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir, projectName: 'warehouse' });
    project.config.connections.warehouse = { driver: 'postgres', readonly: true };
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain: [id]
columns:
  - name: id
    type: number
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const compute = {
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    };
    const createManagedSemanticLayerCompute = vi.fn(async () => compute);

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir,
          connectionId: 'warehouse',
          query: { measures: ['orders.order_count'], dimensions: [] },
          format: 'sql',
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        { stdout, stderr },
        { createManagedSemanticLayerCompute },
      ),
    ).resolves.toBe(0);

    expect(createManagedSemanticLayerCompute).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: { stdout, stderr },
    });
    expect(stdout.write).toHaveBeenCalledWith('select count(*) as order_count from public.orders\n');
  });

  it('executes sl query through the injected query executor', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir, projectName: 'warehouse' });
    project.config.connections.warehouse = { driver: 'postgres', url: 'postgres://example/db', readonly: true };
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain: [id]
columns:
  - name: id
    type: number
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const loadProject = vi.fn(async () => project);
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['orders.order_count'],
        rows: [[4]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };
    const createSemanticLayerCompute = vi.fn(() => ({
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    }));

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir,
          connectionId: 'warehouse',
          query: { measures: ['orders.order_count'], dimensions: [] },
          format: 'json',
          execute: true,
          maxRows: 20,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        { stdout, stderr },
        {
          loadProject,
          createSemanticLayerCompute,
          createQueryExecutor: () => queryExecutor,
        },
      ),
    ).resolves.toBe(0);

    expect(queryExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'warehouse',
        maxRows: 20,
      }),
    );
    expect(JSON.parse(String(stdout.write.mock.calls[0][0]))).toMatchObject({
      rows: [[4]],
      totalRows: 1,
      plan: {
        execution: {
          mode: 'executed',
        },
      },
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('executes sl query against a local SQLite connection through the default executor', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir, projectName: 'warehouse' });
    const dbPath = join(projectDir, 'warehouse.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO orders (status) VALUES ('paid'), ('paid'), ('open');
    `);
    db.close();

    project.config.connections.warehouse = { driver: 'sqlite', path: 'warehouse.db', readonly: true };
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: warehouse.db',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: orders
grain: [id]
columns:
  - name: id
    type: number
  - name: status
    type: string
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const createSemanticLayerCompute = vi.fn(() => ({
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from orders',
        dialect: 'sqlite',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    }));

    const exitCode = await runKtxSl(
      {
        command: 'query',
        projectDir,
        connectionId: 'warehouse',
        query: { measures: ['orders.order_count'], dimensions: [] },
        format: 'json',
        execute: true,
        maxRows: 20,
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
      },
      { stdout, stderr },
      { createSemanticLayerCompute },
    );

    expect(stderr.write).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    expect(JSON.parse(String(stdout.write.mock.calls[0][0]))).toMatchObject({
      connectionId: 'warehouse',
      dialect: 'sqlite',
      rows: [[3]],
      totalRows: 1,
      plan: {
        execution: {
          mode: 'executed',
          driver: 'sqlite',
          maxRows: 20,
          rowCount: 1,
        },
      },
    });
  });

  it('emits sl list as a JSON envelope when output=json', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });

    const writeIo = makeIo();
    await runKtxSl(
      { command: 'write', projectDir, connectionId: 'warehouse', sourceName: 'orders', yaml: ORDERS_YAML },
      writeIo.io,
    );

    const listIo = makeIo();
    const code = await runKtxSl(
      { command: 'list', projectDir, connectionId: 'warehouse', output: 'json' },
      listIo.io,
    );
    expect(code).toBe(0);

    const parsed = JSON.parse(listIo.stdout());
    expect(parsed.kind).toBe('list');
    expect(parsed.meta).toEqual({ command: 'sl list' });
    expect(parsed.data.items).toHaveLength(1);
    expect(parsed.data.items[0]).toMatchObject({
      connectionId: 'warehouse',
      name: 'orders',
      columnCount: 1,
      measureCount: 0,
      joinCount: 0,
    });
  });

  it('emits sl list with grouping and Clack-style framing when output=pretty', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });

    const writeIo = makeIo();
    await runKtxSl(
      { command: 'write', projectDir, connectionId: 'warehouse', sourceName: 'orders', yaml: ORDERS_YAML },
      writeIo.io,
    );

    const listIo = makeIo();
    const code = await runKtxSl(
      { command: 'list', projectDir, connectionId: 'warehouse', output: 'pretty' },
      listIo.io,
    );
    expect(code).toBe(0);

    const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '');
    const out = stripAnsi(listIo.stdout());
    expect(out).toContain('sl list');
    expect(out).toContain('warehouse');
    expect(out).toContain('orders');
    expect(out).toContain('1 source');
  });
});
