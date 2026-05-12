import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultKtxProjectConfig } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxAgent } from './agent.js';
import type { KtxAgentRuntime } from './agent-runtime.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function runtime(overrides: Record<string, unknown> = {}): KtxAgentRuntime {
  const config = buildDefaultKtxProjectConfig('revenue');
  return {
    project: {
      projectDir: '/tmp/revenue',
      configPath: '/tmp/revenue/ktx.yaml',
      config: {
        ...config,
        connections: {
          warehouse: { driver: 'sqlite', path: 'warehouse.sqlite', readonly: true as const },
        },
      },
      coreConfig: {} as KtxAgentRuntime['project']['coreConfig'],
      git: {} as KtxAgentRuntime['project']['git'],
      fileStore: {} as KtxAgentRuntime['project']['fileStore'],
    },
    ports: {
      connections: { list: vi.fn(async () => [{ id: 'warehouse', name: 'warehouse', connectionType: 'sqlite' }]) },
      semanticLayer: {
        listSources: vi.fn(async () => ({
          sources: [
            {
              connectionId: 'warehouse',
              connectionName: 'warehouse',
              name: 'orders',
              columnCount: 2,
              measureCount: 1,
              joinCount: 0,
            },
          ],
          totalSources: 1,
        })),
        readSource: vi.fn(async () => ({ sourceName: 'orders', yaml: 'name: orders\n' })),
        writeSource: vi.fn(async () => ({ success: true, sourceName: 'orders' })),
        validate: vi.fn(async () => ({ success: true, errors: [], warnings: [] })),
        query: vi.fn(async () => ({ sql: 'select 1', headers: ['x'], rows: [[1]], totalRows: 1, plan: {} })),
      },
      knowledge: {
        search: vi.fn(async () => ({
          results: [
            {
              key: 'page-1',
              path: 'knowledge/global/page-1.md',
              scope: 'GLOBAL' as const,
              summary: 'Revenue logic',
              score: 0.9,
              matchReasons: ['lexical' as const],
            },
          ],
          totalFound: 1,
        })),
        read: vi.fn(async () => ({
          key: 'page-1',
          scope: 'GLOBAL' as const,
          summary: 'Revenue logic',
          content: 'Use net revenue.',
        })),
        write: vi.fn(async () => ({ success: true, key: 'page-1', action: 'created' as const })),
      },
    },
    queryExecutor: {
      execute: vi.fn(async () => ({ headers: ['x'], rows: [[1]], totalRows: 1, command: 'SELECT', rowCount: 1 })),
    },
    ...overrides,
  };
}

function runtimeWithoutConnections(): KtxAgentRuntime {
  const base = runtime();
  return {
    ...base,
    project: {
      ...base.project,
      config: {
        ...base.project.config,
        connections: {},
      },
    },
    ports: {
      ...base.ports,
      semanticLayer: {
        ...base.ports.semanticLayer!,
        listSources: vi.fn(async () => ({ sources: [], totalSources: 0 })),
      },
    },
  };
}

