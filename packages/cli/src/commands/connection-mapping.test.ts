import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMetabaseDiscoveryCache } from '@ktx/context/ingest';
import { initKtxProject, loadKtxProject, parseKtxProjectConfig, serializeKtxProjectConfig } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxConnectionMapping } from './connection-mapping.js';

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

describe('runKtxConnectionMapping', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-metabase-mapping-'));
    projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'mapping' });
    const project = await loadKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'ktx.yaml',
      serializeKtxProjectConfig({
        ...project.config,
        connections: {
          'prod-metabase': {
            driver: 'metabase',
            api_url: 'https://metabase.example.com',
            api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
          },
          'prod-warehouse': {
            driver: 'postgres',
            url: 'env:WAREHOUSE_URL',
            readonly: true,
          },
        },
      }),
      'ktx',
      'ktx@example.com',
      'Seed Metabase mapping test connections',
    );
  });

  async function replaceConnections(connections: Record<string, { driver: string; [key: string]: unknown }>) {
    const project = await loadKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'ktx.yaml',
      serializeKtxProjectConfig({
        ...project.config,
        connections,
      }),
      'ktx',
      'ktx@example.com',
      'Replace mapping test connections',
    );
  }

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('sets, lists, disables, and clears local Metabase mappings', async () => {
    const io = makeIo();
    const setCode = await runKtxConnectionMapping(
      {
        command: 'set',
        projectDir,
        connectionId: 'prod-metabase',
        field: 'databaseMappings',
        key: '1',
        value: 'prod-warehouse',
      },
      io.io,
    );
    expect(setCode, io.stderr()).toBe(0);

    let config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['prod-metabase']?.mappings).toMatchObject({
      databaseMappings: { '1': 'prod-warehouse' },
      syncEnabled: { '1': true },
    });

    const listIo = makeIo();
    await expect(
      runKtxConnectionMapping({ command: 'list', projectDir, connectionId: 'prod-metabase', json: false }, listIo.io),
    ).resolves.toBe(0);
    expect(listIo.stdout()).toContain('1 -> prod-warehouse');
    expect(listIo.stdout()).toContain('unhydrated');

    await expect(
      runKtxConnectionMapping(
        {
          command: 'set-sync-enabled',
          projectDir,
          connectionId: 'prod-metabase',
          metabaseDatabaseId: 1,
          enabled: false,
        },
        makeIo().io,
      ),
    ).resolves.toBe(0);

    config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['prod-metabase']?.mappings).toMatchObject({
      databaseMappings: { '1': 'prod-warehouse' },
      syncEnabled: { '1': false },
    });

    await expect(
      runKtxConnectionMapping(
        {
          command: 'clear',
          projectDir,
          connectionId: 'prod-metabase',
          metabaseDatabaseId: 1,
        },
        makeIo().io,
      ),
    ).resolves.toBe(0);

    config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['prod-metabase']?.mappings).toBeUndefined();
  });

  it('lists Metabase yaml mapping bootstrap rows before any SQLite command writes', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-cli-yaml-mapping-'));
    await initKtxProject({ projectDir, projectName: 'yaml-mapping' });
    const project = await loadKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'ktx.yaml',
      serializeKtxProjectConfig({
        ...project.config,
        connections: {
          'prod-metabase': {
            driver: 'metabase',
            mappings: {
              databaseMappings: { '1': 'prod-warehouse' },
              syncEnabled: { '1': true },
            },
          },
          'prod-warehouse': { driver: 'postgres', url: 'postgresql://readonly@db.test/analytics' },
        },
      }),
      'ktx',
      'ktx@example.com',
      'Seed yaml mappings',
    );
    const io = makeIo();

    await expect(
      runKtxConnectionMapping(
        { command: 'list', projectDir, connectionId: 'prod-metabase', json: false },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('1 -> prod-warehouse');
    expect(io.stdout()).toContain('source: ktx.yaml');
  });

  it('refreshes Metabase discovery metadata through the injected runtime client', async () => {
    const client = {
      getDatabases: vi.fn().mockResolvedValue([
        {
          id: 1,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ]),
      cleanup: vi.fn(),
    };
    const io = makeIo();

    await expect(
      runKtxConnectionMapping(
        {
          command: 'refresh',
          projectDir,
          connectionId: 'prod-metabase',
          autoAccept: true,
        },
        io.io,
        {
          createMetabaseClient: async () => client as never,
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Discovery: 1 database');
    expect(client.cleanup).toHaveBeenCalledTimes(1);
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections['prod-metabase']?.mappings).toBeUndefined();
    const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: join(projectDir, '.ktx', 'db.sqlite') });
    await expect(discoveryCache.listDiscoveredDatabases('prod-metabase')).resolves.toMatchObject([
      { id: 1, name: 'Analytics', engine: 'postgres' },
    ]);
  });

  it('sets and lists Looker connection mappings', async () => {
    await replaceConnections({
      'prod-looker': {
        driver: 'looker',
        base_url: 'https://looker.example.test',
        client_id: 'id',
      },
      'prod-warehouse': {
        driver: 'postgres',
        url: 'postgresql://readonly@db.example.test/analytics',
      },
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMapping(
        {
          command: 'set',
          projectDir,
          connectionId: 'prod-looker',
          field: 'connectionMappings',
          key: 'analytics',
          value: 'prod-warehouse',
        },
        io.io,
      ),
    ).resolves.toBe(0);
    await expect(
      runKtxConnectionMapping({ command: 'list', projectDir, connectionId: 'prod-looker', json: false }, io.io),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('analytics -> prod-warehouse');
  });

  it('keeps driver-specific mapping field validation in the runner', async () => {
    await replaceConnections({
      'prod-looker': { driver: 'looker', base_url: 'https://looker.example.com' },
      warehouse: { driver: 'postgres', url: 'env:WAREHOUSE_URL' },
    });

    const io = makeIo();
    await expect(
      runKtxConnectionMapping(
        {
          command: 'set',
          projectDir,
          connectionId: 'prod-looker',
          field: 'databaseMappings',
          key: '1',
          value: 'warehouse',
        },
        io.io,
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('Looker mapping set requires connectionMappings');
  });

  it('refreshes Looker mapping metadata and reports drift', async () => {
    await replaceConnections({
      'prod-looker': {
        driver: 'looker',
        base_url: 'https://looker.example.test',
        client_id: 'id',
      },
      'prod-warehouse': {
        driver: 'postgres',
        url: 'postgresql://readonly@db.example.test/analytics',
      },
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMapping(
        { command: 'refresh', projectDir, connectionId: 'prod-looker', autoAccept: true },
        io.io,
        {
          createLookerClient: async () => ({
            listLookerConnections: async () => [
              {
                name: 'analytics',
                host: 'db.example.test',
                database: 'analytics',
                schema: null,
                dialect: 'postgres',
              },
            ],
            cleanup: async () => {},
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Discovery: 1 connection');
    expect(io.stdout()).toContain('Unmapped discovered: 1');
  });

  it('validates Looker mappings through the canonical local warehouse descriptor', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-cli-descriptor-validation-'));
    await initKtxProject({ projectDir, projectName: 'descriptor-validation' });
    const project = await loadKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'ktx.yaml',
      serializeKtxProjectConfig({
        ...project.config,
        connections: {
          'prod-looker': {
            driver: 'looker',
            mappings: { connectionMappings: { analytics: 'prod-warehouse' } },
          },
          'prod-warehouse': { driver: 'postgresql', url: 'postgresql://readonly@db.test/analytics' },
        },
      }),
      'ktx',
      'ktx@example.com',
      'Seed descriptor validation',
    );
    const io = makeIo();

    await expect(
      runKtxConnectionMapping({ command: 'validate', projectDir, connectionId: 'prod-looker' }, io.io),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Mapping validation passed: prod-looker');
    expect(io.stderr()).toBe('');
  });
});
