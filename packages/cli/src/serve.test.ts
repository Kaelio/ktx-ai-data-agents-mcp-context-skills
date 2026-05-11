import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceAdapter } from '@ktx/context/ingest';
import { initKtxProject } from '@ktx/context/project';
import { describe, expect, it, vi } from 'vitest';
import { runKtxServeStdio } from './serve.js';

function makeManagedRuntimeIo() {
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

describe('runKtxServeStdio', () => {
  it('loads the project, creates local ports, and connects the server to stdio', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const project = {
      projectDir: '/tmp/ktx-project',
      config: {
        connections: {},
        llm: {
          provider: { backend: 'gateway' },
          models: { default: 'anthropic/claude-sonnet' },
        },
      },
    } as never;
    const loadProject = vi.fn().mockResolvedValue(project);
    const contextTools = { connections: { list: vi.fn() } };
    const createContextTools = vi.fn().mockReturnValue(contextTools);
    const createServer = vi.fn().mockReturnValue({ connect });
    const createTransport = vi.fn().mockReturnValue({ kind: 'stdio' });
    let stderr = '';

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: false,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: undefined,
          executeQueries: false,
          memoryCapture: false,
          memoryModel: undefined,
        },
        {
          loadProject,
          createContextTools,
          createServer,
          createTransport,
          stderr: { write: (chunk: string) => (stderr += chunk) },
        },
      ),
    ).resolves.toBe(0);

    expect(loadProject).toHaveBeenCalledWith({ projectDir: '/tmp/ktx-project' });
    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        localIngest: expect.objectContaining({
          adapters: expect.any(Array),
        }),
        localScan: expect.objectContaining({
          adapters: expect.any(Array),
        }),
      }),
    );
    expect(createServer).toHaveBeenCalledWith({
      name: 'ktx',
      version: '0.0.0-private',
      userContext: { userId: 'agent' },
      contextTools,
      memoryCapture: undefined,
    });
    expect(connect).toHaveBeenCalledWith({ kind: 'stdio' });
    expect(stderr).toContain('ktx MCP server running on stdio for /tmp/ktx-project');
  });

  it('enables local ingest ports by default when serving stdio', async () => {
    const project = { projectDir: '/tmp/ktx-project', config: { connections: {} } } as never;
    const connect = vi.fn().mockResolvedValue(undefined);
    const createContextTools = vi.fn(() => ({ connections: { list: async () => [] } }));

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: false,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: undefined,
          executeQueries: false,
          memoryCapture: false,
          memoryModel: undefined,
        },
        {
          loadProject: async () => project,
          createContextTools,
          createServer: vi.fn(() => ({ connect }) as never),
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        localIngest: expect.objectContaining({
          adapters: expect.any(Array),
        }),
        localScan: expect.objectContaining({
          adapters: expect.any(Array),
        }),
      }),
    );
  });

  it('passes daemon database introspection URL to MCP local ingest adapters', async () => {
    const project = { projectDir: '/tmp/ktx-project', config: { connections: {} } } as never;
    const connect = vi.fn().mockResolvedValue(undefined);
    const createContextTools = vi.fn(() => ({ connections: { list: async () => [] } }));
    const createdAdapters: SourceAdapter[] = [];
    const createIngestAdapters = vi.fn(() => createdAdapters);

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: false,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: 'http://127.0.0.1:8765',
          executeQueries: false,
          memoryCapture: false,
          memoryModel: undefined,
        },
        {
          loadProject: async () => project,
          createContextTools,
          createIngestAdapters,
          createServer: vi.fn(() => ({ connect }) as never),
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        localIngest: expect.objectContaining({
          adapters: expect.any(Array),
        }),
        localScan: expect.objectContaining({
          adapters: createdAdapters,
          databaseIntrospectionUrl: 'http://127.0.0.1:8765',
        }),
      }),
    );
    expect(createIngestAdapters).toHaveBeenCalledWith(project, {
      databaseIntrospectionUrl: 'http://127.0.0.1:8765',
    });
  });

  it('uses CLI-native local ingest adapters for standalone scan tools', async () => {
    const project = { projectDir: '/tmp/ktx-project', config: { connections: {} } } as never;
    const createContextTools = vi.fn(() => ({}) as never);

    await runKtxServeStdio(
      {
        mcp: 'stdio',
        projectDir: '/tmp/ktx-project',
        userId: 'local',
        semanticCompute: false,
        executeQueries: false,
        memoryCapture: false,
      },
      {
        loadProject: vi.fn(async () => project),
        createContextTools,
        createServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) }) as never),
        createTransport: vi.fn(() => ({}) as never),
        stderr: { write: vi.fn() },
      },
    );

    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        localIngest: expect.objectContaining({ adapters: expect.any(Array) }),
        localScan: expect.objectContaining({ adapters: expect.any(Array) }),
      }),
    );
  });

  it('passes semantic compute to local project ports when enabled', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-serve-'));
    try {
      const project = await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
      const createContextTools = vi.fn(() => ({ connections: { list: async () => [] } }));
      const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };

      await expect(
        runKtxServeStdio(
          {
            mcp: 'stdio',
            projectDir: project.projectDir,
            userId: 'local',
            semanticCompute: true,
            semanticComputeUrl: undefined,
            databaseIntrospectionUrl: undefined,
            executeQueries: false,
            memoryCapture: false,
            memoryModel: undefined,
          },
          {
            loadProject: async () => project,
            createContextTools,
            createSemanticLayerCompute: () => semanticLayerCompute,
            createServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) }) as never),
            createTransport: vi.fn(() => ({}) as never),
            stderr: { write: vi.fn() },
          },
        ),
      ).resolves.toBe(0);

      expect(createContextTools).toHaveBeenCalledWith(
        project,
        expect.objectContaining({
          semanticLayerCompute,
          localIngest: expect.objectContaining({
            adapters: expect.any(Array),
            semanticLayerCompute,
          }),
          localScan: expect.objectContaining({
            adapters: expect.any(Array),
          }),
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses managed semantic compute when MCP semantic compute has no explicit HTTP URL', async () => {
    const project = { projectDir: '/tmp/ktx-project', config: { connections: {} } } as never;
    const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const createManagedSemanticLayerCompute = vi.fn(async () => semanticLayerCompute);
    const createContextTools = vi.fn(() => ({ connections: { list: async () => [] } }));
    const managedRuntimeIo = makeManagedRuntimeIo();

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: true,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: undefined,
          executeQueries: false,
          memoryCapture: false,
          memoryModel: undefined,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        {
          loadProject: async () => project,
          createContextTools,
          createManagedSemanticLayerCompute,
          managedRuntimeIo: managedRuntimeIo.io,
          createServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) }) as never),
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    expect(createManagedSemanticLayerCompute).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: managedRuntimeIo.io,
    });
    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        semanticLayerCompute,
      }),
    );
  });

  it('uses the HTTP semantic compute port when a daemon URL is provided', async () => {
    const project = { projectDir: '/tmp/ktx-project', config: { connections: {} } } as never;
    const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const createHttpSemanticLayerCompute = vi.fn(() => semanticLayerCompute);
    const createContextTools = vi.fn(() => ({ connections: { list: async () => [] } }));

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: true,
          semanticComputeUrl: 'http://127.0.0.1:8765',
          databaseIntrospectionUrl: undefined,
          executeQueries: false,
          memoryCapture: false,
          memoryModel: undefined,
        },
        {
          loadProject: async () => project,
          createContextTools,
          createHttpSemanticLayerCompute,
          createServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) }) as never),
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    expect(createHttpSemanticLayerCompute).toHaveBeenCalledWith('http://127.0.0.1:8765');
    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        semanticLayerCompute,
      }),
    );
  });

  it('passes a query executor to local project ports only when query execution is enabled', async () => {
    const project = { projectDir: '/tmp/ktx-project', config: { connections: {} } } as never;
    const connect = vi.fn().mockResolvedValue(undefined);
    const createContextTools = vi.fn(() => ({ connections: { list: async () => [] } }));
    const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const queryExecutor = { execute: vi.fn() };

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: true,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: undefined,
          executeQueries: true,
          memoryCapture: false,
          memoryModel: undefined,
        },
        {
          loadProject: async () => project,
          createContextTools,
          createSemanticLayerCompute: () => semanticLayerCompute,
          createQueryExecutor: () => queryExecutor,
          createServer: vi.fn(() => ({ connect }) as never),
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    expect(createContextTools).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        semanticLayerCompute,
        queryExecutor,
        localIngest: expect.objectContaining({
          adapters: expect.any(Array),
          semanticLayerCompute,
          queryExecutor,
        }),
        localScan: expect.objectContaining({
          adapters: expect.any(Array),
        }),
      }),
    );
  });

  it('creates a local memory capture port when memory capture is enabled', async () => {
    const project = {
      projectDir: '/tmp/ktx-project',
      config: {
        connections: {},
        llm: {
          provider: { backend: 'gateway' },
          models: { default: 'anthropic/claude-sonnet' },
        },
      },
    } as never;
    const connect = vi.fn().mockResolvedValue(undefined);
    const contextTools = { connections: { list: vi.fn() } };
    const memoryCapture = { capture: vi.fn(), status: vi.fn() };
    const createContextTools = vi.fn().mockReturnValue(contextTools);
    const createMemoryCapture = vi.fn().mockReturnValue(memoryCapture);
    const createServer = vi.fn().mockReturnValue({ connect });

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: false,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: undefined,
          executeQueries: false,
          memoryCapture: true,
          memoryModel: 'anthropic/claude-sonnet',
        },
        {
          loadProject: async () => project,
          createContextTools,
          createMemoryCapture,
          createServer,
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    expect(createMemoryCapture).toHaveBeenCalledWith(project, {
      llmProvider: expect.objectContaining({ getModel: expect.any(Function) }),
      semanticLayerCompute: undefined,
    });
    expect(createServer).toHaveBeenCalledWith({
      name: 'ktx',
      version: '0.0.0-private',
      userContext: { userId: 'agent' },
      contextTools,
      memoryCapture,
    });
  });

  it('reuses semantic compute for local memory capture when enabled', async () => {
    const project = {
      projectDir: '/tmp/ktx-project',
      config: {
        connections: {},
        llm: {
          provider: { backend: 'gateway' },
          models: { default: 'openai/gpt' },
        },
      },
    } as never;
    const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const createMemoryCapture = vi.fn().mockReturnValue({ capture: vi.fn(), status: vi.fn() });

    await expect(
      runKtxServeStdio(
        {
          mcp: 'stdio',
          projectDir: '/tmp/ktx-project',
          userId: 'agent',
          semanticCompute: true,
          semanticComputeUrl: undefined,
          databaseIntrospectionUrl: undefined,
          executeQueries: false,
          memoryCapture: true,
          memoryModel: 'openai/gpt',
        },
        {
          loadProject: async () => project,
          createContextTools: vi.fn(() => ({ connections: { list: async () => [] } })),
          createSemanticLayerCompute: () => semanticLayerCompute,
          createMemoryCapture,
          createServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) }) as never),
          createTransport: vi.fn(() => ({}) as never),
          stderr: { write: vi.fn() },
        },
      ),
    ).resolves.toBe(0);

    expect(createMemoryCapture).toHaveBeenCalledWith(project, {
      llmProvider: expect.objectContaining({ getModel: expect.any(Function) }),
      semanticLayerCompute,
    });
  });
});
