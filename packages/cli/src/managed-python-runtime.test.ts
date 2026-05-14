import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MISSING_UV_RUNTIME_INSTALL_MESSAGE,
  doctorManagedPythonRuntime,
  installManagedPythonRuntime,
  managedPythonDaemonLayout,
  managedPythonRuntimeLayout,
  readManagedPythonRuntimeStatus,
  verifyRuntimeAsset,
  type ManagedPythonRuntimeExec,
} from './managed-python-runtime.js';

async function writeAsset(root: string, contents = 'wheel-bytes') {
  const assetDir = join(root, 'assets', 'python');
  await mkdir(assetDir, { recursive: true });
  const wheelPath = join(assetDir, 'kaelio_ktx-0.1.0-py3-none-any.whl');
  await writeFile(wheelPath, contents);
  await writeFile(
    join(assetDir, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distributionName: 'kaelio-ktx',
        normalizedName: 'kaelio_ktx',
        version: '0.1.0',
        wheel: {
          file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
          sha256: createHash('sha256').update(contents).digest('hex'),
          bytes: Buffer.byteLength(contents),
        },
      },
      null,
      2,
    )}\n`,
  );
  return { assetDir, wheelPath };
}

describe('managedPythonRuntimeLayout', () => {
  it('uses ~/.ktx/runtime as the runtime root on macOS', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'darwin',
      env: {},
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/Users/alex/.ktx/runtime');
    expect(layout.versionDir).toBe('/Users/alex/.ktx/runtime/0.2.0');
    expect(layout.venvDir).toBe('/Users/alex/.ktx/runtime/0.2.0/.venv');
    expect(layout.pythonPath).toBe('/Users/alex/.ktx/runtime/0.2.0/.venv/bin/python');
    expect(layout.daemonPath).toBe('/Users/alex/.ktx/runtime/0.2.0/.venv/bin/ktx-daemon');
    expect(layout.assetManifestPath).toBe('/repo/packages/cli/assets/python/manifest.json');
  });

  it('uses ~/.ktx/runtime on Linux too', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'linux',
      env: {},
      homeDir: '/home/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/home/alex/.ktx/runtime');
    expect(layout.versionDir).toBe('/home/alex/.ktx/runtime/0.2.0');
  });

  it('uses Scripts/*.exe layout on Windows under ~/.ktx/runtime', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'win32',
      env: {},
      homeDir: 'C:\\Users\\Alex',
      assetDir: 'C:\\repo\\packages\\cli\\assets\\python',
    });

    expect(layout.runtimeRoot).toBe('C:\\Users\\Alex/.ktx/runtime');
    expect(layout.pythonPath).toBe('C:\\Users\\Alex/.ktx/runtime/0.2.0/.venv/Scripts/python.exe');
    expect(layout.daemonPath).toBe('C:\\Users\\Alex/.ktx/runtime/0.2.0/.venv/Scripts/ktx-daemon.exe');
  });

  it('honors KTX_RUNTIME_ROOT before the default ~/.ktx/runtime', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'darwin',
      env: { KTX_RUNTIME_ROOT: '/tmp/ktx-runtime' },
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/tmp/ktx-runtime');
    expect(layout.versionDir).toBe('/tmp/ktx-runtime/0.2.0');
  });
});

describe('managedPythonDaemonLayout', () => {
  it('places daemon state, stdout, and stderr under {projectDir}/.ktx/runtime', () => {
    const layout = managedPythonDaemonLayout({
      cliVersion: '0.2.0',
      projectDir: '/work/orbit-analytics',
      platform: 'darwin',
      env: {},
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.projectDir).toBe('/work/orbit-analytics');
    expect(layout.daemonStateDir).toBe('/work/orbit-analytics/.ktx/runtime');
    expect(layout.daemonStatePath).toBe('/work/orbit-analytics/.ktx/runtime/daemon.json');
    expect(layout.daemonStdoutPath).toBe('/work/orbit-analytics/.ktx/runtime/daemon.stdout.log');
    expect(layout.daemonStderrPath).toBe('/work/orbit-analytics/.ktx/runtime/daemon.stderr.log');
  });

  it('keeps install paths under the global runtime root regardless of projectDir', () => {
    const layout = managedPythonDaemonLayout({
      cliVersion: '0.2.0',
      projectDir: '/work/orbit-analytics',
      platform: 'darwin',
      env: {},
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/Users/alex/.ktx/runtime');
    expect(layout.versionDir).toBe('/Users/alex/.ktx/runtime/0.2.0');
    expect(layout.pythonPath).toBe('/Users/alex/.ktx/runtime/0.2.0/.venv/bin/python');
  });
});

describe('verifyRuntimeAsset', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-asset-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads the manifest and verifies the wheel checksum', async () => {
    const { assetDir, wheelPath } = await writeAsset(tempDir, 'valid-wheel');

    const asset = await verifyRuntimeAsset({ assetDir });

    expect(asset.manifest.distributionName).toBe('kaelio-ktx');
    expect(asset.manifest.normalizedName).toBe('kaelio_ktx');
    expect(asset.wheelPath).toBe(wheelPath);
  });

  it('rejects a wheel whose checksum does not match the manifest', async () => {
    const { assetDir, wheelPath } = await writeAsset(tempDir, 'original');
    await writeFile(wheelPath, 'tampered');

    await expect(verifyRuntimeAsset({ assetDir })).rejects.toThrow(
      /Bundled Python runtime wheel checksum mismatch/,
    );
  });

  it('rejects an unsafe wheel filename in the manifest', async () => {
    const { assetDir } = await writeAsset(tempDir, 'valid-wheel');
    await writeFile(
      join(assetDir, 'manifest.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        distributionName: 'kaelio-ktx',
        normalizedName: 'kaelio_ktx',
        version: '0.1.0',
        wheel: {
          file: '../kaelio_ktx-0.1.0-py3-none-any.whl',
          sha256: 'a'.repeat(64),
          bytes: 1,
        },
      })}\n`,
    );

    await expect(verifyRuntimeAsset({ assetDir })).rejects.toThrow(/Unsafe runtime wheel filename/);
  });

  it('reports the source-checkout artifact command when the bundled manifest is missing', async () => {
    const assetDir = join(tempDir, 'packages', 'cli', 'assets', 'python');

    await expect(verifyRuntimeAsset({ assetDir })).rejects.toThrow(
      /Missing bundled Python runtime manifest.*pnpm run artifacts:build/s,
    );
  });
});

