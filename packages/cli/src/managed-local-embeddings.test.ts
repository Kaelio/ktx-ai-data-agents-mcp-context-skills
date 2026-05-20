import { describe, expect, it, vi } from 'vitest';
import { MANAGED_SENTENCE_TRANSFORMERS_BASE_URL } from '@ktx/context';
import {
  ensureManagedLocalEmbeddingsDaemon,
  managedLocalEmbeddingHealthConfig,
  managedLocalEmbeddingProjectConfig,
} from './managed-local-embeddings.js';
import type { ManagedPythonCommandRuntime } from './managed-python-command.js';
import type { ManagedPythonDaemonStartResult } from './managed-python-daemon.js';

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

function runtime(): ManagedPythonCommandRuntime {
  return {
    layout: {
      cliVersion: '0.2.0',
      runtimeRoot: '/runtime',
      versionDir: '/runtime/0.2.0',
      venvDir: '/runtime/0.2.0/.venv',
      manifestPath: '/runtime/0.2.0/manifest.json',
      installLogPath: '/runtime/0.2.0/install.log',
      assetDir: '/assets/python',
      assetManifestPath: '/assets/python/manifest.json',
      pythonPath: '/runtime/0.2.0/.venv/bin/python',
      daemonPath: '/runtime/0.2.0/.venv/bin/ktx-daemon',
    },
    manifest: {
      schemaVersion: 1,
      cliVersion: '0.2.0',
      installedAt: '2026-05-11T00:00:00.000Z',
      asset: {
        schemaVersion: 1,
        distributionName: 'kaelio-ktx',
        normalizedName: 'kaelio_ktx',
        version: '0.2.0',
        wheel: {
          file: 'kaelio_ktx-0.2.0-py3-none-any.whl',
          sha256: 'a'.repeat(64),
          bytes: 123,
        },
      },
      features: ['core', 'local-embeddings'],
      python: {
        executable: '/runtime/0.2.0/.venv/bin/python',
        daemonExecutable: '/runtime/0.2.0/.venv/bin/ktx-daemon',
      },
      installLog: '/runtime/0.2.0/install.log',
    },
  };
}

function daemonResult(status: 'started' | 'reused' = 'reused'): ManagedPythonDaemonStartResult {
  return {
    status,
    layout: {
      ...runtime().layout,
      projectDir: '/work/proj',
      daemonStateDir: '/work/proj/.ktx/runtime',
      daemonStatePath: '/work/proj/.ktx/runtime/daemon.json',
      daemonStdoutPath: '/work/proj/.ktx/runtime/daemon.stdout.log',
      daemonStderrPath: '/work/proj/.ktx/runtime/daemon.stderr.log',
    },
    baseUrl: 'http://127.0.0.1:61234',
    state: {
      schemaVersion: 1,
      pid: 12345,
      host: '127.0.0.1',
      port: 61234,
      version: '0.2.0',
      features: ['core', 'local-embeddings'],
      startedAt: '2026-05-11T00:00:00.000Z',
      stdoutLog: '/work/proj/.ktx/runtime/daemon.stdout.log',
      stderrLog: '/work/proj/.ktx/runtime/daemon.stderr.log',
    },
  };
}

describe('managedLocalEmbeddingProjectConfig', () => {
  it('uses a stable managed runtime marker instead of a random daemon port', () => {
    expect(
      managedLocalEmbeddingProjectConfig({
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
      }),
    ).toEqual({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: {
        base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
        pathPrefix: '',
      },
    });
  });
});

describe('managedLocalEmbeddingHealthConfig', () => {
  it('uses the active managed daemon URL for the immediate health check', () => {
    expect(
      managedLocalEmbeddingHealthConfig({
        baseUrl: 'http://127.0.0.1:61234',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
      }),
    ).toEqual({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
  });
});

describe('ensureManagedLocalEmbeddingsDaemon', () => {
  it('ensures the local-embeddings feature and starts the managed daemon', async () => {
    const io = makeIo();
    const ensureRuntime = vi.fn(async () => runtime());
    const startDaemon = vi.fn(async () => daemonResult('started'));

    await expect(
      ensureManagedLocalEmbeddingsDaemon({
        cliVersion: '0.2.0',
        projectDir: '/work/proj',
        installPolicy: 'auto',
        io: io.io,
        ensureRuntime,
        startDaemon,
      }),
    ).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:61234',
      stdoutLog: '/work/proj/.ktx/runtime/daemon.stdout.log',
      stderrLog: '/work/proj/.ktx/runtime/daemon.stderr.log',
    });

    expect(ensureRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
      feature: 'local-embeddings',
    });
    expect(startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      features: ['local-embeddings'],
      force: false,
    });
    expect(io.stderr()).toContain('Started KTX local embeddings daemon: http://127.0.0.1:61234');
  });

  it('reuses an already running daemon without reporting a new start', async () => {
    const io = makeIo();

    await ensureManagedLocalEmbeddingsDaemon({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      installPolicy: 'prompt',
      io: io.io,
      ensureRuntime: vi.fn(async () => runtime()),
      startDaemon: vi.fn(async () => daemonResult('reused')),
    });

    expect(io.stderr()).toContain('Using KTX local embeddings daemon: http://127.0.0.1:61234');
  });
});
