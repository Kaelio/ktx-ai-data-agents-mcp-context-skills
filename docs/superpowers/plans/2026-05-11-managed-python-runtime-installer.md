# Managed Python Runtime Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and inspect the bundled `kaelio-ktx` Python wheel in a
versioned KTX-managed runtime directory.

**Architecture:** Add a CLI-owned managed-runtime module that knows where the
bundled wheel asset lives, verifies its checksum, creates a versioned virtual
environment with `uv`, installs the requested feature set, and writes an
installed-runtime manifest. Add `ktx runtime install`, `status`, `doctor`, and
`prune` commands that expose this behavior without changing normal
Python-backed commands yet.

**Tech Stack:** TypeScript, Node 22 ESM, Commander, Vitest, `zod`, `uv`, npm
package assets.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

Plan 1, `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`,
is implemented in this worktree. The implemented source includes
`scripts/build-python-runtime-wheel.mjs`,
`scripts/build-python-runtime-wheel.test.mjs`, runtime-wheel handling in
`scripts/package-artifacts.mjs`, test coverage in
`scripts/package-artifacts.test.mjs`, and the `kaelio-ktx` release-policy
entry. The targeted verification command passes:

```bash
node --test scripts/build-python-runtime-wheel.test.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs
```

Expected current result:

```text
# pass 38
# fail 0
```

No other plan files currently reference the npm-managed Python runtime spec.

This plan implements the next prerequisite:

- Platform-specific managed runtime roots.
- Versioned runtime directories keyed by the CLI package version.
- Runtime asset manifest reading and wheel checksum verification.
- `uv` virtual environment creation.
- Core and `local-embeddings` feature installation levels.
- Installed-runtime manifest writing.
- `ktx runtime install`, `ktx runtime status`, `ktx runtime doctor`, and
  `ktx runtime prune`.

This plan intentionally leaves the following spec requirements for later
plans:

- Lazy install from normal commands such as `ktx sl query`.
- `ktx runtime start` and `ktx runtime stop`.
- Daemon state, health checks, reuse, and stale-daemon repair.
- Public npm package renaming from `@ktx/cli` to `@kaelio/ktx`.

## File structure

- Create `packages/cli/src/managed-python-runtime.ts`: pure managed-runtime
  library for path calculation, asset verification, install/status/doctor, and
  pruning.
- Create `packages/cli/src/managed-python-runtime.test.ts`: unit tests for
  runtime roots, manifest validation, install command shape, status checks, and
  prune safety.
- Create `packages/cli/src/runtime.ts`: command runner that formats
  `install`, `status`, `doctor`, and `prune` output.
- Create `packages/cli/src/runtime.test.ts`: command-runner tests with injected
  managed-runtime dependencies.
- Create `packages/cli/src/commands/runtime-commands.ts`: Commander
  registration for `ktx runtime ...`.
- Modify `packages/cli/src/cli-runtime.ts`: add the runtime command runner to
  CLI dependency injection.
- Modify `packages/cli/src/cli-program.ts`: pass package info into command
  registration and register the runtime command group.
- Modify `packages/cli/src/index.ts`: export runtime command types and the
  runner for tests and programmatic use.
- Modify `packages/cli/src/index.test.ts`: assert root help exposes
  `runtime` and Commander routes runtime subcommands correctly.

### Task 1: Add failing managed-runtime library tests

**Files:**

- Create: `packages/cli/src/managed-python-runtime.test.ts`
- Test: `packages/cli/src/managed-python-runtime.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/cli/src/managed-python-runtime.test.ts` with this content:

```typescript
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  doctorManagedPythonRuntime,
  installManagedPythonRuntime,
  managedPythonRuntimeLayout,
  pruneManagedPythonRuntimes,
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
  it('uses the macOS application-support runtime root', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'darwin',
      env: {},
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/Users/alex/Library/Application Support/kaelio/ktx/runtime');
    expect(layout.versionDir).toBe('/Users/alex/Library/Application Support/kaelio/ktx/runtime/0.2.0');
    expect(layout.venvDir).toBe('/Users/alex/Library/Application Support/kaelio/ktx/runtime/0.2.0/.venv');
    expect(layout.pythonPath).toBe(
      '/Users/alex/Library/Application Support/kaelio/ktx/runtime/0.2.0/.venv/bin/python',
    );
    expect(layout.daemonPath).toBe(
      '/Users/alex/Library/Application Support/kaelio/ktx/runtime/0.2.0/.venv/bin/ktx-daemon',
    );
    expect(layout.assetManifestPath).toBe('/repo/packages/cli/assets/python/manifest.json');
  });

  it('honors XDG_DATA_HOME on Linux', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'linux',
      env: { XDG_DATA_HOME: '/var/xdg' },
      homeDir: '/home/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/var/xdg/kaelio/ktx/runtime');
    expect(layout.versionDir).toBe('/var/xdg/kaelio/ktx/runtime/0.2.0');
  });

  it('uses LocalAppData on Windows', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\Alex\\AppData\\Local' },
      homeDir: 'C:\\Users\\Alex',
      assetDir: 'C:\\repo\\packages\\cli\\assets\\python',
    });

    expect(layout.runtimeRoot).toBe('C:\\Users\\Alex\\AppData\\Local/Kaelio/KTX/runtime');
    expect(layout.pythonPath).toBe('C:\\Users\\Alex\\AppData\\Local/Kaelio/KTX/runtime/0.2.0/.venv/Scripts/python.exe');
    expect(layout.daemonPath).toBe('C:\\Users\\Alex\\AppData\\Local/Kaelio/KTX/runtime/0.2.0/.venv/Scripts/ktx-daemon.exe');
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
    expect(checks[2]?.fix).toBe('Run: ktx runtime install --yes');
  });
});

describe('pruneManagedPythonRuntimes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-prune-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('removes stale version directories and keeps the current version', async () => {
    const runtimeRoot = join(tempDir, 'runtime');
    await mkdir(join(runtimeRoot, '0.1.0'), { recursive: true });
    await mkdir(join(runtimeRoot, '0.2.0'), { recursive: true });
    await writeFile(join(runtimeRoot, 'README.txt'), 'not a runtime directory\n');

    const result = await pruneManagedPythonRuntimes({ cliVersion: '0.2.0', runtimeRoot });

    expect(result.removed).toEqual([join(runtimeRoot, '0.1.0')]);
    expect(result.kept).toEqual([join(runtimeRoot, '0.2.0')]);
    await expect(stat(join(runtimeRoot, '0.1.0'))).rejects.toThrow();
    expect(await readdir(runtimeRoot)).toEqual(['0.2.0', 'README.txt']);
  });

  it('supports dry-run without deleting stale directories', async () => {
    const runtimeRoot = join(tempDir, 'runtime');
    await mkdir(join(runtimeRoot, '0.1.0'), { recursive: true });
    await mkdir(join(runtimeRoot, '0.2.0'), { recursive: true });

    const result = await pruneManagedPythonRuntimes({ cliVersion: '0.2.0', runtimeRoot, dryRun: true });

    expect(result.removed).toEqual([]);
    expect(result.stale).toEqual([join(runtimeRoot, '0.1.0')]);
    expect(await readdir(runtimeRoot)).toEqual(['0.1.0', '0.2.0']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/managed-python-runtime.test.ts
```

Expected: FAIL with an import error for `./managed-python-runtime.js`.

- [ ] **Step 3: Commit the failing tests**

Run:

```bash
git add packages/cli/src/managed-python-runtime.test.ts
git commit -m "test: cover managed python runtime lifecycle"
```

### Task 2: Implement the managed-runtime library

**Files:**

- Create: `packages/cli/src/managed-python-runtime.ts`
- Test: `packages/cli/src/managed-python-runtime.test.ts`

- [ ] **Step 1: Create the managed-runtime implementation**

Create `packages/cli/src/managed-python-runtime.ts` with this content:

```typescript
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const runtimeFeatureSchema = z.enum(['core', 'local-embeddings']);
export type KtxRuntimeFeature = z.infer<typeof runtimeFeatureSchema>;

const runtimeAssetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  distributionName: z.literal('kaelio-ktx'),
  normalizedName: z.literal('kaelio_ktx'),
  version: z.string().min(1),
  wheel: z.object({
    file: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  }),
});

export type KtxRuntimeAssetManifest = z.infer<typeof runtimeAssetManifestSchema>;

const installedRuntimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  cliVersion: z.string().min(1),
  installedAt: z.string().min(1),
  asset: runtimeAssetManifestSchema,
  features: z.array(runtimeFeatureSchema).min(1),
  python: z.object({
    executable: z.string().min(1),
    daemonExecutable: z.string().min(1),
  }),
  installLog: z.string().min(1),
});

export type InstalledKtxRuntimeManifest = z.infer<typeof installedRuntimeManifestSchema>;

export interface ManagedPythonRuntimeLayoutOptions {
  cliVersion: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  runtimeRoot?: string;
  assetDir?: string;
}

export interface ManagedPythonRuntimeLayout {
  cliVersion: string;
  runtimeRoot: string;
  versionDir: string;
  venvDir: string;
  manifestPath: string;
  installLogPath: string;
  assetDir: string;
  assetManifestPath: string;
  pythonPath: string;
  daemonPath: string;
}

export interface ManagedRuntimeAsset {
  manifest: KtxRuntimeAssetManifest;
  wheelPath: string;
}

export type ManagedPythonRuntimeExec = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface ManagedPythonRuntimeInstallOptions extends ManagedPythonRuntimeLayoutOptions {
  features: KtxRuntimeFeature[];
  force?: boolean;
  exec?: ManagedPythonRuntimeExec;
}

export interface ManagedPythonRuntimeInstallResult {
  status: 'ready' | 'installed';
  layout: ManagedPythonRuntimeLayout;
  asset: ManagedRuntimeAsset;
  manifest: InstalledKtxRuntimeManifest;
}

export type ManagedPythonRuntimeStatusKind = 'missing' | 'ready' | 'mismatched' | 'broken';

export interface ManagedPythonRuntimeStatus {
  kind: ManagedPythonRuntimeStatusKind;
  detail: string;
  layout: ManagedPythonRuntimeLayout;
  manifest?: InstalledKtxRuntimeManifest;
}

export interface ManagedPythonRuntimeDoctorCheck {
  id: 'uv' | 'asset' | 'runtime';
  label: string;
  status: 'pass' | 'fail';
  detail: string;
  fix?: string;
}

export interface ManagedPythonRuntimePruneResult {
  runtimeRoot: string;
  stale: string[];
  kept: string[];
  removed: string[];
}

function defaultAssetDir(): string {
  return fileURLToPath(new URL('../assets/python/', import.meta.url));
}

function runtimeRootFor(input: Required<Pick<ManagedPythonRuntimeLayoutOptions, 'platform' | 'env' | 'homeDir'>>): string {
  if (input.platform === 'darwin') {
    return join(input.homeDir, 'Library', 'Application Support', 'kaelio', 'ktx', 'runtime');
  }
  if (input.platform === 'win32') {
    return join(input.env.LOCALAPPDATA ?? join(input.homeDir, 'AppData', 'Local'), 'Kaelio', 'KTX', 'runtime');
  }
  return join(input.env.XDG_DATA_HOME ?? join(input.homeDir, '.local', 'share'), 'kaelio', 'ktx', 'runtime');
}

function executablePath(venvDir: string, platform: NodeJS.Platform, name: string): string {
  if (platform === 'win32') {
    return join(venvDir, 'Scripts', `${name}.exe`);
  }
  return join(venvDir, 'bin', name);
}

export function managedPythonRuntimeLayout(options: ManagedPythonRuntimeLayoutOptions): ManagedPythonRuntimeLayout {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const runtimeRoot = options.runtimeRoot ?? runtimeRootFor({ platform, env, homeDir });
  const versionDir = join(runtimeRoot, options.cliVersion);
  const venvDir = join(versionDir, '.venv');
  const assetDir = options.assetDir ?? defaultAssetDir();

  return {
    cliVersion: options.cliVersion,
    runtimeRoot,
    versionDir,
    venvDir,
    manifestPath: join(versionDir, 'manifest.json'),
    installLogPath: join(versionDir, 'install.log'),
    assetDir,
    assetManifestPath: join(assetDir, 'manifest.json'),
    pythonPath: executablePath(venvDir, platform, 'python'),
    daemonPath: executablePath(venvDir, platform, 'ktx-daemon'),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSafeWheelFilename(file: string): void {
  if (file !== basename(file) || file.includes('/') || file.includes('\\')) {
    throw new Error(`Unsafe runtime wheel filename in bundled manifest: ${file}`);
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function verifyRuntimeAsset(input: { assetDir: string }): Promise<ManagedRuntimeAsset> {
  const manifestPath = join(input.assetDir, 'manifest.json');
  const manifest = runtimeAssetManifestSchema.parse(await readJsonFile(manifestPath));
  assertSafeWheelFilename(manifest.wheel.file);
  const wheelPath = join(input.assetDir, manifest.wheel.file);
  const wheel = await readFile(wheelPath);
  const sha256 = createHash('sha256').update(wheel).digest('hex');
  if (sha256 !== manifest.wheel.sha256 || wheel.byteLength !== manifest.wheel.bytes) {
    throw new Error(`Bundled Python runtime wheel checksum mismatch: ${wheelPath}`);
  }
  return { manifest, wheelPath };
}

function normalizeFeatures(features: KtxRuntimeFeature[]): KtxRuntimeFeature[] {
  const requested = new Set<KtxRuntimeFeature>(['core', ...features]);
  return runtimeFeatureSchema.options.filter((feature) => requested.has(feature));
}

async function readInstalledManifest(path: string): Promise<InstalledKtxRuntimeManifest | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  return installedRuntimeManifestSchema.parse(await readJsonFile(path));
}

function hasFeatures(manifest: InstalledKtxRuntimeManifest, features: KtxRuntimeFeature[]): boolean {
  return normalizeFeatures(features).every((feature) => manifest.features.includes(feature));
}

async function defaultExec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function errorOutput(error: unknown): { stdout: string; stderr: string } {
  const value = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
  };
}

async function runLogged(input: {
  exec: ManagedPythonRuntimeExec;
  logPath: string;
  command: string;
  args: string[];
  cwd?: string;
}): Promise<{ stdout: string; stderr: string }> {
  await appendFile(input.logPath, `$ ${input.command} ${input.args.join(' ')}\n`);
  try {
    const result = await input.exec(input.command, input.args, { cwd: input.cwd });
    if (result.stdout) {
      await appendFile(input.logPath, result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    }
    if (result.stderr) {
      await appendFile(input.logPath, result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    }
    return result;
  } catch (error) {
    const output = errorOutput(error);
    if (output.stdout) {
      await appendFile(input.logPath, output.stdout.endsWith('\n') ? output.stdout : `${output.stdout}\n`);
    }
    if (output.stderr) {
      await appendFile(input.logPath, output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
    }
    throw new Error(`Python runtime install failed. Install log: ${input.logPath}`);
  }
}

async function ensureUv(exec: ManagedPythonRuntimeExec): Promise<string> {
  try {
    const result = await exec('uv', ['--version']);
    return result.stdout.trim() || 'uv available';
  } catch {
    throw new Error(
      'uv is required to install the KTX Python runtime. Install uv and retry: ktx runtime install --yes',
    );
  }
}

export async function installManagedPythonRuntime(
  options: ManagedPythonRuntimeInstallOptions,
): Promise<ManagedPythonRuntimeInstallResult> {
  const layout = managedPythonRuntimeLayout(options);
  const exec = options.exec ?? defaultExec;
  const features = normalizeFeatures(options.features);
  const asset = await verifyRuntimeAsset({ assetDir: layout.assetDir });
  const existing = await readInstalledManifest(layout.manifestPath);
  if (
    options.force !== true &&
    existing &&
    existing.cliVersion === options.cliVersion &&
    existing.asset.wheel.sha256 === asset.manifest.wheel.sha256 &&
    hasFeatures(existing, features) &&
    (await pathExists(existing.python.executable)) &&
    (await pathExists(existing.python.daemonExecutable))
  ) {
    return { status: 'ready', layout, asset, manifest: existing };
  }

  await rm(layout.versionDir, { recursive: true, force: true });
  await mkdir(layout.versionDir, { recursive: true });
  await writeFile(layout.installLogPath, '');
  await ensureUv(exec);
  await runLogged({ exec, logPath: layout.installLogPath, command: 'uv', args: ['venv', layout.venvDir] });
  const wheelSpec = features.includes('local-embeddings') ? `${asset.wheelPath}[local-embeddings]` : asset.wheelPath;
  await runLogged({
    exec,
    logPath: layout.installLogPath,
    command: 'uv',
    args: ['pip', 'install', '--python', layout.pythonPath, wheelSpec],
  });

  const manifest: InstalledKtxRuntimeManifest = {
    schemaVersion: 1,
    cliVersion: options.cliVersion,
    installedAt: new Date().toISOString(),
    asset: asset.manifest,
    features,
    python: {
      executable: layout.pythonPath,
      daemonExecutable: layout.daemonPath,
    },
    installLog: layout.installLogPath,
  };
  await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { status: 'installed', layout, asset, manifest };
}

export async function readManagedPythonRuntimeStatus(
  options: ManagedPythonRuntimeLayoutOptions,
): Promise<ManagedPythonRuntimeStatus> {
  const layout = managedPythonRuntimeLayout(options);
  let manifest: InstalledKtxRuntimeManifest | undefined;
  try {
    manifest = await readInstalledManifest(layout.manifestPath);
  } catch (error) {
    return {
      kind: 'broken',
      detail: `Runtime manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
      layout,
    };
  }
  if (!manifest) {
    return { kind: 'missing', detail: `No runtime manifest at ${layout.manifestPath}`, layout };
  }
  if (manifest.cliVersion !== options.cliVersion) {
    return {
      kind: 'mismatched',
      detail: `Runtime is for CLI ${manifest.cliVersion}, current CLI is ${options.cliVersion}`,
      layout,
      manifest,
    };
  }
  if (!(await pathExists(manifest.python.executable))) {
    return { kind: 'broken', detail: `Missing Python executable: ${manifest.python.executable}`, layout, manifest };
  }
  if (!(await pathExists(manifest.python.daemonExecutable))) {
    return { kind: 'broken', detail: `Missing ktx-daemon executable: ${manifest.python.daemonExecutable}`, layout, manifest };
  }
  return { kind: 'ready', detail: `Runtime ready at ${layout.versionDir}`, layout, manifest };
}