describe('installManagedPythonRuntime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-install-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a venv, installs the core wheel, and writes a manifest', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const commands: Array<{ command: string; args: string[] }> = [];
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => {
      commands.push({ command, args });
      return { stdout: command === 'uv' && args[0] === '--version' ? 'uv 0.9.5\n' : '', stderr: '' };
    });

    const result = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });

    expect(result.status).toBe('installed');
    expect(commands).toEqual([
      { command: 'uv', args: ['--version'] },
      { command: 'uv', args: ['venv', result.layout.venvDir] },
      {
        command: 'uv',
        args: ['pip', 'install', '--python', result.layout.pythonPath, result.asset.wheelPath],
      },
    ]);
    const manifest = JSON.parse(await readFile(result.layout.manifestPath, 'utf8')) as {
      cliVersion: string;
      features: string[];
      python: { executable: string; daemonExecutable: string };
    };
    expect(manifest.cliVersion).toBe('0.2.0');
    expect(manifest.features).toEqual(['core']);
    expect(manifest.python.executable).toBe(result.layout.pythonPath);
    expect(manifest.python.daemonExecutable).toBe(result.layout.daemonPath);
  });

  it('disables repo uv config for managed runtime uv commands', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const commands: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args, options) => {
      commands.push({ command, args, env: options?.env });
      return { stdout: command === 'uv' && args[0] === '--version' ? 'uv 0.11.13\n' : '', stderr: '' };
    });

    await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      env: { PATH: '/opt/homebrew/bin', UV_NO_CONFIG: '0' },
      features: ['core'],
      exec,
    });

    expect(commands.map((call) => [call.command, call.args[0], call.env?.UV_NO_CONFIG, call.env?.PATH])).toEqual([
      ['uv', '--version', '1', '/opt/homebrew/bin'],
      ['uv', 'venv', '1', '/opt/homebrew/bin'],
      ['uv', 'pip', '1', '/opt/homebrew/bin'],
    ]);
  });

  it('installs the local-embeddings extra when requested', async () => {
    const { assetDir } = await writeAsset(tempDir, 'embedding-wheel');
    const commands: Array<{ command: string; args: string[] }> = [];
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => {
      commands.push({ command, args });
      return { stdout: command === 'uv' && args[0] === '--version' ? 'uv 0.9.5\n' : '', stderr: '' };
    });

    const result = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['local-embeddings'],
      exec,
    });

    expect(commands.at(-1)).toEqual({
      command: 'uv',
      args: ['pip', 'install', '--python', result.layout.pythonPath, `${result.asset.wheelPath}[local-embeddings]`],
    });
    const manifest = JSON.parse(await readFile(result.layout.manifestPath, 'utf8')) as { features: string[] };
    expect(manifest.features).toEqual(['core', 'local-embeddings']);
  });

  it('fails with the hard-prerequisite message when uv is missing', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const commands: Array<{ command: string; args: string[] }> = [];
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => {
      commands.push({ command, args });
      throw new Error('spawn uv ENOENT');
    });

    await expect(
      installManagedPythonRuntime({
        cliVersion: '0.2.0',
        runtimeRoot: join(tempDir, 'runtime'),
        assetDir,
        features: ['core'],
        exec,
      }),
    ).rejects.toThrow(MISSING_UV_RUNTIME_INSTALL_MESSAGE);

    expect(commands).toEqual([{ command: 'uv', args: ['--version'] }]);
  });

  it('reuses an existing compatible runtime when force is false', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => ({
      stdout: command === 'uv' && args[0] === '--version' ? 'uv 0.9.5\n' : '',
      stderr: '',
    }));

    const first = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });
    await mkdir(join(first.layout.venvDir, 'bin'), { recursive: true });
    await writeFile(first.layout.pythonPath, '#!/usr/bin/env python\n');
    await writeFile(first.layout.daemonPath, '#!/usr/bin/env python\n');

    const second = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });

    expect(second.status).toBe('ready');
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('keeps failed install logs in the versioned runtime directory', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => {
      if (command === 'uv' && args[0] === 'venv') {
        throw Object.assign(new Error('uv venv failed'), { stdout: 'creating\n', stderr: 'bad python\n' });
      }
      return { stdout: command === 'uv' && args[0] === '--version' ? 'uv 0.9.5\n' : '', stderr: '' };
    });

    await expect(
      installManagedPythonRuntime({
        cliVersion: '0.2.0',
        runtimeRoot: join(tempDir, 'runtime'),
        assetDir,
        features: ['core'],
        exec,
      }),
    ).rejects.toThrow(/Python runtime install failed/);

    const log = await readFile(join(tempDir, 'runtime', '0.2.0', 'install.log'), 'utf8');
    expect(log).toContain('$ uv venv');
    expect(log).toContain('bad python');
  });
});

