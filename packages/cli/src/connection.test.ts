import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetabaseRuntimeClient } from '@ktx/context/ingest';
import { initKtxProject, parseKtxProjectConfig, serializeKtxProjectConfig } from '@ktx/context/project';
import type { KtxConnectionDriver, KtxScanConnector, KtxSchemaSnapshot } from '@ktx/context/scan';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxConnection } from './connection.js';

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

function snapshotFor(driver: KtxConnectionDriver, tableNames: string[]): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver,
    extractedAt: '2026-04-29T00:00:00.000Z',
    scope: {},
    metadata: {},
    tables: tableNames.map((name) => ({
      catalog: null,
      db: null,
      name,
      kind: 'table',
      comment: null,
      estimatedRows: null,
      columns: [],
      foreignKeys: [],
    })),
  };
}

function nativeConnector(driver: KtxConnectionDriver, tableNames: string[]) {
  const introspect = vi.fn(async () => snapshotFor(driver, tableNames));
  const cleanup = vi.fn(async () => undefined);
  const connector: KtxScanConnector = {
    id: `${driver}:warehouse`,
    driver,
    capabilities: {
      structuralIntrospection: true,
      tableSampling: false,
      columnSampling: false,
      columnStats: false,
      readOnlySql: false,
      nestedAnalysis: false,
      eventStreamDiscovery: false,
      formalForeignKeys: false,
      estimatedRowCounts: false,
    },
    introspect,
    cleanup,
  };
  return { connector, introspect, cleanup };
}

describe('runKtxConnection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-connection-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConnections(
    projectDir: string,
    connections: ReturnType<typeof parseKtxProjectConfig>['connections'],
  ): Promise<void> {
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(join(projectDir, 'ktx.yaml'), serializeKtxProjectConfig({ ...config, connections }), 'utf-8');
  }

  it('lists configured connections without resolving secrets', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeConnections(projectDir, {
      warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' },
      docs: { driver: 'notion', auth_token_ref: 'env:NOTION_TOKEN', crawl_mode: 'all_accessible' },
    });
    const io = makeIo();

    await expect(runKtxConnection({ command: 'list', projectDir }, io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).toContain('postgres');
    expect(io.stdout()).toContain('docs');
    expect(io.stdout()).toContain('notion');
    expect(io.stderr()).toBe('');
  });

  it('prints an empty-state message that points at setup instead of removed connection add', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    const io = makeIo();

    await expect(runKtxConnection({ command: 'list', projectDir }, io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain('No connections configured. Run `ktx setup` to add one.');
    expect(io.stdout()).not.toContain('ktx connection add');
  });

  it('tests a configured connection through the native scan connector', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeConnections(projectDir, {
      warehouse: { driver: 'sqlite' },
    });
    const { connector, introspect, cleanup } = nativeConnector('sqlite', ['customers', 'orders']);
    const createScanConnector = vi.fn(async () => connector);
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'warehouse' }, io.io, {
        createScanConnector,
      }),
    ).resolves.toBe(0);

    expect(createScanConnector).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), 'warehouse');
    expect(introspect).toHaveBeenCalledWith(
      {
        connectionId: 'warehouse',
        driver: 'sqlite',
        mode: 'structural',
        dryRun: true,
        detectRelationships: false,
      },
      { runId: 'connection-test-warehouse' },
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('Connection test passed: warehouse');
    expect(io.stdout()).toContain('Driver: sqlite');
    expect(io.stdout()).toContain('Tables: 2');
  });

  it('tests a configured Metabase connection through the Metabase runtime client', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeConnections(projectDir, {
      prod_metabase: {
        driver: 'metabase',
        api_url: 'http://metabase.example.test',
        api_key: 'mb_test', // pragma: allowlist secret
      },
    });
    const testConnection = vi.fn(async () => ({ success: true as const }));
    const getDatabases = vi.fn(async () => [
      { id: 1, name: 'Analytics', engine: 'postgres', details: {}, is_sample: false },
      { id: 2, name: 'Sample Database', engine: 'h2', details: {}, is_sample: true },
    ]);
    const cleanup = vi.fn(async () => undefined);
    const createMetabaseClient = vi.fn(
      async (): Promise<Pick<MetabaseRuntimeClient, 'testConnection' | 'getDatabases' | 'cleanup'>> => ({
        testConnection,
        getDatabases,
        cleanup,
      }),
    );
    const createScanConnector = vi.fn(async () => {
      throw new Error('native scanner should not be used for Metabase');
    });
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'prod_metabase' }, io.io, {
        createScanConnector,
        createMetabaseClient,
      }),
    ).resolves.toBe(0);

    expect(createScanConnector).not.toHaveBeenCalled();
    expect(createMetabaseClient).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), 'prod_metabase');
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(getDatabases).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('Connection test passed: prod_metabase');
    expect(io.stdout()).toContain('Driver: metabase');
    expect(io.stdout()).toContain('Databases: 1');
    expect(io.stderr()).toBe('');
  });

  it('cleans up the native scan connector when connection testing fails', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeConnections(projectDir, {
      warehouse: { driver: 'sqlite' },
    });
    const cleanup = vi.fn(async () => undefined);
    const connector: KtxScanConnector = {
      id: 'sqlite:warehouse',
      driver: 'sqlite',
      capabilities: {
        structuralIntrospection: true,
        tableSampling: false,
        columnSampling: false,
        columnStats: false,
        readOnlySql: false,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: false,
      },
      introspect: vi.fn(async () => {
        throw new Error('database file is unreadable');
      }),
      cleanup,
    };
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'warehouse' }, io.io, {
        createScanConnector: vi.fn(async () => connector),
      }),
    ).resolves.toBe(1);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(io.stderr()).toContain('database file is unreadable');
  });
});