function check(status: ManagedPythonRuntimeDoctorCheck['status'], input: Omit<ManagedPythonRuntimeDoctorCheck, 'status'>) {
  return { status, ...input };
}

export async function doctorManagedPythonRuntime(
  options: ManagedPythonRuntimeLayoutOptions & { exec?: ManagedPythonRuntimeExec },
): Promise<ManagedPythonRuntimeDoctorCheck[]> {
  const exec = options.exec ?? defaultExec;
  const checks: ManagedPythonRuntimeDoctorCheck[] = [];
  try {
    const version = await ensureUv(exec);
    checks.push(check('pass', { id: 'uv', label: 'uv', detail: version }));
  } catch (error) {
    checks.push(
      check('fail', {
        id: 'uv',
        label: 'uv',
        detail: error instanceof Error ? error.message : String(error),
        fix: 'Install uv, then run: ktx runtime install --yes',
      }),
    );
  }

  try {
    const asset = await verifyRuntimeAsset({ assetDir: managedPythonRuntimeLayout(options).assetDir });
    checks.push(check('pass', { id: 'asset', label: 'Bundled Python wheel', detail: asset.wheelPath }));
  } catch (error) {
    checks.push(
      check('fail', {
        id: 'asset',
        label: 'Bundled Python wheel',
        detail: error instanceof Error ? error.message : String(error),
        fix: 'Run: pnpm run artifacts:check',
      }),
    );
  }

  const status = await readManagedPythonRuntimeStatus(options);
  checks.push(
    check(status.kind === 'ready' ? 'pass' : 'fail', {
      id: 'runtime',
      label: 'Managed Python runtime',
      detail: status.detail,
      ...(status.kind === 'ready' ? {} : { fix: 'Run: ktx runtime install --yes' }),
    }),
  );
  return checks;
}

