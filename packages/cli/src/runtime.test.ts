import { describe, expect, it, vi } from 'vitest';
import type {
  ManagedPythonDaemonStopAllResult,
  ManagedPythonDaemonStartResult,
  ManagedPythonDaemonStopResult,
} from './managed-python-daemon.js';
import type {
  ManagedPythonRuntimeDoctorCheck,
  ManagedPythonRuntimeInstallResult,
  ManagedPythonRuntimeStatus,
} from './managed-python-runtime.js';
import { runKtxRuntime, type KtxRuntimeDeps } from './runtime.js';

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

describe('runKtxRuntime', () => {
  it('installs the requested runtime feature and prints the manifest path', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      installRuntime: vi.fn(async (): Promise<ManagedPythonRuntimeInstallResult> => ({
        status: 'installed',
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
        asset: {
          wheelPath: '/assets/python/kaelio_ktx-0.1.0-py3-none-any.whl',
          manifest: {
            schemaVersion: 1,
            distributionName: 'kaelio-ktx',
            normalizedName: 'kaelio_ktx',
            version: '0.1.0',
            wheel: {
              file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
              sha256: 'a'.repeat(64),
              bytes: 10,
            },
          },
        },
        manifest: {
          schemaVersion: 1,
          cliVersion: '0.2.0',
          installedAt: '2026-05-11T00:00:00.000Z',
          asset: {
            schemaVersion: 1,
            distributionName: 'kaelio-ktx',
            normalizedName: 'kaelio_ktx',
            version: '0.1.0',
            wheel: {
              file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
              sha256: 'a'.repeat(64),
              bytes: 10,
            },
          },
          features: ['core', 'local-embeddings'],
          python: {
            executable: '/runtime/0.2.0/.venv/bin/python',
            daemonExecutable: '/runtime/0.2.0/.venv/bin/ktx-daemon',
          },
          installLog: '/runtime/0.2.0/install.log',
        },
      })),
    };

    await expect(
      runKtxRuntime(
        { command: 'install', cliVersion: '0.2.0', feature: 'local-embeddings', force: true },
        io.io,
        deps,
      ),
    ).resolves.toBe(0);

    expect(deps.installRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      features: ['local-embeddings'],
      force: true,
    });
    expect(io.stdout()).toContain('Installed KTX Python runtime');
    expect(io.stdout()).toContain('features: core, local-embeddings');
    expect(io.stdout()).toContain('manifest: /runtime/0.2.0/manifest.json');
    expect(io.stderr()).toBe('');
  });

  it('starts the managed Python daemon and prints the base URL', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      startDaemon: vi.fn(async (): Promise<ManagedPythonDaemonStartResult> => ({
        status: 'started',
        baseUrl: 'http://127.0.0.1:61234',
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
          projectDir: '/work/proj',
          daemonStateDir: '/work/proj/.ktx/runtime',
          daemonStatePath: '/work/proj/.ktx/runtime/daemon.json',
          daemonStdoutPath: '/work/proj/.ktx/runtime/daemon.stdout.log',
          daemonStderrPath: '/work/proj/.ktx/runtime/daemon.stderr.log',
        },
        state: {
          schemaVersion: 1,
          pid: 4242,
          host: '127.0.0.1',
          port: 61234,
          version: '0.2.0',
          features: ['core', 'local-embeddings'],
          startedAt: '2026-05-11T00:00:00.000Z',
          stdoutLog: '/work/proj/.ktx/runtime/daemon.stdout.log',
          stderrLog: '/work/proj/.ktx/runtime/daemon.stderr.log',
        },
      })),
    };

    await expect(
      runKtxRuntime(
        { command: 'start', cliVersion: '0.2.0', projectDir: '/work/proj', feature: 'local-embeddings', force: true },
        io.io,
        deps,
      ),
    ).resolves.toBe(0);

    expect(deps.startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      features: ['local-embeddings'],
      force: true,
    });
    expect(io.stdout()).toContain('Started KTX Python daemon');
    expect(io.stdout()).toContain('url: http://127.0.0.1:61234');
    expect(io.stdout()).toContain('pid: 4242');
    expect(io.stdout()).toContain('features: core, local-embeddings');
    expect(io.stdout()).toContain('stderr: /work/proj/.ktx/runtime/daemon.stderr.log');
  });

  it('stops the managed Python daemon', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      stopDaemon: vi.fn(async (): Promise<ManagedPythonDaemonStopResult> => ({
        status: 'stopped',
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
          projectDir: '/work/proj',
          daemonStateDir: '/work/proj/.ktx/runtime',
          daemonStatePath: '/work/proj/.ktx/runtime/daemon.json',
          daemonStdoutPath: '/work/proj/.ktx/runtime/daemon.stdout.log',
          daemonStderrPath: '/work/proj/.ktx/runtime/daemon.stderr.log',
        },
        state: {
          schemaVersion: 1,
          pid: 4242,
          host: '127.0.0.1',
          port: 61234,
          version: '0.2.0',
          features: ['core'],
          startedAt: '2026-05-11T00:00:00.000Z',
          stdoutLog: '/work/proj/.ktx/runtime/daemon.stdout.log',
          stderrLog: '/work/proj/.ktx/runtime/daemon.stderr.log',
        },
      })),
    };

    await expect(
      runKtxRuntime({ command: 'stop', cliVersion: '0.2.0', projectDir: '/work/proj', all: false }, io.io, deps),
    ).resolves.toBe(0);

    expect(deps.stopDaemon).toHaveBeenCalledWith({ cliVersion: '0.2.0', projectDir: '/work/proj' });
    expect(io.stdout()).toContain('Stopped KTX Python daemon');
    expect(io.stdout()).toContain('pid: 4242');
  });

  it('stops all discovered Python daemons and reports the summary', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      stopAllDaemons: vi.fn(async (): Promise<ManagedPythonDaemonStopAllResult> => ({
        stopped: [
          { pid: 4242, source: 'state', url: 'http://127.0.0.1:61234', statePaths: ['/work/proj/.ktx/runtime/daemon.json'] },
          { pid: 5252, source: 'process', url: 'http://127.0.0.1:8765', statePaths: [] },
        ],
        stale: [],
        failed: [],
        scanErrors: [],
      })),
    };

    await expect(
      runKtxRuntime({ command: 'stop', cliVersion: '0.2.0', projectDir: '/work/proj', all: true }, io.io, deps),
    ).resolves.toBe(0);

    expect(deps.stopAllDaemons).toHaveBeenCalledWith({ cliVersion: '0.2.0', projectDir: '/work/proj' });
    expect(io.stdout()).toContain('Stopped 2 KTX Python daemons');
    expect(io.stdout()).toContain('pid: 4242 source: state url: http://127.0.0.1:61234');
    expect(io.stdout()).toContain('pid: 5252 source: process url: http://127.0.0.1:8765');
  });

  it('returns failure when stop all cannot stop every daemon', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      stopAllDaemons: vi.fn(async (): Promise<ManagedPythonDaemonStopAllResult> => ({
        stopped: [],
        stale: [],
        failed: [
          {
            pid: 4242,
            source: 'state',
            url: 'http://127.0.0.1:61234',
            statePaths: ['/work/proj/.ktx/runtime/daemon.json'],
            detail: 'Process still running after SIGKILL',
          },
        ],
        scanErrors: ['ps failed'],
      })),
    };

    await expect(
      runKtxRuntime({ command: 'stop', cliVersion: '0.2.0', projectDir: '/work/proj', all: true }, io.io, deps),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('Stopped 0 KTX Python daemons; failed 1');
    expect(io.stderr()).toContain('pid: 4242 source: state url: http://127.0.0.1:61234');
    expect(io.stderr()).toContain('process scan: ps failed');
  });

  it('prints runtime status and doctor checks as JSON with doctor-style exit status', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      readStatus: vi.fn(async (): Promise<ManagedPythonRuntimeStatus> => ({
        kind: 'missing',
        detail: 'No runtime manifest at /runtime/0.2.0/manifest.json',
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
      })),
      doctorRuntime: vi.fn(async (): Promise<ManagedPythonRuntimeDoctorCheck[]> => [
        { id: 'uv', label: 'uv', status: 'pass', detail: 'uv 0.9.5' },
        { id: 'asset', label: 'Bundled Python wheel', status: 'pass', detail: '/assets/python/runtime.whl' },
        {
          id: 'runtime',
          label: 'Managed Python runtime',
          status: 'fail',
          detail: 'No runtime manifest at /runtime/0.2.0/manifest.json',
          fix: 'Run: ktx dev runtime install --yes',
        },
      ]),
    };

    await expect(runKtxRuntime({ command: 'status', cliVersion: '0.2.0', json: true }, io.io, deps)).resolves.toBe(1);

    expect(JSON.parse(io.stdout())).toMatchObject({
      kind: 'missing',
      detail: 'No runtime manifest at /runtime/0.2.0/manifest.json',
      layout: { runtimeRoot: '/runtime' },
      checks: [
        { id: 'uv', status: 'pass' },
        { id: 'asset', status: 'pass' },
        { id: 'runtime', status: 'fail' },
      ],
    });
    expect(deps.readStatus).toHaveBeenCalledWith({ cliVersion: '0.2.0' });
    expect(deps.doctorRuntime).toHaveBeenCalledWith({ cliVersion: '0.2.0' });
  });

  it('prints runtime status and doctor checks in plain output', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      readStatus: vi.fn(async (): Promise<ManagedPythonRuntimeStatus> => ({
        kind: 'ready',
        detail: 'Runtime ready at /runtime/0.2.0',
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
            version: '0.1.0',
            wheel: {
              file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
              sha256: 'a'.repeat(64),
              bytes: 10,
            },
          },
          features: ['core'],
          python: {
            executable: '/runtime/0.2.0/.venv/bin/python',
            daemonExecutable: '/runtime/0.2.0/.venv/bin/ktx-daemon',
          },
          installLog: '/runtime/0.2.0/install.log',
        },
      })),
      doctorRuntime: vi.fn(async (): Promise<ManagedPythonRuntimeDoctorCheck[]> => [
        { id: 'uv', label: 'uv', status: 'pass', detail: 'uv 0.9.5' },
        { id: 'asset', label: 'Bundled Python wheel', status: 'pass', detail: '/assets/python/runtime.whl' },
        { id: 'runtime', label: 'Managed Python runtime', status: 'pass', detail: 'Runtime ready at /runtime/0.2.0' },
      ]),
    };

    await expect(runKtxRuntime({ command: 'status', cliVersion: '0.2.0', json: false }, io.io, deps)).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX Python runtime');
    expect(io.stdout()).toContain('status: ready');
    expect(io.stdout()).toContain('KTX Python runtime checks');
    expect(io.stdout()).toContain('PASS uv: uv 0.9.5');
    expect(io.stdout()).toContain('PASS Managed Python runtime: Runtime ready at /runtime/0.2.0');
    expect(io.stderr()).toBe('');
  });

  it('returns success when the installed runtime is ready but source assets are missing', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      readStatus: vi.fn(async (): Promise<ManagedPythonRuntimeStatus> => ({
        kind: 'ready',
        detail: 'Runtime ready at /runtime/0.2.0',
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
            version: '0.1.0',
            wheel: {
              file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
              sha256: 'a'.repeat(64),
              bytes: 10,
            },
          },
          features: ['core'],
          python: {
            executable: '/runtime/0.2.0/.venv/bin/python',
            daemonExecutable: '/runtime/0.2.0/.venv/bin/ktx-daemon',
          },
          installLog: '/runtime/0.2.0/install.log',
        },
      })),
      doctorRuntime: vi.fn(async (): Promise<ManagedPythonRuntimeDoctorCheck[]> => [
        { id: 'uv', label: 'uv', status: 'pass', detail: 'uv 0.9.5' },
        {
          id: 'asset',
          label: 'Bundled Python wheel',
          status: 'fail',
          detail: 'Missing bundled Python runtime manifest: /assets/python/manifest.json',
          fix: 'Run: pnpm run artifacts:check',
        },
        { id: 'runtime', label: 'Managed Python runtime', status: 'pass', detail: 'Runtime ready at /runtime/0.2.0' },
      ]),
    };

    await expect(runKtxRuntime({ command: 'status', cliVersion: '0.2.0', json: false }, io.io, deps)).resolves.toBe(
      0,
    );

    expect(io.stdout()).toContain('status: ready');
    expect(io.stdout()).toContain('FAIL Bundled Python wheel: Missing bundled Python runtime manifest');
    expect(io.stdout()).toContain('PASS Managed Python runtime: Runtime ready at /runtime/0.2.0');
    expect(io.stderr()).toBe('');
  });
});