describe('readManagedPythonRuntimeStatus', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-status-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports missing before install', async () => {
    const status = await readManagedPythonRuntimeStatus({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir: join(tempDir, 'assets', 'python'),
    });

    expect(status.kind).toBe('missing');
    expect(status.detail).toContain('No runtime manifest');
  });

  it('reports ready when manifest and executables exist', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => ({
      stdout: command === 'uv' && args[0] === '--version' ? 'uv 0.9.5\n' : '',
      stderr: '',
    }));
    const install = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });
    await mkdir(join(install.layout.venvDir, 'bin'), { recursive: true });
    await writeFile(install.layout.pythonPath, '#!/usr/bin/env python\n');
    await writeFile(install.layout.daemonPath, '#!/usr/bin/env python\n');

    const status = await readManagedPythonRuntimeStatus({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
    });

    expect(status.kind).toBe('ready');
    expect(status.manifest?.features).toEqual(['core']);
  });

  it('reports broken when an executable is missing', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => ({
      stdout: command === 'uv' && args[0] === '--version' ? 'uv 0.9.5\n' : '',
      stderr: '',
    }));
    await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });

    const status = await readManagedPythonRuntimeStatus({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
    });

    expect(status.kind).toBe('broken');
    expect(status.detail).toContain('Missing Python executable');
  });
});

describe('doctorManagedPythonRuntime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-doctor-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('checks uv, bundled assets, and installed runtime status', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => ({
      stdout: command === 'uv' && args[0] === '--version' ? 'uv 0.9.5\n' : '',
      stderr: '',
    }));

    const checks = await doctorManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      exec,
    });

    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['uv', 'pass'],
      ['asset', 'pass'],
      ['runtime', 'fail'],
    ]);
    expect(checks[2]?.fix).toBe('Run: ktx dev runtime install --yes');
  });

  it('reports uv as a hard prerequisite when uv is missing', async () => {
    const { assetDir } = await writeAsset(tempDir, 'core-wheel');
    const exec: ManagedPythonRuntimeExec = vi.fn(async () => {
      throw new Error('spawn uv ENOENT');
    });

    const checks = await doctorManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      exec,
    });

    expect(checks[0]).toEqual({
      id: 'uv',
      label: 'uv',
      status: 'fail',
      detail: MISSING_UV_RUNTIME_INSTALL_MESSAGE,
      fix: 'Install uv, make sure it is on PATH, and run: ktx dev runtime install --yes',
    });
  });
});
