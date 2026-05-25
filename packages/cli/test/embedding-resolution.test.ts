import { describe, expect, it, vi } from 'vitest';
import { buildDefaultKtxProjectConfig, type KtxProjectConfig } from '../src/context/project/config.js';
import type { KtxLocalProject } from '../src/context/project/project.js';
import { resolveProjectEmbeddingProvider } from '../src/embedding-resolution.js';
import type { ManagedLocalEmbeddingsDaemon } from '../src/managed-local-embeddings.js';

function projectWithConfig(config: KtxProjectConfig): KtxLocalProject {
  return {
    projectDir: '/work/proj',
    configPath: '/work/proj/ktx.yaml',
    config,
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore: {} as KtxLocalProject['fileStore'],
  };
}

function withManagedEmbedding(config: KtxProjectConfig, base_url?: string): KtxProjectConfig {
  return {
    ...config,
    ingest: {
      ...config.ingest,
      embeddings: {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        ...(base_url === undefined
          ? {}
          : { sentenceTransformers: { base_url, pathPrefix: '' } }),
      },
    },
  };
}

const noopIo = {
  stdout: { write: (_chunk: string) => {} },
  stderr: { write: (_chunk: string) => {} },
} as const;

const fakeDaemon: ManagedLocalEmbeddingsDaemon = {
  baseUrl: 'http://127.0.0.1:51234',
  stdoutLog: '/tmp/o',
  stderrLog: '/tmp/e',
};

describe('resolveProjectEmbeddingProvider', () => {
  it('returns disabled when backend is none', async () => {
    const project = projectWithConfig(buildDefaultKtxProjectConfig());
    const result = await resolveProjectEmbeddingProvider(project, {
      mode: 'use-if-running',
      cliVersion: '0.5.0',
      io: noopIo,
    });
    expect(result.kind).toBe('disabled');
  });

  it('returns a configured provider when base_url is explicit', async () => {
    const project = projectWithConfig(withManagedEmbedding(buildDefaultKtxProjectConfig(), 'http://my-st:8080'));
    const createKtxEmbeddingProvider = vi.fn(() => ({ id: 'fake' }) as never);
    const result = await resolveProjectEmbeddingProvider(project, {
      mode: 'use-if-running',
      cliVersion: '0.5.0',
      io: noopIo,
      createKtxEmbeddingProvider,
    });
    expect(result.kind).toBe('configured');
    expect(createKtxEmbeddingProvider).toHaveBeenCalledOnce();
  });

  it('connects to the running managed daemon when base_url is omitted', async () => {
    const project = projectWithConfig(withManagedEmbedding(buildDefaultKtxProjectConfig(), undefined));
    const tryUseManaged = vi.fn(async () => fakeDaemon);
    const createKtxEmbeddingProvider = vi.fn(() => ({ id: 'fake' }) as never);
    const ensureManaged = vi.fn(async () => fakeDaemon);
    const result = await resolveProjectEmbeddingProvider(project, {
      mode: 'use-if-running',
      cliVersion: '0.5.0',
      io: noopIo,
      createKtxEmbeddingProvider,
      tryUseManagedDaemon: tryUseManaged,
      ensureManagedDaemon: ensureManaged,
    });
    expect(result.kind).toBe('managed-running');
    expect(tryUseManaged).toHaveBeenCalledOnce();
    expect(ensureManaged).not.toHaveBeenCalled();
  });

  it('passes pathPrefix="" to the embedding provider when targeting the managed daemon', async () => {
    const project = projectWithConfig(withManagedEmbedding(buildDefaultKtxProjectConfig(), undefined));
    const tryUseManaged = vi.fn(async () => fakeDaemon);
    const createKtxEmbeddingProvider = vi.fn(() => ({ id: 'fake' }) as never);
    await resolveProjectEmbeddingProvider(project, {
      mode: 'use-if-running',
      cliVersion: '0.5.0',
      io: noopIo,
      createKtxEmbeddingProvider,
      tryUseManagedDaemon: tryUseManaged,
    });
    expect(createKtxEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        sentenceTransformers: expect.objectContaining({
          baseURL: fakeDaemon.baseUrl,
          pathPrefix: '',
        }),
      }),
    );
  });

  it('returns managed-unavailable when no daemon is running and mode is use-if-running', async () => {
    const project = projectWithConfig(withManagedEmbedding(buildDefaultKtxProjectConfig(), ''));
    const tryUseManaged = vi.fn(async () => null);
    const ensureManaged = vi.fn(async () => fakeDaemon);
    const result = await resolveProjectEmbeddingProvider(project, {
      mode: 'use-if-running',
      cliVersion: '0.5.0',
      io: noopIo,
      tryUseManagedDaemon: tryUseManaged,
      ensureManagedDaemon: ensureManaged,
    });
    expect(result.kind).toBe('managed-unavailable');
    expect(ensureManaged).not.toHaveBeenCalled();
  });

  it('starts the managed daemon when mode is ensure', async () => {
    const project = projectWithConfig(withManagedEmbedding(buildDefaultKtxProjectConfig(), undefined));
    const tryUseManaged = vi.fn(async () => null);
    const ensureManaged = vi.fn(async () => fakeDaemon);
    const createKtxEmbeddingProvider = vi.fn(() => ({ id: 'fake' }) as never);
    const result = await resolveProjectEmbeddingProvider(project, {
      mode: 'ensure',
      installPolicy: 'auto',
      cliVersion: '0.5.0',
      io: noopIo,
      createKtxEmbeddingProvider,
      tryUseManagedDaemon: tryUseManaged,
      ensureManagedDaemon: ensureManaged,
    });
    expect(result.kind).toBe('managed-started');
    expect(ensureManaged).toHaveBeenCalledWith({
      cliVersion: '0.5.0',
      projectDir: '/work/proj',
      installPolicy: 'auto',
      io: noopIo,
    });
  });
});