export async function pruneManagedPythonRuntimes(options: {
  cliVersion: string;
  runtimeRoot: string;
  dryRun?: boolean;
}): Promise<ManagedPythonRuntimePruneResult> {
  if (!(await pathExists(options.runtimeRoot))) {
    return { runtimeRoot: options.runtimeRoot, stale: [], kept: [], removed: [] };
  }
  const entries = await readdir(options.runtimeRoot);
  const stale: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    const path = join(options.runtimeRoot, entry);
    const info = await stat(path);
    if (!info.isDirectory()) {
      continue;
    }
    if (entry === options.cliVersion) {
      kept.push(path);
    } else {
      stale.push(path);
    }
  }
  const removed: string[] = [];
  if (options.dryRun !== true) {
    for (const path of stale) {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return { runtimeRoot: options.runtimeRoot, stale, kept, removed };
}
```

- [ ] **Step 2: Run the managed-runtime tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/managed-python-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the CLI type checker**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 4: Commit the implementation**

Run:

```bash
git add packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts
git commit -m "feat: add managed python runtime installer"
```

### Task 3: Add the runtime command runner

**Files:**

- Create: `packages/cli/src/runtime.ts`
- Create: `packages/cli/src/runtime.test.ts`
- Test: `packages/cli/src/runtime.test.ts`

- [ ] **Step 1: Write the failing command-runner tests**

Create `packages/cli/src/runtime.test.ts` with this content:

```typescript
import { describe, expect, it, vi } from 'vitest';
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
      installRuntime: vi.fn(async () => ({
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

  it('prints runtime status as JSON', async () => {
    const io = makeIo();
    const deps: KtxRuntimeDeps = {
      readStatus: vi.fn(async () => ({
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
      doctorRuntime: vi.fn(async () => [
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
      readStatus: vi.fn(async () => ({
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/runtime.test.ts
```

Expected: FAIL with an import error for `./runtime.js`.

- [ ] **Step 3: Create the command runner**

Create `packages/cli/src/runtime.ts` with this content:

```typescript
import {
  doctorManagedPythonRuntime,
  installManagedPythonRuntime,
  pruneManagedPythonRuntimes,
  readManagedPythonRuntimeStatus,
  type KtxRuntimeFeature,
  type ManagedPythonRuntimeDoctorCheck,
  type ManagedPythonRuntimeInstallOptions,
  type ManagedPythonRuntimeInstallResult,
  type ManagedPythonRuntimeLayoutOptions,
  type ManagedPythonRuntimePruneResult,
  type ManagedPythonRuntimeStatus,
} from './managed-python-runtime.js';
import type { KtxCliIo } from './cli-runtime.js';

export type KtxRuntimeArgs =
  | { command: 'install'; cliVersion: string; feature: KtxRuntimeFeature; force: boolean }
  | { command: 'status'; cliVersion: string; json: boolean }
  | { command: 'doctor'; cliVersion: string; json: boolean }
  | { command: 'prune'; cliVersion: string; dryRun: boolean; yes: boolean };

export interface KtxRuntimeDeps {
  installRuntime?: (options: ManagedPythonRuntimeInstallOptions) => Promise<ManagedPythonRuntimeInstallResult>;
  readStatus?: (options: ManagedPythonRuntimeLayoutOptions) => Promise<ManagedPythonRuntimeStatus>;
  doctorRuntime?: (options: ManagedPythonRuntimeLayoutOptions) => Promise<ManagedPythonRuntimeDoctorCheck[]>;
  pruneRuntime?: (options: { cliVersion: string; runtimeRoot: string; dryRun?: boolean }) => Promise<ManagedPythonRuntimePruneResult>;
}

function writeJson(io: KtxCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeInstallResult(io: KtxCliIo, result: ManagedPythonRuntimeInstallResult): void {
  const verb = result.status === 'ready' ? 'Using existing' : 'Installed';
  io.stdout.write(`${verb} KTX Python runtime\n`);
  io.stdout.write(`version: ${result.manifest.cliVersion}\n`);
  io.stdout.write(`features: ${result.manifest.features.join(', ')}\n`);
  io.stdout.write(`python: ${result.manifest.python.executable}\n`);
  io.stdout.write(`daemon: ${result.manifest.python.daemonExecutable}\n`);
  io.stdout.write(`manifest: ${result.layout.manifestPath}\n`);
  io.stdout.write(`install log: ${result.layout.installLogPath}\n`);
}

function writeStatus(io: KtxCliIo, status: ManagedPythonRuntimeStatus): void {
  io.stdout.write('KTX Python runtime\n');
  io.stdout.write(`status: ${status.kind}\n`);
  io.stdout.write(`detail: ${status.detail}\n`);
  io.stdout.write(`runtime root: ${status.layout.runtimeRoot}\n`);
  io.stdout.write(`version dir: ${status.layout.versionDir}\n`);
  if (status.manifest) {
    io.stdout.write(`features: ${status.manifest.features.join(', ')}\n`);
    io.stdout.write(`python: ${status.manifest.python.executable}\n`);
    io.stdout.write(`daemon: ${status.manifest.python.daemonExecutable}\n`);
  }
}

function writeDoctor(io: KtxCliIo, checks: ManagedPythonRuntimeDoctorCheck[]): void {
  io.stdout.write('KTX Python runtime doctor\n');
  for (const check of checks) {
    io.stdout.write(`${check.status.toUpperCase()} ${check.label}: ${check.detail}\n`);
    if (check.fix) {
      io.stdout.write(`     Fix: ${check.fix}\n`);
    }
  }
}

function writePrune(io: KtxCliIo, result: ManagedPythonRuntimePruneResult, dryRun: boolean): void {
  if (result.stale.length === 0) {
    io.stdout.write(`No stale KTX Python runtimes found under ${result.runtimeRoot}\n`);
    return;
  }
  io.stdout.write(dryRun ? 'Stale KTX Python runtimes\n' : 'Removed stale KTX Python runtimes\n');
  for (const path of dryRun ? result.stale : result.removed) {
    io.stdout.write(`${path}\n`);
  }
}

export async function runKtxRuntime(
  args: KtxRuntimeArgs,
  io: KtxCliIo = process,
  deps: KtxRuntimeDeps = {},
): Promise<number> {
  try {
    if (args.command === 'install') {
      const installRuntime = deps.installRuntime ?? installManagedPythonRuntime;
      const result = await installRuntime({
        cliVersion: args.cliVersion,
        features: [args.feature],
        force: args.force,
      });
      writeInstallResult(io, result);
      return 0;
    }
    if (args.command === 'status') {
      const readStatus = deps.readStatus ?? readManagedPythonRuntimeStatus;
      const status = await readStatus({ cliVersion: args.cliVersion });
      if (args.json) {
        writeJson(io, status);
      } else {
        writeStatus(io, status);
      }
      return 0;
    }
    if (args.command === 'doctor') {
      const doctorRuntime = deps.doctorRuntime ?? doctorManagedPythonRuntime;
      const checks = await doctorRuntime({ cliVersion: args.cliVersion });
      if (args.json) {
        writeJson(io, { checks });
      } else {
        writeDoctor(io, checks);
      }
      return checks.some((check) => check.status === 'fail') ? 1 : 0;
    }
    if (!args.dryRun && !args.yes) {
      io.stderr.write('Refusing to prune without --yes. Preview with: ktx runtime prune --dry-run\n');
      return 1;
    }
    const status = await (deps.readStatus ?? readManagedPythonRuntimeStatus)({ cliVersion: args.cliVersion });
    const pruneRuntime = deps.pruneRuntime ?? pruneManagedPythonRuntimes;
    const result = await pruneRuntime({
      cliVersion: args.cliVersion,
      runtimeRoot: status.layout.runtimeRoot,
      dryRun: args.dryRun,
    });
    writePrune(io, result, args.dryRun);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
```

- [ ] **Step 4: Run the command-runner tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the command runner**

Run:

```bash
git add packages/cli/src/runtime.ts packages/cli/src/runtime.test.ts
git commit -m "feat: add runtime command runner"
```

### Task 4: Register `ktx runtime` commands

**Files:**

- Create: `packages/cli/src/commands/runtime-commands.ts`
- Modify: `packages/cli/src/cli-runtime.ts`
- Modify: `packages/cli/src/cli-program.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/index.test.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Create the runtime command registration**

Create `packages/cli/src/commands/runtime-commands.ts` with this content:

```typescript
import { type Command, Option } from '@commander-js/extra-typings';
import type { KtxCliCommandContext } from '../cli-program.js';
import type { KtxRuntimeArgs } from '../runtime.js';

type RuntimeFeature = Extract<KtxRuntimeArgs, { command: 'install' }>['feature'];

const runtimeFeatureOption = new Option('--feature <feature>', 'Runtime feature level')
  .choices(['core', 'local-embeddings'])
  .default('core');

async function runRuntimeArgs(context: KtxCliCommandContext, args: KtxRuntimeArgs): Promise<void> {
  const runner = context.deps.runtime ?? (await import('../runtime.js')).runKtxRuntime;
  context.setExitCode(await runner(args, context.io));
}

export function registerRuntimeCommands(program: Command, context: KtxCliCommandContext): void {
  const runtime = program
    .command('runtime')
    .description('Install, inspect, and prune the KTX-managed Python runtime')
    .showHelpAfterError();

  runtime
    .command('install')
    .description('Install the bundled Python runtime wheel into the managed runtime')
    .addOption(runtimeFeatureOption)
    .option('--force', 'Reinstall even when the runtime already looks ready', false)
    .action(async (options: { feature: RuntimeFeature; force?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'install',
        cliVersion: context.packageInfo.version,
        feature: options.feature,
        force: options.force === true,
      });
    });

  runtime
    .command('status')
    .description('Show managed Python runtime status')
    .option('--json', 'Print JSON output', false)
    .action(async (options: { json?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'status',
        cliVersion: context.packageInfo.version,
        json: options.json === true,
      });
    });

  runtime
    .command('doctor')
    .description('Check managed Python runtime prerequisites and installation')
    .option('--json', 'Print JSON output', false)
    .action(async (options: { json?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'doctor',
        cliVersion: context.packageInfo.version,
        json: options.json === true,
      });
    });

  runtime
    .command('prune')
    .description('Remove stale managed Python runtimes for older CLI versions')
    .option('--dry-run', 'List stale runtimes without deleting them', false)
    .option('--yes', 'Confirm deletion of stale runtime directories', false)
    .action(async (options: { dryRun?: boolean; yes?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'prune',
        cliVersion: context.packageInfo.version,
        dryRun: options.dryRun === true,
        yes: options.yes === true,
      });
    });
}
```

- [ ] **Step 2: Add runtime dependency injection to CLI runtime**

In `packages/cli/src/cli-runtime.ts`, add this import after the existing
`KtxPublicIngestArgs` import:

```typescript
import type { KtxRuntimeArgs } from './runtime.js';
```

Then add this property to `KtxCliDeps` after `publicIngest`:

```typescript
  runtime?: (args: KtxRuntimeArgs, io: KtxCliIo) => Promise<number>;
```

- [ ] **Step 3: Add package info to command context and register the command**

In `packages/cli/src/cli-program.ts`, add this import after the
`registerPublicIngestCommands` import:

```typescript
import { registerRuntimeCommands } from './commands/runtime-commands.js';
```

Add this property to `KtxCliCommandContext` after `deps`:

```typescript
  packageInfo: KtxCliPackageInfo;
```

Add this property to the `context` object inside `runCommanderKtxCli` after
`deps`:

```typescript
    packageInfo: info,
```

Register the runtime commands after `registerSlCommands(program, context);`:

```typescript
  registerRuntimeCommands(program, context);
  profileMark('commander:register-runtime');
```

- [ ] **Step 4: Export runtime APIs from the CLI package**

In `packages/cli/src/index.ts`, add this export after the setup exports:

```typescript
export { runKtxRuntime, type KtxRuntimeArgs, type KtxRuntimeDeps } from './runtime.js';
```

- [ ] **Step 5: Update root help and routing tests**

In `packages/cli/src/index.test.ts`, update the root help command list in the
test named `prints the May 6 public command surface in root help` from:

```typescript
    for (const command of ['setup', 'connection', 'ingest', 'wiki', 'sl', 'serve', 'status']) {
```

to:

```typescript
    for (const command of ['setup', 'connection', 'ingest', 'wiki', 'sl', 'runtime', 'serve', 'status']) {
```

Then add this test after the root help test:

```typescript
  it('routes runtime management commands with the CLI package version', async () => {
    const runtime = vi.fn(async () => 0);
    const installIo = makeIo();
    const statusIo = makeIo();
    const doctorIo = makeIo();
    const pruneIo = makeIo();

    await expect(
      runKtxCli(['runtime', 'install', '--feature', 'local-embeddings', '--force'], installIo.io, { runtime }),
    ).resolves.toBe(0);
    await expect(runKtxCli(['runtime', 'status', '--json'], statusIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['runtime', 'doctor'], doctorIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['runtime', 'prune', '--dry-run'], pruneIo.io, { runtime })).resolves.toBe(0);

    expect(runtime).toHaveBeenNthCalledWith(
      1,
      {
        command: 'install',
        cliVersion: '0.0.0-private',
        feature: 'local-embeddings',
        force: true,
      },
      installIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      2,
      {
        command: 'status',
        cliVersion: '0.0.0-private',
        json: true,
      },
      statusIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      3,
      {
        command: 'doctor',
        cliVersion: '0.0.0-private',
        json: false,
      },
      doctorIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      4,
      {
        command: 'prune',
        cliVersion: '0.0.0-private',
        dryRun: true,
        yes: false,
      },
      pruneIo.io,
    );
  });
```

- [ ] **Step 6: Run the CLI routing tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the command registration**

Run:

```bash
git add packages/cli/src/commands/runtime-commands.ts packages/cli/src/cli-runtime.ts packages/cli/src/cli-program.ts packages/cli/src/index.ts packages/cli/src/index.test.ts
git commit -m "feat: expose runtime management commands"
```

### Task 5: Verify the managed runtime installer end to end

**Files:**

- Verify: `packages/cli/src/managed-python-runtime.ts`
- Verify: `packages/cli/src/runtime.ts`
- Verify: `packages/cli/src/commands/runtime-commands.ts`
- Verify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Run focused Vitest coverage**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/managed-python-runtime.test.ts src/runtime.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the CLI type checker**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Build CLI artifacts so bundled Python assets exist**

Run:

```bash
pnpm run artifacts:check
```

Expected: PASS. The command must leave these generated files:

```text
packages/cli/assets/python/kaelio_ktx-0.1.0-py3-none-any.whl
packages/cli/assets/python/manifest.json
```

- [ ] **Step 4: Smoke the status command without installing**

Run:

```bash
pnpm --filter @ktx/cli run build
node packages/cli/dist/bin.js runtime status --json
```

Expected: PASS with JSON containing `"kind": "missing"` or `"kind": "ready"`.
Both are valid because a developer machine might already have a runtime for
the current CLI version.

- [ ] **Step 5: Smoke the doctor command**

Run:

```bash
node packages/cli/dist/bin.js runtime doctor
```

Expected: command exits `0` if the runtime is ready and exits `1` if the
runtime is missing. In both cases, stdout must include:

```text
KTX Python runtime doctor
```

- [ ] **Step 6: Run pre-commit for changed files**

Run:

```bash
uv run pre-commit run --files packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts packages/cli/src/runtime.ts packages/cli/src/runtime.test.ts packages/cli/src/commands/runtime-commands.ts packages/cli/src/cli-runtime.ts packages/cli/src/cli-program.ts packages/cli/src/index.ts packages/cli/src/index.test.ts
```

Expected: PASS. If pre-commit cannot run because this checkout lacks a
compatible pre-commit environment, record the exact failure and keep the
Vitest, type-check, and build results.

- [ ] **Step 7: Commit final verification fixes**

If verification required edits, run:

```bash
git add packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts packages/cli/src/runtime.ts packages/cli/src/runtime.test.ts packages/cli/src/commands/runtime-commands.ts packages/cli/src/cli-runtime.ts packages/cli/src/cli-program.ts packages/cli/src/index.ts packages/cli/src/index.test.ts
git commit -m "test: verify managed python runtime commands"
```

If no verification edits were needed, do not create an empty commit.

## Self-review

Spec coverage:

- Covers runtime root selection for macOS, Linux, and Windows.
- Covers versioned runtime directories based on the CLI package version.
- Covers locating `uv`, creating a virtual environment, installing the bundled
  wheel, and writing a runtime manifest.
- Covers feature levels by installing `core` by default and
  `local-embeddings` through the wheel extra when requested.
- Covers focused errors for missing `uv`, failed install logs, status output,
  doctor output, and stale runtime pruning.
- Leaves lazy install from normal commands, daemon start/stop/reuse, and
  public npm renaming for later plans.

Placeholder scan:

- The plan contains no placeholder markers and no unspecified implementation
  steps.

Type and name consistency:

- Runtime feature strings are consistently `core` and `local-embeddings`.
- Runtime command args use `cliVersion`, `feature`, `force`, `json`, `dryRun`,
  and `yes` consistently across command registration, tests, and runner code.
- Asset manifest names are consistently `kaelio-ktx`, `kaelio_ktx`, and
  `manifest.json`.