describe('runKtxAgent', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-agent-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints tool discovery with every stable command', async () => {
    const io = makeIo();

    await expect(runKtxAgent({ command: 'tools', projectDir: tempDir, json: true }, io.io)).resolves.toBe(0);

    const body = JSON.parse(io.stdout());
    expect(body.projectDir).toBe(tempDir);
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'context',
      'sl.list',
      'sl.read',
      'sl.query',
      'wiki.search',
      'wiki.read',
      'sql.execute',
    ]);
    expect(io.stderr()).toBe('');
  });

  it('prints project context from setup status, connections, and SL summaries', async () => {
    const io = makeIo();
    const createRuntime = vi.fn(async () => runtime());
    const readSetupStatus = vi.fn(async () => ({ project: { path: tempDir, ready: true }, agents: [] }));

    await expect(
      runKtxAgent({ command: 'context', projectDir: tempDir, json: true }, io.io, { createRuntime, readSetupStatus }),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      projectDir: tempDir,
      status: { project: { ready: true } },
      connections: [{ id: 'warehouse' }],
      semanticLayer: { totalSources: 1 },
    });
  });

  it('dispatches SL list, SL read, wiki search, and wiki read through local ports', async () => {
    for (const args of [
      { command: 'sl-list' as const, projectDir: tempDir, json: true as const, connectionId: 'warehouse' },
      {
        command: 'sl-read' as const,
        projectDir: tempDir,
        json: true as const,
        connectionId: 'warehouse',
        sourceName: 'orders',
      },
      { command: 'wiki-search' as const, projectDir: tempDir, json: true as const, query: 'revenue', limit: 10 },
      { command: 'wiki-read' as const, projectDir: tempDir, json: true as const, pageId: 'page-1' },
    ]) {
      const io = makeIo();
      await expect(runKtxAgent(args, io.io, { createRuntime: async () => runtime() })).resolves.toBe(0);
      expect(JSON.parse(io.stdout())).toBeTruthy();
      expect(io.stderr()).toBe('');
    }
  });

  it('prints wiki hybrid search metadata from the hidden agent wiki search command', async () => {
    const fakeRuntime = runtime();
    const knowledge = fakeRuntime.ports.knowledge;
    if (!knowledge) {
      throw new Error('Expected runtime knowledge port');
    }
    fakeRuntime.ports.knowledge = {
      ...knowledge,
      search: vi.fn(async () => ({
        results: [
          {
            key: 'metrics-revenue',
            path: 'knowledge/global/metrics-revenue.md',
            scope: 'GLOBAL' as const,
            summary: 'Revenue metric definition',
            score: 0.02459016393442623,
            matchReasons: ['lexical' as const, 'token' as const],
          },
        ],
        totalFound: 1,
      })),
    };
    const io = makeIo();

    await expect(
      runKtxAgent({ command: 'wiki-search', projectDir: tempDir, json: true, query: 'paid order', limit: 5 }, io.io, {
        createRuntime: async () => fakeRuntime,
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toEqual({
      results: [
        expect.objectContaining({
          key: 'metrics-revenue',
          path: 'knowledge/global/metrics-revenue.md',
          matchReasons: ['lexical', 'token'],
        }),
      ],
      totalFound: 1,
    });
  });

  it('executes SL queries from a JSON query file', async () => {
    const queryFile = join(tempDir, 'sl-query.json');
    const io = makeIo();
    await writeFile(queryFile, '{"measures":["total_revenue"],"dimensions":[]}', 'utf-8');

    await expect(
      runKtxAgent(
        {
          command: 'sl-query',
          projectDir: tempDir,
          json: true,
          connectionId: 'warehouse',
          queryFile,
          execute: true,
          maxRows: 100,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'never',
        },
        io.io,
        { createRuntime: async () => runtime() },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({ sql: 'select 1', rows: [[1]] });
  });

  it('passes managed runtime options into default SL query runtime creation', async () => {
    const queryFile = join(tempDir, 'sl-query.json');
    const io = makeIo();
    const createRuntime = vi.fn(async () => runtime());
    await writeFile(queryFile, '{"measures":["total_revenue"],"dimensions":[]}', 'utf-8');

    await expect(
      runKtxAgent(
        {
          command: 'sl-query',
          projectDir: tempDir,
          json: true,
          connectionId: 'warehouse',
          queryFile,
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        io.io,
        { createRuntime },
      ),
    ).resolves.toBe(0);

    expect(createRuntime).toHaveBeenCalledWith({
      projectDir: tempDir,
      enableSemanticCompute: true,
      enableQueryExecution: false,
      cliVersion: '0.2.0',
      runtimeInstallPolicy: 'auto',
      io: io.io,
    });
  });

  it('executes read-only SQL from a SQL file with an explicit row limit', async () => {
    const sqlFile = join(tempDir, 'query.sql');
    const fakeRuntime = runtime();
    const io = makeIo();
    await writeFile(sqlFile, 'select 1', 'utf-8');

    await expect(
      runKtxAgent(
        {
          command: 'sql-execute',
          projectDir: tempDir,
          json: true,
          connectionId: 'warehouse',
          sqlFile,
          maxRows: 100,
        },
        io.io,
        { createRuntime: async () => fakeRuntime as never },
      ),
    ).resolves.toBe(0);

    expect(fakeRuntime.queryExecutor?.execute).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      projectDir: '/tmp/revenue',
      connection: { driver: 'sqlite', path: 'warehouse.sqlite', readonly: true },
      sql: 'select 1',
      maxRows: 100,
    });
  });

  it('prints guided JSON when semantic-layer search runs outside a project', async () => {
    const io = makeIo();
    const missingProjectError = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
      path: join(tempDir, 'ktx.yaml'),
    });

    await expect(
      runKtxAgent(
        { command: 'sl-list', projectDir: tempDir, json: true, query: 'gross revenue' },
        io.io,
        { createRuntime: vi.fn(async () => Promise.reject(missingProjectError)) },
      ),
    ).resolves.toBe(1);

    expect(JSON.parse(io.stderr())).toEqual({
      ok: false,
      error: {
        code: 'agent_sl_search_missing_project',
        message: `Semantic-layer search needs an initialized KTX project at ${tempDir}.`,
        nextSteps: [
          'ktx demo',
          `ktx setup --project-dir ${tempDir}`,
          'ktx ingest <connection>',
          `ktx agent sl list --json --query "gross revenue" --project-dir ${tempDir}`,
        ],
      },
    });
    expect(io.stdout()).toBe('');
  });

  it('prints guided JSON when semantic-layer search has no configured connections', async () => {
    const io = makeIo();

    await expect(
      runKtxAgent(
        { command: 'sl-list', projectDir: tempDir, json: true, query: 'revenue' },
        io.io,
        { createRuntime: async () => runtimeWithoutConnections() },
      ),
    ).resolves.toBe(1);

    expect(JSON.parse(io.stderr())).toMatchObject({
      ok: false,
      error: {
        code: 'agent_sl_search_no_connections',
        message: `Semantic-layer search found no configured connections in ${tempDir}.`,
        nextSteps: [
          'ktx demo',
          `ktx setup --project-dir ${tempDir}`,
          'ktx ingest <connection>',
          `ktx agent sl list --json --query "revenue" --project-dir ${tempDir}`,
        ],
      },
    });
  });

  it('prints guided JSON when semantic-layer search asks for an unknown connection', async () => {
    const io = makeIo();

    await expect(
      runKtxAgent(
        { command: 'sl-list', projectDir: tempDir, json: true, connectionId: 'missing', query: 'revenue' },
        io.io,
        { createRuntime: async () => runtime() },
      ),
    ).resolves.toBe(1);

    expect(JSON.parse(io.stderr())).toMatchObject({
      ok: false,
      error: {
        code: 'agent_sl_search_unknown_connection',
        message: `Semantic-layer search connection "missing" is not configured in ${tempDir}.`,
      },
    });
  });

  it('prints guided JSON when semantic-layer search has no indexed sources', async () => {
    const fakeRuntime = runtime();
    const semanticLayer = fakeRuntime.ports.semanticLayer!;
    fakeRuntime.ports.semanticLayer = {
      ...semanticLayer,
      listSources: vi.fn(async () => ({ sources: [], totalSources: 0 })),
    };
    const io = makeIo();

    await expect(
      runKtxAgent(
        { command: 'sl-list', projectDir: tempDir, json: true, connectionId: 'warehouse', query: 'revenue' },
        io.io,
        { createRuntime: async () => fakeRuntime },
      ),
    ).resolves.toBe(1);

    expect(JSON.parse(io.stderr())).toMatchObject({
      ok: false,
      error: {
        code: 'agent_sl_search_no_indexed_sources',
        message: `Semantic-layer search found no indexed semantic-layer sources in ${tempDir}.`,
      },
    });
  });

  it('returns JSON errors when required ports or records are missing', async () => {
    const io = makeIo();

    await expect(
      runKtxAgent({ command: 'wiki-read', projectDir: tempDir, json: true, pageId: 'missing' }, io.io, {
        createRuntime: async () =>
          runtime({
            ports: { knowledge: { read: vi.fn(async () => null) } },
          }) as never,
      }),
    ).resolves.toBe(1);

    expect(JSON.parse(io.stderr())).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('missing') },
    });
  });
});
