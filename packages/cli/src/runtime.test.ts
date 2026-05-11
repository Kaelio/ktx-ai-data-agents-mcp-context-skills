import { describe, expect, it, vi } from 'vitest';
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
          daemonStatePath: '/runtime/0.2.0/daemon.json',
          daemonStdoutPath: '/runtime/0.2.0/daemon.stdout.log',
          daemonStderrPath: '/runtime/0.2.0/daemon.stderr.log',
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

  it('prints runtime status as JSON', async () => {
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
          daemonStatePath: '/runtime/0.2.0/daemon.json',
          daemonStdoutPath: '/runtime/0.2.0/daemon.stdout.log',
          daemonStderrPath: '/runtime/0.2.0/daemon.stderr.log',
        },
      })),
    };

    await expect(runKtxRuntime({ command: 'status', cliVersion: '0.2.0', json: true }, io.io, deps)).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      kind: 'missing',
      detail: 'No runtime manifest at /runtime/0.2.0/manifest.json',
      layout: { runtimeRoot: '/runtime' },
    });
  });

  it('returns failure for doctor when any check fails', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      doctorRuntime: vi.fn(async (): Promise<ManagedPythonRuntimeDoctorCheck[]> => [
        { id: 'uv', label: 'uv', status: 'pass', detail: 'uv 0.9.5' },
        {
          id: 'runtime',
          label: 'Managed Python runtime',
          status: 'fail',
          detail: 'No runtime manifest',
          fix: 'Run: ktx runtime install --yes',
        },
      ]),
    };

    await expect(runKtxRuntime({ command: 'doctor', cliVersion: '0.2.0', json: false }, io.io, deps)).resolves.toBe(1);

    expect(io.stdout()).toContain('PASS uv: uv 0.9.5');
    expect(io.stdout()).toContain('FAIL Managed Python runtime: No runtime manifest');
    expect(io.stdout()).toContain('Fix: Run: ktx runtime install --yes');
  });

  it('requires --yes before pruning stale runtime directories', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      pruneRuntime: vi.fn(async () => {
        throw new Error('should not prune without --yes');
      }),
    };

    await expect(runKtxRuntime({ command: 'prune', cliVersion: '0.2.0', dryRun: false, yes: false }, io.io, deps))
      .resolves.toBe(1);

    expect(io.stderr()).toContain('Refusing to prune without --yes');
    expect(deps.pruneRuntime).not.toHaveBeenCalled();
  });

  it('prints stale directories during prune dry-run', async () => {
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
          daemonStatePath: '/runtime/0.2.0/daemon.json',
          daemonStdoutPath: '/runtime/0.2.0/daemon.stdout.log',
          daemonStderrPath: '/runtime/0.2.0/daemon.stderr.log',
        },
      })),
      pruneRuntime: vi.fn(async () => ({
        runtimeRoot: '/runtime',
        stale: ['/runtime/0.1.0'],
        kept: ['/runtime/0.2.0'],
        removed: [],
      })),
    };

    await expect(runKtxRuntime({ command: 'prune', cliVersion: '0.2.0', dryRun: true, yes: false }, io.io, deps))
      .resolves.toBe(0);

    expect(io.stdout()).toContain('Stale KTX Python runtimes');
    expect(io.stdout()).toContain('/runtime/0.1.0');
  });
});
