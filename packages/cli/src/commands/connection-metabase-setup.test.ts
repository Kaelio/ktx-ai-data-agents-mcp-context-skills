import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMetabaseSourceStateReader } from '@ktx/context/ingest';
import { initKtxProject, ktxLocalStateDbPath, loadKtxProject, serializeKtxProjectConfig } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runKtxConnectionMetabaseSetup } from './connection-metabase-setup.js';

const CANCEL_PROMPT = Symbol('cancel');

function createTestMetabaseSetupPromptAdapter(options: {
  selects?: Array<string | typeof CANCEL_PROMPT>;
  multiselects?: Array<Array<unknown> | typeof CANCEL_PROMPT>;
  texts?: Array<string | typeof CANCEL_PROMPT>;
  passwords?: Array<string | typeof CANCEL_PROMPT>;
  confirms?: Array<boolean | typeof CANCEL_PROMPT>;
  events?: string[];
}) {
  const selects = [...(options.selects ?? [])];
  const multiselects = [...(options.multiselects ?? [])];
  const texts = [...(options.texts ?? [])];
  const passwords = [...(options.passwords ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const events = options.events ?? [];

  const cancelWithError = () => {
    throw new Error('Setup cancelled.');
  };

  return {
    intro(title?: string): void {
      events.push(`intro:${title ?? ''}`);
    },
    outro(message?: string): void {
      events.push(`outro:${message ?? ''}`);
    },
    note(message: string, title: string): void {
      events.push(`note:${title}:${message}`);
    },
    log: {
      info(message: string): void {
        events.push(`log.info:${message}`);
      },
      step(message: string): void {
        events.push(`log.step:${message}`);
      },
      success(message: string): void {
        events.push(`log.success:${message}`);
      },
      warn(message: string): void {
        events.push(`log.warn:${message}`);
      },
      error(message: string): void {
        events.push(`log.error:${message}`);
      },
    },
    spinner() {
      return {
        start(message: string): void {
          events.push(`spinner.start:${message}`);
        },
        stop(message: string): void {
          events.push(`spinner.stop:${message}`);
        },
        error(message: string): void {
          events.push(`spinner.error:${message}`);
        },
      };
    },
    async select<T extends string>(): Promise<T> {
      const next = selects.shift();
      if (next === CANCEL_PROMPT) {
        cancelWithError();
      }
      return next as T;
    },
    async multiselect<Value>(options?: { message: string }): Promise<Value[]> {
      events.push(`multiselect:${options?.message ?? ''}`);
      const next = multiselects.shift();
      if (next === CANCEL_PROMPT) {
        cancelWithError();
      }
      return (next ?? []) as Value[];
    },
    async text(): Promise<string> {
      const next = texts.shift();
      if (next === CANCEL_PROMPT) {
        cancelWithError();
      }
      return (next ?? '').toString();
    },
    async password(): Promise<string> {
      const next = passwords.shift();
      if (next === CANCEL_PROMPT) {
        cancelWithError();
      }
      return (next ?? '').toString();
    },
    async confirm(): Promise<boolean> {
      const next = confirms.shift();
      if (next === CANCEL_PROMPT) {
        cancelWithError();
      }
      return next === true;
    },
    cancel(): void {
      return;
    },
  };
}

function makeIo(options: { isTTY?: boolean; stdinIsTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdin: {
        isTTY: options.stdinIsTTY,
      },
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

describe('runKtxConnectionMetabaseSetup', () => {
  const fakeMetabaseCredential = 'mb_example';
  const existingMetabaseCredential = 'mb_existing';
  const fakeAdminCredential = 'admin-secret-value-123';

  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-metabase-setup-'));
    projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'metabase-setup' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConnections(connections: Record<string, { driver: string; [key: string]: unknown }>) {
    const project = await loadKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'ktx.yaml',
      serializeKtxProjectConfig({
        ...project.config,
        connections,
      }),
      'ktx',
      'ktx@example.com',
      'Seed Metabase setup test connections',
    );
  }

  function makeMetabaseClient(options: {
    testConnectionSuccess: boolean;
    databases: Array<{
      id: number;
      name: string;
      engine: string;
      details?: { host?: string; dbname?: string };
      is_sample?: boolean;
    }>;
  }) {
    return {
      testConnection: vi.fn().mockResolvedValue({ success: options.testConnectionSuccess }),
      getDatabases: vi.fn().mockResolvedValue(options.databases),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('covers the headless happy path', async () => {
    await writeConnections({
      orbit: {
        driver: 'postgres',
        url: 'postgresql://readonly@pg.internal/analytics',
        readonly: true,
      },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [{ metabaseDatabaseId: 2, targetConnectionId: 'orbit' }],
          syncEnabledDatabaseIds: [2],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Connection: metabase');
    expect(io.stdout()).toContain('Discovered 1 database');
    expect(io.stdout()).toContain(`ktx ingest metabase --project-dir ${projectDir}`);
    expect(io.stdout()).not.toContain('mb_example');
    expect(io.stderr()).not.toContain('mb_example');

    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(config).toContain('driver: metabase');
    expect(config).toContain('api_url: http://metabase.example.test:3000');
    expect(config).toContain('api_key: mb_example');

    const updatedProject = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(updatedProject) });
    await expect(store.listDatabaseMappings('metabase')).resolves.toMatchObject([
      {
        metabaseDatabaseId: 2,
        metabaseDatabaseName: 'Analytics',
        targetConnectionId: 'orbit',
        syncEnabled: true,
      },
    ]);
  });

  it('auto-maps and enables sync in --no-input --yes when deterministic', async () => {
    await writeConnections({
      orbit: {
        driver: 'postgres',
        url: 'postgresql://readonly@pg.internal/analytics',
        readonly: true,
      },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(0);

    const updatedProject = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(updatedProject) });
    await expect(store.listDatabaseMappings('metabase')).resolves.toMatchObject([
      { metabaseDatabaseId: 2, targetConnectionId: 'orbit', syncEnabled: true },
    ]);
  });

  it('fails in --no-input when mapping/sync are missing and --yes is false', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [{ id: 2, name: 'Analytics', engine: 'postgres', is_sample: false }],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: false,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toMatch(/--map/i);
    expect(io.stderr()).toMatch(/--sync/i);
  });

  it('enables sync for explicitly mapped databases in --no-input --yes when --sync is omitted', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [{ id: 2, name: 'Analytics', engine: 'postgres', is_sample: false }],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [{ metabaseDatabaseId: 2, targetConnectionId: 'orbit' }],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(0);

    const updatedProject = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(updatedProject) });
    await expect(store.listDatabaseMappings('metabase')).resolves.toMatchObject([
      { metabaseDatabaseId: 2, targetConnectionId: 'orbit', syncEnabled: true },
    ]);
  });

  it('fails in no-input mode when the Metabase URL is missing', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('missing Metabase URL');
  });

  it('fails in no-input mode when the Metabase API key is missing', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('missing Metabase API key');
  });

  it('names missing minting flags before rejecting minting', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });

    const missingUsernameIo = makeIo();
    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          mintApiKey: true,
          metabasePassword: fakeAdminCredential,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        missingUsernameIo.io,
      ),
    ).resolves.toBe(1);
    expect(missingUsernameIo.stderr()).toContain('--username');

    const missingPasswordIo = makeIo();
    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          mintApiKey: true,
          metabaseUsername: 'user',
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        missingPasswordIo.io,
      ),
    ).resolves.toBe(1);
    expect(missingPasswordIo.stderr()).toContain('--password');

    const mintedMetabaseCredential = 'mb_minted';
    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ],
    });
    const createMetabaseClient = vi.fn(async () => metabaseClient as never);
    const mintMetabaseApiKey = vi.fn(async () => mintedMetabaseCredential);
    const mintingIo = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          mintApiKey: true,
          metabaseUsername: 'user',
          metabasePassword: fakeAdminCredential,
          mappings: [{ metabaseDatabaseId: 2, targetConnectionId: 'orbit' }],
          syncEnabledDatabaseIds: [2],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        mintingIo.io,
        { createMetabaseClient, mintMetabaseApiKey },
      ),
    ).resolves.toBe(0);

    expect(mintMetabaseApiKey).toHaveBeenCalledTimes(1);
    expect(mintMetabaseApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://metabase.example.test:3000',
        username: 'user',
        password: fakeAdminCredential,
      }),
      expect.anything(),
    );

    expect(createMetabaseClient).toHaveBeenCalledTimes(1);
    expect(mintingIo.stdout()).not.toContain(mintedMetabaseCredential);
    expect(mintingIo.stderr()).not.toContain(mintedMetabaseCredential);
    expect(mintingIo.stdout()).not.toContain(fakeAdminCredential);
    expect(mintingIo.stderr()).not.toContain(fakeAdminCredential);

    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(config).toContain('driver: metabase');
    expect(config).toContain('api_url: http://metabase.example.test:3000');
    expect(config).toContain(`api_key: ${mintedMetabaseCredential}`);
  });

  it('requires at least one warehouse connection', async () => {
    await writeConnections({});
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('Add a warehouse connection first');
  });

  it('fails in --no-input --yes when a deterministic warehouse mapping cannot be derived', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
      warehouse2: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });
    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toMatch(/--map/i);
    expect(io.stderr()).toMatch(/--sync/i);
  });

  it('auto-enables sync in --no-input --yes from explicit mappings even when multiple databases are discovered', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });
    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 1,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
        {
          id: 2,
          name: 'Finance',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'finance' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [{ metabaseDatabaseId: 1, targetConnectionId: 'orbit' }],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(0);

    const updatedProject = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(updatedProject) });
    await expect(store.listDatabaseMappings('metabase')).resolves.toMatchObject([
      { metabaseDatabaseId: 1, targetConnectionId: 'orbit', syncEnabled: true },
      { metabaseDatabaseId: 2, targetConnectionId: null, syncEnabled: false },
    ]);
  });

  it('suggests updating api_key or using minting when authentication fails', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });
    const metabaseClient = makeMetabaseClient({ testConnectionSuccess: false, databases: [] });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('connections.metabase.api_key');
    expect(io.stderr()).toContain('--mint-api-key');
    expect(io.stderr()).not.toContain('mb_example');
  });

  it('fails when Metabase returns no usable databases', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });
    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [{ id: 1, name: 'Sample', engine: 'h2', is_sample: true }],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('no usable databases');
  });

  it('preserves setup writes when --run-ingest fails and reports the debug command', async () => {
    await writeConnections({
      orbit: {
        driver: 'postgres',
        url: 'postgresql://readonly@pg.internal/analytics',
        readonly: true,
      },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          connectionId: 'metabase',
          url: 'http://metabase.example.test:3000',
          apiKey: fakeMetabaseCredential,
          mintApiKey: false,
          mappings: [{ metabaseDatabaseId: 2, targetConnectionId: 'orbit' }],
          syncEnabledDatabaseIds: [2],
          syncMode: 'ALL',
          runIngest: true,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        {
          createMetabaseClient: async () => metabaseClient as never,
          runPublicIngest: vi.fn(async () => 1),
        },
      ),
    ).resolves.toBe(1);

    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(config).toContain('driver: metabase');
    expect(io.stderr()).toContain(`ktx ingest metabase --project-dir ${projectDir}`);

    const updatedProject = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(updatedProject) });
    await expect(store.listDatabaseMappings('metabase')).resolves.toMatchObject([
      { metabaseDatabaseId: 2, targetConnectionId: 'orbit' },
    ]);
  });

  it('reuses existing connection id and values when --id, --url, and --api-key are omitted', async () => {
    await writeConnections({
      'prod-metabase': {
        driver: 'metabase',
        api_url: 'http://metabase.example.test:3000',
        api_key: existingMetabaseCredential,
      },
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [{ id: 2, name: 'Analytics', engine: 'postgres', is_sample: false }],
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          mintApiKey: false,
          mappings: [{ metabaseDatabaseId: 2, targetConnectionId: 'orbit' }],
          syncEnabledDatabaseIds: [2],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
        { createMetabaseClient: async () => metabaseClient as never },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Connection: prod-metabase');
    expect(io.stdout()).not.toContain('mb_existing');
    expect(io.stderr()).not.toContain('mb_existing');
  });

  it('covers interactive happy path when URL/key/mapping/sync are missing but deterministic', async () => {
    await writeConnections({
      orbit: {
        driver: 'postgres',
        url: 'postgresql://readonly@pg.internal/analytics',
        readonly: true,
      },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo({ isTTY: true, stdinIsTTY: true });
    const interactiveMetabaseCredential = 'mb_interactive_fixture';

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: false,
          inputMode: 'auto',
        },
        io.io,
        {
          createMetabaseClient: async () => metabaseClient as never,
          prompts: createTestMetabaseSetupPromptAdapter({
            texts: ['http://metabase.example.test:3000'],
            selects: ['paste'],
            passwords: [interactiveMetabaseCredential],
            confirms: [true],
          }),
        },
      ),
    ).resolves.toBe(0);

    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(config).toContain('driver: metabase');
    expect(config).toContain('api_url: http://metabase.example.test:3000');
    expect(config).toContain(`api_key: ${interactiveMetabaseCredential}`);

    const updatedProject = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(updatedProject) });
    await expect(store.listDatabaseMappings('metabase')).resolves.toMatchObject([
      {
        metabaseDatabaseId: 2,
        targetConnectionId: 'orbit',
        syncEnabled: true,
      },
    ]);

    expect(io.stdout()).not.toContain(interactiveMetabaseCredential);
    expect(io.stderr()).not.toContain(interactiveMetabaseCredential);
  });

  it('guides interactive setup for multiple databases and warehouses', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics', readonly: true },
      warehouse2: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/finance', readonly: true },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
        {
          id: 3,
          name: 'Finance',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'finance' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo({ isTTY: true, stdinIsTTY: true });
    const interactiveMetabaseCredential = 'mb_interactive_multi';
    const events: string[] = [];

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: false,
          inputMode: 'auto',
        },
        io.io,
        {
          createMetabaseClient: async () => metabaseClient as never,
          prompts: createTestMetabaseSetupPromptAdapter({
            texts: ['http://metabase.example.test:3000'],
            selects: ['paste', 'orbit', 'warehouse2'],
            passwords: [interactiveMetabaseCredential],
            multiselects: [[2, 3], [2]],
            confirms: [true],
            events,
          }),
        },
      ),
    ).resolves.toBe(0);

    const updatedProject = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(updatedProject) });
    await expect(store.listDatabaseMappings('metabase')).resolves.toMatchObject([
      { metabaseDatabaseId: 2, targetConnectionId: 'orbit', syncEnabled: true },
      { metabaseDatabaseId: 3, targetConnectionId: 'warehouse2', syncEnabled: false },
    ]);

    expect(io.stdout()).not.toContain(interactiveMetabaseCredential);
    expect(io.stderr()).not.toContain(interactiveMetabaseCredential);
    expect(events).toContain(
      'multiselect:Select Metabase databases to configure\nUse Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
    );
    expect(events).toContain(
      'multiselect:Enable sync for which databases?\nUse Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
    );
  });

  it('emits guided progress via the interaction toolkit in interactive mode', async () => {
    await writeConnections({
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics', readonly: true },
    });

    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo({ isTTY: true, stdinIsTTY: true });
    const interactiveMetabaseCredential = 'mb_interaction_toolkit';
    const events: string[] = [];

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: false,
          inputMode: 'auto',
        },
        io.io,
        {
          createMetabaseClient: async () => metabaseClient as never,
          prompts: createTestMetabaseSetupPromptAdapter({
            events,
            texts: ['http://metabase.example.test:3000'],
            selects: ['paste'],
            passwords: [interactiveMetabaseCredential],
            confirms: [true],
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(events).toContain('intro:KTX Metabase setup');
    expect(events.some((event) => event.startsWith('spinner.start:Testing Metabase connection'))).toBe(true);
    expect(events.some((event) => event.startsWith('spinner.stop:Metabase reachable'))).toBe(true);
    expect(events.some((event) => event.startsWith('spinner.start:Discovering Metabase databases'))).toBe(true);
    expect(events.some((event) => event.startsWith('log.success:Discovered 1 database'))).toBe(true);
    expect(events.some((event) => event.startsWith('note:Summary:'))).toBe(true);
    expect(events).toContain('outro:Metabase setup complete');

    expect(events.join('\n')).not.toContain(interactiveMetabaseCredential);
    expect(io.stdout()).not.toContain(interactiveMetabaseCredential);
    expect(io.stderr()).not.toContain(interactiveMetabaseCredential);
  });

  it('fails in --no-input when multiple Metabase connections exist and --id is omitted', async () => {
    await writeConnections({
      metabase1: {
        driver: 'metabase',
        api_url: 'http://metabase.example.test:3000',
        api_key: existingMetabaseCredential,
      },
      metabase2: {
        driver: 'metabase',
        api_url: 'http://metabase.example.test:3000',
        api_key: existingMetabaseCredential,
      },
      orbit: { driver: 'postgres', url: 'postgresql://readonly@pg.internal/analytics' },
    });
    const io = makeIo();

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: true,
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toMatch(/--id/i);
  });

  it('treats prompt cancellation as a clean exit without writes', async () => {
    await writeConnections({
      orbit: {
        driver: 'postgres',
        url: 'postgresql://readonly@pg.internal/analytics',
        readonly: true,
      },
    });

    const beforeConfig = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    const metabaseClient = makeMetabaseClient({
      testConnectionSuccess: true,
      databases: [
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ],
    });
    const io = makeIo({ isTTY: true, stdinIsTTY: true });
    const cancelMetabaseCredential = 'mb_cancel_fixture';

    await expect(
      runKtxConnectionMetabaseSetup(
        {
          command: 'setup',
          projectDir,
          mintApiKey: false,
          mappings: [],
          syncEnabledDatabaseIds: [],
          syncMode: 'ALL',
          runIngest: false,
          yes: false,
          inputMode: 'auto',
        },
        io.io,
        {
          createMetabaseClient: async () => metabaseClient as never,
          prompts: createTestMetabaseSetupPromptAdapter({
            texts: ['http://metabase.example.test:3000'],
            selects: ['paste'],
            passwords: [cancelMetabaseCredential],
            confirms: [CANCEL_PROMPT],
          }),
        },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('Setup cancelled.');
    expect(io.stderr()).not.toContain(cancelMetabaseCredential);

    const afterConfig = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(afterConfig).toBe(beforeConfig);

    const updatedProject = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(updatedProject) });
    await expect(store.listDatabaseMappings('metabase')).resolves.toEqual([]);
  });
});
