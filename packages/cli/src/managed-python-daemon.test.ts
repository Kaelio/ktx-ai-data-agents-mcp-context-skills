import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readManagedPythonDaemonStatus,
  startManagedPythonDaemon,
  stopManagedPythonDaemon,
  type ManagedPythonDaemonChild,
  type ManagedPythonDaemonFetch,
  type ManagedPythonDaemonSpawn,
  type ManagedPythonDaemonState,
} from './managed-python-daemon.js';
import type {
  InstalledKtxRuntimeManifest,
  ManagedPythonRuntimeInstallResult,
  ManagedPythonRuntimeLayout,
} from './managed-python-runtime.js';

function layout(root: string): ManagedPythonRuntimeLayout {
  return {
    cliVersion: '0.2.0',
    runtimeRoot: join(root, 'runtime'),
    versionDir: join(root, 'runtime', '0.2.0'),
    venvDir: join(root, 'runtime', '0.2.0', '.venv'),
    manifestPath: join(root, 'runtime', '0.2.0', 'manifest.json'),
    installLogPath: join(root, 'runtime', '0.2.0', 'install.log'),
    assetDir: join(root, 'assets', 'python'),
    assetManifestPath: join(root, 'assets', 'python', 'manifest.json'),
    pythonPath: join(root, 'runtime', '0.2.0', '.venv', 'bin', 'python'),
    daemonPath: join(root, 'runtime', '0.2.0', '.venv', 'bin', 'ktx-daemon'),
    daemonStatePath: join(root, 'runtime', '0.2.0', 'daemon.json'),
    daemonStdoutPath: join(root, 'runtime', '0.2.0', 'daemon.stdout.log'),
    daemonStderrPath: join(root, 'runtime', '0.2.0', 'daemon.stderr.log'),
  };
}

function manifest(root: string, features: Array<'core' | 'local-embeddings'> = ['core']): InstalledKtxRuntimeManifest {
  const runtimeLayout = layout(root);
  return {
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
    features,
    python: {
      executable: runtimeLayout.pythonPath,
      daemonExecutable: runtimeLayout.daemonPath,
    },
    installLog: runtimeLayout.installLogPath,
  };
}

function installResult(root: string, features: Array<'core' | 'local-embeddings'> = ['core']): ManagedPythonRuntimeInstallResult {
  return {
    status: 'ready',
    layout: layout(root),
    asset: {
      manifest: manifest(root, features).asset,
      wheelPath: join(root, 'assets', 'python', 'kaelio_ktx-0.2.0-py3-none-any.whl'),
    },
    manifest: manifest(root, features),
  };
}

function makeFetch(version = '0.2.0'): ManagedPythonDaemonFetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'healthy', version }),
    text: async () => '',
  }));
}

function makeSpawn(pid = 4242): ManagedPythonDaemonSpawn {
  return vi.fn((_command, _args, _options): ManagedPythonDaemonChild => ({
    pid,
    unref: vi.fn(),
  }));
}

function runningState(root: string, overrides: Partial<ManagedPythonDaemonState> = {}): ManagedPythonDaemonState {
  const runtimeLayout = layout(root);
  return {
    schemaVersion: 1,
    pid: 4242,
    host: '127.0.0.1',
    port: 58731,
    version: '0.2.0',
    features: ['core'],
    startedAt: '2026-05-11T00:00:00.000Z',
    stdoutLog: runtimeLayout.daemonStdoutPath,
    stderrLog: runtimeLayout.daemonStderrPath,
    ...overrides,
  };
}

describe('managed Python daemon lifecycle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-managed-daemon-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports stopped when no daemon state exists', async () => {
    const status = await readManagedPythonDaemonStatus({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      processAlive: vi.fn(() => false),
      fetch: makeFetch(),
    });

    expect(status.kind).toBe('stopped');
    expect(status.detail).toContain('No daemon state');
  });

  it('starts ktx-daemon serve-http, waits for health, and writes state', async () => {
    const spawnDaemon = makeSpawn(5555);
    const installRuntime = vi.fn(async () => installResult(tempDir));

    const result = await startManagedPythonDaemon({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      features: ['core'],
      installRuntime,
      spawnDaemon,
      fetch: makeFetch(),
      allocatePort: vi.fn(async () => 61234),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('started');
    expect(result.baseUrl).toBe('http://127.0.0.1:61234');
    expect(installRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      features: ['core'],
      force: false,
    });
    expect(spawnDaemon).toHaveBeenCalledWith(
      layout(tempDir).daemonPath,
      ['serve-http', '--host', '127.0.0.1', '--port', '61234'],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ KTX_DAEMON_VERSION: '0.2.0' }),
      }),
    );
    expect(JSON.parse(await readFile(layout(tempDir).daemonStatePath, 'utf8'))).toMatchObject({
      pid: 5555,
      port: 61234,
      version: '0.2.0',
      features: ['core'],
      stdoutLog: layout(tempDir).daemonStdoutPath,
      stderrLog: layout(tempDir).daemonStderrPath,
    });
  });

  it('makes a final health probe before reporting startup failure', async () => {
    const spawnDaemon = makeSpawn(5556);
    const installRuntime = vi.fn(async () => installResult(tempDir));
    const fetch = vi
      .fn<ManagedPythonDaemonFetch>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'healthy', version: '0.2.0' }),
        text: async () => '',
      });

    const result = await startManagedPythonDaemon({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      features: ['core'],
      installRuntime,
      spawnDaemon,
      fetch,
      allocatePort: vi.fn(async () => 61234),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      startupTimeoutMs: 5,
      pollIntervalMs: 20,
    });

    expect(result.status).toBe('started');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(layout(tempDir).daemonStatePath, 'utf8'))).toMatchObject({
      pid: 5556,
      port: 61234,
      version: '0.2.0',
    });
  });

  it('reuses a healthy daemon with the requested feature set', async () => {
    await mkdir(layout(tempDir).versionDir, { recursive: true });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(runningState(tempDir), null, 2)}\n`);
    const spawnDaemon = makeSpawn(9999);

    const result = await startManagedPythonDaemon({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon,
      fetch: makeFetch(),
      processAlive: vi.fn(() => true),
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('reused');
    expect(result.baseUrl).toBe('http://127.0.0.1:58731');
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('starts a fresh daemon when the previous state is stale', async () => {
    await mkdir(layout(tempDir).versionDir, { recursive: true });
    await writeFile(
      layout(tempDir).daemonStatePath,
      `${JSON.stringify(runningState(tempDir, { version: '0.1.0' }), null, 2)}\n`,
    );

    const result = await startManagedPythonDaemon({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(6666),
      fetch: makeFetch(),
      processAlive: vi.fn(() => true),
      killProcess: vi.fn(),
      allocatePort: vi.fn(async () => 61235),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('started');
    expect(JSON.parse(await readFile(layout(tempDir).daemonStatePath, 'utf8'))).toMatchObject({
      pid: 6666,
      port: 61235,
      version: '0.2.0',
    });
  });

  it('stops a recorded daemon and removes the state file', async () => {
    await mkdir(layout(tempDir).versionDir, { recursive: true });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(runningState(tempDir), null, 2)}\n`);
    const killProcess = vi.fn();

    const result = await stopManagedPythonDaemon({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      processAlive: vi.fn(() => true),
      killProcess,
    });

    expect(result.status).toBe('stopped');
    expect(killProcess).toHaveBeenCalledWith(4242);
    await expect(readFile(layout(tempDir).daemonStatePath, 'utf8')).rejects.toThrow();
  });
});
