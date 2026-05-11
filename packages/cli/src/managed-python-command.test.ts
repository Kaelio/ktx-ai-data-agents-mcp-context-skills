import { describe, expect, it, vi } from 'vitest';
import {
  createManagedPythonSemanticLayerComputePort,
  managedRuntimeInstallCommand,
} from './managed-python-command.js';
import type {
  InstalledKtxRuntimeManifest,
  KtxRuntimeFeature,
  ManagedPythonRuntimeInstallResult,
  ManagedPythonRuntimeLayout,
  ManagedPythonRuntimeStatus,
} from './managed-python-runtime.js';

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

function layout(): ManagedPythonRuntimeLayout {
  return {
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
  };
}

function manifest(features: KtxRuntimeFeature[] = ['core']): InstalledKtxRuntimeManifest {
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
      executable: '/runtime/0.2.0/.venv/bin/python',
      daemonExecutable: '/runtime/0.2.0/.venv/bin/ktx-daemon',
    },
    installLog: '/runtime/0.2.0/install.log',
  };
}

function readyStatus(features: KtxRuntimeFeature[] = ['core']): ManagedPythonRuntimeStatus {
  return {
    kind: 'ready',
    detail: 'Runtime ready at /runtime/0.2.0',
    layout: layout(),
    manifest: manifest(features),
  };
}

function missingStatus(): ManagedPythonRuntimeStatus {
  return {
    kind: 'missing',
    detail: 'No runtime manifest at /runtime/0.2.0/manifest.json',
    layout: layout(),
  };
}

function installResult(features: KtxRuntimeFeature[] = ['core']): ManagedPythonRuntimeInstallResult {
  const installedManifest = manifest(features);
  return {
    status: 'installed',
    layout: layout(),
    asset: {
      manifest: installedManifest.asset,
      wheelPath: '/assets/python/kaelio_ktx-0.2.0-py3-none-any.whl',
    },
    manifest: installedManifest,
  };
}

describe('managedRuntimeInstallCommand', () => {
  it('prints the exact command for each managed runtime feature', () => {
    expect(managedRuntimeInstallCommand('core')).toBe('ktx runtime install --yes');
    expect(managedRuntimeInstallCommand('local-embeddings')).toBe(
      'ktx runtime install --feature local-embeddings --yes',
    );
  });
});

describe('createManagedPythonSemanticLayerComputePort', () => {
  it('uses the managed ktx-daemon executable when the runtime is ready', async () => {
    const io = makeIo();
    const compute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const createPythonCompute = vi.fn(() => compute);

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'never',
        io: io.io,
        readStatus: vi.fn(async () => readyStatus()),
        installRuntime: vi.fn(),
        createPythonCompute,
      }),
    ).resolves.toBe(compute);

    expect(createPythonCompute).toHaveBeenCalledWith({
      command: '/runtime/0.2.0/.venv/bin/ktx-daemon',
      args: [],
    });
    expect(io.stderr()).toBe('');
  });

  it('fails with a preparation command when input is disabled and the runtime is missing', async () => {
    const io = makeIo();
    const installRuntime = vi.fn();

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'never',
        io: io.io,
        readStatus: vi.fn(async () => missingStatus()),
        installRuntime,
      }),
    ).rejects.toThrow('KTX Python runtime is required for this command. Run: ktx runtime install --yes');

    expect(installRuntime).not.toHaveBeenCalled();
  });

  it('installs the core runtime without prompting when policy is auto', async () => {
    const io = makeIo();
    const compute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const createPythonCompute = vi.fn(() => compute);
    const installRuntime = vi.fn(async () => installResult());

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'auto',
        io: io.io,
        readStatus: vi.fn(async () => missingStatus()),
        installRuntime,
        createPythonCompute,
      }),
    ).resolves.toBe(compute);

    expect(installRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      features: ['core'],
      force: false,
    });
    expect(io.stderr()).toContain('Installing KTX Python runtime (core) with uv');
    expect(io.stderr()).toContain('KTX Python runtime ready: /runtime/0.2.0');
  });

  it('prompts before installing when policy is prompt', async () => {
    const io = makeIo();
    const confirmInstall = vi.fn(async () => true);
    const installRuntime = vi.fn(async () => installResult());

    await createManagedPythonSemanticLayerComputePort({
      cliVersion: '0.2.0',
      installPolicy: 'prompt',
      io: io.io,
      readStatus: vi.fn(async () => missingStatus()),
      installRuntime,
      createPythonCompute: vi.fn(() => ({ query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() })),
      confirmInstall,
    });

    expect(confirmInstall).toHaveBeenCalledWith(
      'KTX needs to install the core Python runtime. This downloads Python dependencies with uv. Continue?',
    );
    expect(installRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      features: ['core'],
      force: false,
    });
  });
});
