# Managed Python Runtime Daemon Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ktx runtime start` and `ktx runtime stop` for the
KTX-managed Python HTTP daemon, including state files, health checks, reuse,
and stale daemon repair.

**Architecture:** Keep daemon process management in a new CLI-owned module that
depends on the existing managed runtime installer. The module starts
`ktx-daemon serve-http` from the installed runtime on `127.0.0.1`, writes an
adjacent daemon state file, verifies `/health` before reuse, and removes stale
state when the process, port, version, or requested feature set no longer
matches.

**Tech Stack:** TypeScript, Node 22 ESM, Commander, Vitest, `zod`, FastAPI,
`uvicorn`, `uv`, KTX managed runtime assets.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

Existing plans based on the spec:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md` is
  implemented. The worktree contains
  `scripts/build-python-runtime-wheel.mjs`,
  `scripts/build-python-runtime-wheel.test.mjs`, runtime-wheel packaging in
  `scripts/package-artifacts.mjs`, release-policy coverage, and matching
  artifact tests.
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md` is
  implemented. The worktree contains
  `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/runtime.ts`,
  `packages/cli/src/commands/runtime-commands.ts`, CLI registration, and
  matching Vitest coverage.
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
  is implemented. The worktree contains
  `packages/cli/src/managed-python-command.ts`, `ktx sl query` runtime policy
  flags, schema validation, and matching CLI tests.

Implementation evidence collected before writing this plan:

```bash
node --test scripts/build-python-runtime-wheel.test.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs
```

Expected current result:

```text
# pass 38
# fail 0
```

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-runtime.test.ts src/runtime.test.ts src/index.test.ts src/managed-python-command.test.ts src/sl.test.ts
```

Expected current result:

```text
Test Files  58 passed (58)
Tests  699 passed (699)
```

Spec requirements still outside this plan:

- Lazy `local-embeddings` installation and daemon reuse from embedding setup,
  embedding health checks, and ingest paths.
- Managed runtime usage for Python-backed operations beyond `ktx sl query`.
- Public npm package rename from `@ktx/cli` to `@kaelio/ktx`.

This plan implements the daemon lifecycle requirement:

- `ktx runtime start`
- `ktx runtime stop`
- A versioned daemon state file adjacent to the installed runtime manifest.
- Random localhost port allocation.
- Captured daemon stdout and stderr logs.
- `/health` validation before daemon reuse.
- Stale daemon cleanup when process, health, version, or features don't match.

## File structure

- Modify `python/ktx-daemon/src/ktx_daemon/app.py`: include a daemon version in
  `/health`, supplied by `KTX_DAEMON_VERSION` for managed runtime starts.
- Modify `python/ktx-daemon/tests/test_app.py`: assert the health endpoint
  returns the managed version when the environment variable is set.
- Modify `packages/cli/src/managed-python-runtime.ts`: add daemon state and log
  paths to `ManagedPythonRuntimeLayout`.
- Modify `packages/cli/src/managed-python-runtime.test.ts`: assert the new
  layout paths.
- Modify `packages/cli/src/runtime.test.ts` and
  `packages/cli/src/managed-python-command.test.ts`: add daemon paths to
  layout fixtures after the layout type changes.
- Create `packages/cli/src/managed-python-daemon.ts`: start, stop, status,
  health-check, stale-state, and state-file logic for the managed HTTP daemon.
- Create `packages/cli/src/managed-python-daemon.test.ts`: unit tests for
  stopped status, start, reuse, stale repair, and stop.
- Modify `packages/cli/src/runtime.ts`: route `runtime start` and
  `runtime stop` through the daemon lifecycle module and print concise output.
- Modify `packages/cli/src/runtime.test.ts`: assert command runner behavior for
  start and stop.
- Modify `packages/cli/src/commands/runtime-commands.ts`: register
  `ktx runtime start` and `ktx runtime stop`, and accept `--yes` on
  `ktx runtime install` so the preparation command printed by
  `ktx sl query --no-input` is valid.
- Modify `packages/cli/src/index.test.ts`: assert Commander routes the new
  runtime subcommands with the CLI package version.
- Modify `packages/cli/src/index.ts`: export the daemon lifecycle helpers for
  tests and programmatic use.

### Task 1: Add daemon metadata to runtime layout and Python health

**Files:**

- Modify: `packages/cli/src/managed-python-runtime.ts`
- Modify: `packages/cli/src/managed-python-runtime.test.ts`
- Modify: `packages/cli/src/runtime.test.ts`
- Modify: `packages/cli/src/managed-python-command.test.ts`
- Modify: `python/ktx-daemon/src/ktx_daemon/app.py`
- Modify: `python/ktx-daemon/tests/test_app.py`

- [ ] **Step 1: Write failing TypeScript layout assertions**

In `packages/cli/src/managed-python-runtime.test.ts`, update the first
`managedPythonRuntimeLayout` test so it includes these expectations after the
existing `daemonPath` assertion:

```typescript
    expect(layout.daemonStatePath).toBe(
      '/Users/alex/Library/Application Support/kaelio/ktx/runtime/0.2.0/daemon.json',
    );
    expect(layout.daemonStdoutPath).toBe(
      '/Users/alex/Library/Application Support/kaelio/ktx/runtime/0.2.0/daemon.stdout.log',
    );
    expect(layout.daemonStderrPath).toBe(
      '/Users/alex/Library/Application Support/kaelio/ktx/runtime/0.2.0/daemon.stderr.log',
    );
```

- [ ] **Step 2: Run the failing layout test**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-runtime.test.ts
```

Expected: FAIL with TypeScript or assertion errors for missing
`daemonStatePath`, `daemonStdoutPath`, and `daemonStderrPath`.

- [ ] **Step 3: Add daemon paths to the runtime layout type**

In `packages/cli/src/managed-python-runtime.ts`, add these fields to
`ManagedPythonRuntimeLayout` immediately after `daemonPath`:

```typescript
  daemonStatePath: string;
  daemonStdoutPath: string;
  daemonStderrPath: string;
```

In `managedPythonRuntimeLayout`, add these properties to the returned object
immediately after `daemonPath`:

```typescript
    daemonStatePath: join(versionDir, 'daemon.json'),
    daemonStdoutPath: join(versionDir, 'daemon.stdout.log'),
    daemonStderrPath: join(versionDir, 'daemon.stderr.log'),
```

- [ ] **Step 4: Update layout fixtures used by existing tests**

In `packages/cli/src/runtime.test.ts`, every object literal that represents a
`ManagedPythonRuntimeLayout` must include these fields:

```typescript
          daemonStatePath: '/runtime/0.2.0/daemon.json',
          daemonStdoutPath: '/runtime/0.2.0/daemon.stdout.log',
          daemonStderrPath: '/runtime/0.2.0/daemon.stderr.log',
```

In `packages/cli/src/managed-python-command.test.ts`, update the `layout()`
helper to return these fields:

```typescript
    daemonStatePath: '/runtime/0.2.0/daemon.json',
    daemonStdoutPath: '/runtime/0.2.0/daemon.stdout.log',
    daemonStderrPath: '/runtime/0.2.0/daemon.stderr.log',
```

- [ ] **Step 5: Verify the TypeScript layout change**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-runtime.test.ts src/runtime.test.ts src/managed-python-command.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write the failing Python health-version test**

In `python/ktx-daemon/tests/test_app.py`, add this test after
`test_health_endpoint_returns_healthy`:

```python
def test_health_endpoint_returns_managed_runtime_version(monkeypatch) -> None:
    monkeypatch.setenv("KTX_DAEMON_VERSION", "0.2.0")
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy", "version": "0.2.0"}
```

- [ ] **Step 7: Run the failing Python health test**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_app.py::test_health_endpoint_returns_managed_runtime_version -q
```

Expected: FAIL because `/health` does not include `version`.

- [ ] **Step 8: Include version metadata in daemon health**

In `python/ktx-daemon/src/ktx_daemon/app.py`, add this import with the existing
imports:

```python
import os
```

Replace the `health` endpoint with:

```python
    @app.get("/health")
    async def health() -> dict[str, str]:
        response = {"status": "healthy"}
        version = os.environ.get("KTX_DAEMON_VERSION")
        if version:
            response["version"] = version
        return response
```

- [ ] **Step 9: Verify Python health tests**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_app.py -q
```

Expected: PASS.

- [ ] **Step 10: Run Python pre-commit for modified Python files**

Run:

```bash
source .venv/bin/activate && uv run pre-commit run --files python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_app.py
```

Expected: PASS. If pre-commit cannot run because hooks or tool versions are
missing, capture the error and run:

```bash
source .venv/bin/activate && uv run ruff check python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_app.py
```

- [ ] **Step 11: Commit**

Run:

```bash
git add packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts packages/cli/src/runtime.test.ts packages/cli/src/managed-python-command.test.ts python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_app.py
git commit -m "feat: add managed runtime daemon metadata"
```

### Task 2: Implement managed daemon lifecycle library

**Files:**

- Create: `packages/cli/src/managed-python-daemon.test.ts`
- Create: `packages/cli/src/managed-python-daemon.ts`
- Test: `packages/cli/src/managed-python-daemon.test.ts`

- [ ] **Step 1: Write the failing daemon lifecycle tests**

Create `packages/cli/src/managed-python-daemon.test.ts` with this content:

```typescript
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
```

- [ ] **Step 2: Run the failing daemon lifecycle tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-daemon.test.ts
```

Expected: FAIL with an import error for `./managed-python-daemon.js`.

- [ ] **Step 3: Implement the daemon lifecycle module**

Create `packages/cli/src/managed-python-daemon.ts` with this content:

```typescript
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  installManagedPythonRuntime,
  managedPythonRuntimeLayout,
  runtimeFeatureSchema,
  type KtxRuntimeFeature,
  type ManagedPythonRuntimeInstallOptions,
  type ManagedPythonRuntimeInstallResult,
  type ManagedPythonRuntimeLayout,
  type ManagedPythonRuntimeLayoutOptions,
} from './managed-python-runtime.js';

export interface ManagedPythonDaemonState {
  schemaVersion: 1;
  pid: number;
  host: '127.0.0.1';
  port: number;
  version: string;
  features: KtxRuntimeFeature[];
  startedAt: string;
  stdoutLog: string;
  stderrLog: string;
}

export type ManagedPythonDaemonStatus =
  | { kind: 'stopped'; detail: string; layout: ManagedPythonRuntimeLayout }
  | { kind: 'running'; detail: string; layout: ManagedPythonRuntimeLayout; state: ManagedPythonDaemonState; baseUrl: string }
  | { kind: 'stale'; detail: string; layout: ManagedPythonRuntimeLayout; state?: ManagedPythonDaemonState };

export interface ManagedPythonDaemonStartResult {
  status: 'started' | 'reused';
  layout: ManagedPythonRuntimeLayout;
  state: ManagedPythonDaemonState;
  baseUrl: string;
}

export interface ManagedPythonDaemonStopResult {
  status: 'stopped' | 'already-stopped';
  layout: ManagedPythonRuntimeLayout;
  state?: ManagedPythonDaemonState;
}

export interface ManagedPythonDaemonChild {
  pid?: number;
  unref(): void;
}

export type ManagedPythonDaemonSpawn = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: ['ignore', number, number];
    env: NodeJS.ProcessEnv;
  },
) => ManagedPythonDaemonChild;

export type ManagedPythonDaemonFetch = (
  url: string,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ManagedPythonDaemonStartOptions extends ManagedPythonRuntimeLayoutOptions {
  features: KtxRuntimeFeature[];
  force?: boolean;
  installRuntime?: (options: ManagedPythonRuntimeInstallOptions) => Promise<ManagedPythonRuntimeInstallResult>;
  spawnDaemon?: ManagedPythonDaemonSpawn;
  fetch?: ManagedPythonDaemonFetch;
  allocatePort?: () => Promise<number>;
  processAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  now?: () => Date;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ManagedPythonDaemonStatusOptions extends ManagedPythonRuntimeLayoutOptions {
  fetch?: ManagedPythonDaemonFetch;
  processAlive?: (pid: number) => boolean;
}

export interface ManagedPythonDaemonStopOptions extends ManagedPythonRuntimeLayoutOptions {
  processAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
}

const daemonStateSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  version: z.string().min(1),
  features: z.array(runtimeFeatureSchema).min(1),
  startedAt: z.string().min(1),
  stdoutLog: z.string().min(1),
  stderrLog: z.string().min(1),
});

function normalizeFeatures(features: KtxRuntimeFeature[]): KtxRuntimeFeature[] {
  const requested = new Set<KtxRuntimeFeature>(['core', ...features]);
  return runtimeFeatureSchema.options.filter((feature) => requested.has(feature));
}

function hasFeatures(state: ManagedPythonDaemonState, features: KtxRuntimeFeature[]): boolean {
  return normalizeFeatures(features).every((feature) => state.features.includes(feature));
}

function defaultFetch(url: string): ReturnType<ManagedPythonDaemonFetch> {
  return fetch(url) as ReturnType<ManagedPythonDaemonFetch>;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 'ESRCH') {
      throw error;
    }
  }
}

function defaultSpawnDaemon(
  command: string,
  args: string[],
  options: Parameters<ManagedPythonDaemonSpawn>[2],
): ManagedPythonDaemonChild {
  return spawn(command, args, options);
}

function baseUrl(state: Pick<ManagedPythonDaemonState, 'host' | 'port'>): string {
  return `http://${state.host}:${state.port}`;
}

async function readState(path: string): Promise<ManagedPythonDaemonState | undefined> {
  try {
    return daemonStateSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeState(path: string, state: ManagedPythonDaemonState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function healthOk(input: {
  state: ManagedPythonDaemonState;
  cliVersion: string;
  fetch: ManagedPythonDaemonFetch;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await input.fetch(`${baseUrl(input.state)}/health`);
    if (!response.ok) {
      return { ok: false, detail: `Health check returned HTTP ${response.status}: ${await response.text()}` };
    }
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, detail: 'Health check returned non-object JSON' };
    }
    const record = body as Record<string, unknown>;
    if (record.status !== 'healthy') {
      return { ok: false, detail: `Health check returned status ${String(record.status)}` };
    }
    if (record.version !== input.cliVersion) {
      return {
        ok: false,
        detail: `Daemon version ${String(record.version)} does not match CLI ${input.cliVersion}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function readManagedPythonDaemonStatus(
  options: ManagedPythonDaemonStatusOptions,
): Promise<ManagedPythonDaemonStatus> {
  const layout = managedPythonRuntimeLayout(options);
  let state: ManagedPythonDaemonState | undefined;
  try {
    state = await readState(layout.daemonStatePath);
  } catch (error) {
    return {
      kind: 'stale',
      detail: `Daemon state is invalid: ${error instanceof Error ? error.message : String(error)}`,
      layout,
    };
  }
  if (!state) {
    return { kind: 'stopped', detail: `No daemon state at ${layout.daemonStatePath}`, layout };
  }
  if (state.version !== options.cliVersion) {
    return {
      kind: 'stale',
      detail: `Daemon is for CLI ${state.version}, current CLI is ${options.cliVersion}`,
      layout,
      state,
    };
  }
  const processAlive = options.processAlive ?? defaultProcessAlive;
  if (!processAlive(state.pid)) {
    return { kind: 'stale', detail: `Daemon process ${state.pid} is not running`, layout, state };
  }
  const health = await healthOk({
    state,
    cliVersion: options.cliVersion,
    fetch: options.fetch ?? defaultFetch,
  });
  if (!health.ok) {
    return { kind: 'stale', detail: health.detail, layout, state };
  }
  return { kind: 'running', detail: `Daemon running at ${baseUrl(state)}`, layout, state, baseUrl: baseUrl(state) };
}

export async function allocateDaemonPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
          return;
        }
        reject(new Error('Failed to allocate a daemon port'));
      });
    });
  });
}

async function waitForHealth(input: {
  state: ManagedPythonDaemonState;
  cliVersion: string;
  fetch: ManagedPythonDaemonFetch;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastDetail = 'daemon did not answer health checks';
  while (Date.now() <= deadline) {
    const health = await healthOk({
      state: input.state,
      cliVersion: input.cliVersion,
      fetch: input.fetch,
    });
    if (health.ok) {
      return;
    }
    lastDetail = health.detail;
    await delay(input.pollIntervalMs);
  }
  throw new Error(`KTX Python daemon failed to start: ${lastDetail}. stderr: ${input.state.stderrLog}`);
}

async function removeState(layout: ManagedPythonRuntimeLayout): Promise<void> {
  await rm(layout.daemonStatePath, { force: true });
}

async function stopRecordedDaemon(input: {
  layout: ManagedPythonRuntimeLayout;
  state: ManagedPythonDaemonState;
  processAlive: (pid: number) => boolean;
  killProcess: (pid: number) => void;
}): Promise<void> {
  if (input.processAlive(input.state.pid)) {
    input.killProcess(input.state.pid);
  }
  await removeState(input.layout);
}

export async function startManagedPythonDaemon(
  options: ManagedPythonDaemonStartOptions,
): Promise<ManagedPythonDaemonStartResult> {
  const features = normalizeFeatures(options.features);
  const installRuntime = options.installRuntime ?? installManagedPythonRuntime;
  const layoutOverrides = {
    ...(options.runtimeRoot !== undefined ? { runtimeRoot: options.runtimeRoot } : {}),
    ...(options.assetDir !== undefined ? { assetDir: options.assetDir } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  };
  const layout = managedPythonRuntimeLayout({ cliVersion: options.cliVersion, ...layoutOverrides });
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const fetchImpl = options.fetch ?? defaultFetch;

  const status = await readManagedPythonDaemonStatus({
    cliVersion: options.cliVersion,
    ...layoutOverrides,
    fetch: fetchImpl,
    processAlive,
  });
  if (options.force !== true && status.kind === 'running' && hasFeatures(status.state, features)) {
    return { status: 'reused', layout, state: status.state, baseUrl: status.baseUrl };
  }
  if (status.state) {
    await stopRecordedDaemon({ layout, state: status.state, processAlive, killProcess });
  } else {
    await removeState(layout);
  }

  const installed = await installRuntime({
    cliVersion: options.cliVersion,
    ...layoutOverrides,
    features,
    force: false,
  });

  await mkdir(layout.versionDir, { recursive: true });
  const stdout = await open(layout.daemonStdoutPath, 'a');
  const stderr = await open(layout.daemonStderrPath, 'a');
  try {
    const port = await (options.allocatePort ?? allocateDaemonPort)();
    const spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon;
    const child = spawnDaemon(
      installed.manifest.python.daemonExecutable,
      ['serve-http', '--host', '127.0.0.1', '--port', String(port)],
      {
        detached: true,
        stdio: ['ignore', stdout.fd, stderr.fd],
        env: {
          ...process.env,
          KTX_DAEMON_VERSION: options.cliVersion,
        },
      },
    );
    child.unref();
    if (!child.pid) {
      throw new Error(`KTX Python daemon did not report a pid. stderr: ${layout.daemonStderrPath}`);
    }
    const state: ManagedPythonDaemonState = {
      schemaVersion: 1,
      pid: child.pid,
      host: '127.0.0.1',
      port,
      version: options.cliVersion,
      features: installed.manifest.features,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      stdoutLog: layout.daemonStdoutPath,
      stderrLog: layout.daemonStderrPath,
    };
    await waitForHealth({
      state,
      cliVersion: options.cliVersion,
      fetch: fetchImpl,
      timeoutMs: options.startupTimeoutMs ?? 10_000,
      pollIntervalMs: options.pollIntervalMs ?? 100,
    });
    await writeState(layout.daemonStatePath, state);
    return { status: 'started', layout, state, baseUrl: baseUrl(state) };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

export async function stopManagedPythonDaemon(
  options: ManagedPythonDaemonStopOptions,
): Promise<ManagedPythonDaemonStopResult> {
  const layout = managedPythonRuntimeLayout(options);
  const state = await readState(layout.daemonStatePath);
  if (!state) {
    return { status: 'already-stopped', layout };
  }
  await stopRecordedDaemon({
    layout,
    state,
    processAlive: options.processAlive ?? defaultProcessAlive,
    killProcess: options.killProcess ?? defaultKillProcess,
  });
  return { status: 'stopped', layout, state };
}
```

- [ ] **Step 4: Run daemon lifecycle tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-daemon.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/cli/src/managed-python-daemon.ts packages/cli/src/managed-python-daemon.test.ts
git commit -m "feat: manage python daemon lifecycle"
```

### Task 3: Wire runtime start and stop commands

**Files:**

- Modify: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/src/runtime.test.ts`
- Modify: `packages/cli/src/commands/runtime-commands.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write failing runtime command runner tests**

In `packages/cli/src/runtime.test.ts`, add these imports:

```typescript
import type {
  ManagedPythonDaemonStartResult,
  ManagedPythonDaemonStopResult,
} from './managed-python-daemon.js';
```

Add these tests inside `describe('runKtxRuntime', () => { ... })` after the
install test:

```typescript
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
          daemonStatePath: '/runtime/0.2.0/daemon.json',
          daemonStdoutPath: '/runtime/0.2.0/daemon.stdout.log',
          daemonStderrPath: '/runtime/0.2.0/daemon.stderr.log',
        },
        state: {
          schemaVersion: 1,
          pid: 4242,
          host: '127.0.0.1',
          port: 61234,
          version: '0.2.0',
          features: ['core', 'local-embeddings'],
          startedAt: '2026-05-11T00:00:00.000Z',
          stdoutLog: '/runtime/0.2.0/daemon.stdout.log',
          stderrLog: '/runtime/0.2.0/daemon.stderr.log',
        },
      })),
    };

    await expect(
      runKtxRuntime(
        { command: 'start', cliVersion: '0.2.0', feature: 'local-embeddings', force: true },
        io.io,
        deps,
      ),
    ).resolves.toBe(0);

    expect(deps.startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      features: ['local-embeddings'],
      force: true,
    });
    expect(io.stdout()).toContain('Started KTX Python daemon');
    expect(io.stdout()).toContain('url: http://127.0.0.1:61234');
    expect(io.stdout()).toContain('pid: 4242');
    expect(io.stdout()).toContain('features: core, local-embeddings');
    expect(io.stdout()).toContain('stderr: /runtime/0.2.0/daemon.stderr.log');
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
          daemonStatePath: '/runtime/0.2.0/daemon.json',
          daemonStdoutPath: '/runtime/0.2.0/daemon.stdout.log',
          daemonStderrPath: '/runtime/0.2.0/daemon.stderr.log',
        },
        state: {
          schemaVersion: 1,
          pid: 4242,
          host: '127.0.0.1',
          port: 61234,
          version: '0.2.0',
          features: ['core'],
          startedAt: '2026-05-11T00:00:00.000Z',
          stdoutLog: '/runtime/0.2.0/daemon.stdout.log',
          stderrLog: '/runtime/0.2.0/daemon.stderr.log',
        },
      })),
    };

    await expect(runKtxRuntime({ command: 'stop', cliVersion: '0.2.0' }, io.io, deps)).resolves.toBe(0);

    expect(deps.stopDaemon).toHaveBeenCalledWith({ cliVersion: '0.2.0' });
    expect(io.stdout()).toContain('Stopped KTX Python daemon');
    expect(io.stdout()).toContain('pid: 4242');
  });
```

- [ ] **Step 2: Run the failing command runner tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/runtime.test.ts
```

Expected: FAIL because `KtxRuntimeArgs` and `KtxRuntimeDeps` do not include
`start`, `stop`, `startDaemon`, or `stopDaemon`.

- [ ] **Step 3: Update the runtime command runner**

In `packages/cli/src/runtime.ts`, add these imports:

```typescript
import {
  startManagedPythonDaemon,
  stopManagedPythonDaemon,
  type ManagedPythonDaemonStartResult,
  type ManagedPythonDaemonStopResult,
} from './managed-python-daemon.js';
```

Extend `KtxRuntimeArgs` with:

```typescript
  | { command: 'start'; cliVersion: string; feature: KtxRuntimeFeature; force: boolean }
  | { command: 'stop'; cliVersion: string }
```

Extend `KtxRuntimeDeps` with:

```typescript
  startDaemon?: (options: {
    cliVersion: string;
    features: KtxRuntimeFeature[];
    force?: boolean;
  }) => Promise<ManagedPythonDaemonStartResult>;
  stopDaemon?: (options: { cliVersion: string }) => Promise<ManagedPythonDaemonStopResult>;
```

Add these writer helpers after `writeInstallResult`:

```typescript
function writeDaemonStart(io: KtxCliIo, result: ManagedPythonDaemonStartResult): void {
  const verb = result.status === 'reused' ? 'Using existing' : 'Started';
  io.stdout.write(`${verb} KTX Python daemon\n`);
  io.stdout.write(`url: ${result.baseUrl}\n`);
  io.stdout.write(`pid: ${result.state.pid}\n`);
  io.stdout.write(`version: ${result.state.version}\n`);
  io.stdout.write(`features: ${result.state.features.join(', ')}\n`);
  io.stdout.write(`state: ${result.layout.daemonStatePath}\n`);
  io.stdout.write(`stdout: ${result.state.stdoutLog}\n`);
  io.stdout.write(`stderr: ${result.state.stderrLog}\n`);
}

function writeDaemonStop(io: KtxCliIo, result: ManagedPythonDaemonStopResult): void {
  if (result.status === 'already-stopped') {
    io.stdout.write('KTX Python daemon already stopped\n');
    return;
  }
  io.stdout.write('Stopped KTX Python daemon\n');
  io.stdout.write(`pid: ${result.state?.pid ?? 'unknown'}\n`);
  io.stdout.write(`state: ${result.layout.daemonStatePath}\n`);
}
```

Inside `runKtxRuntime`, add these branches after the install branch:

```typescript
    if (args.command === 'start') {
      const startDaemon = deps.startDaemon ?? startManagedPythonDaemon;
      const result = await startDaemon({
        cliVersion: args.cliVersion,
        features: [args.feature],
        force: args.force,
      });
      writeDaemonStart(io, result);
      return 0;
    }
    if (args.command === 'stop') {
      const stopDaemon = deps.stopDaemon ?? stopManagedPythonDaemon;
      const result = await stopDaemon({ cliVersion: args.cliVersion });
      writeDaemonStop(io, result);
      return 0;
    }
```

- [ ] **Step 4: Verify runtime command runner tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing Commander routing tests**

In `packages/cli/src/index.test.ts`, inside
`it('routes runtime management commands with the CLI package version', ...)`,
add two new IO handles after `installIo`:

```typescript
    const startIo = makeIo();
    const stopIo = makeIo();
```

Replace the existing `runtime install` invocation with this version that also
passes `--yes`, then add the new `runtime start` and `runtime stop`
invocations immediately after it:

```typescript
    await expect(
      runKtxCli(['runtime', 'install', '--feature', 'local-embeddings', '--force', '--yes'], installIo.io, {
        runtime,
      }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(['runtime', 'start', '--feature', 'local-embeddings', '--force'], startIo.io, { runtime }),
    ).resolves.toBe(0);
    await expect(runKtxCli(['runtime', 'stop'], stopIo.io, { runtime })).resolves.toBe(0);
```

Update the `expect(runtime).toHaveBeenNthCalledWith(...)` assertions so the
runtime calls are:

```typescript
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
        command: 'start',
        cliVersion: '0.0.0-private',
        feature: 'local-embeddings',
        force: true,
      },
      startIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      3,
      {
        command: 'stop',
        cliVersion: '0.0.0-private',
      },
      stopIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      4,
      {
        command: 'status',
        cliVersion: '0.0.0-private',
        json: true,
      },
      statusIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      5,
      {
        command: 'doctor',
        cliVersion: '0.0.0-private',
        json: false,
      },
      doctorIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      6,
      {
        command: 'prune',
        cliVersion: '0.0.0-private',
        dryRun: true,
        yes: false,
      },
      pruneIo.io,
    );
```

- [ ] **Step 6: Run the failing Commander routing test**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/index.test.ts
```

Expected: FAIL because `runtime install --yes` is not accepted and
`runtime start` and `runtime stop` are not registered.

- [ ] **Step 7: Register start and stop subcommands**

In `packages/cli/src/commands/runtime-commands.ts`, update the existing
runtime feature option to return a fresh Commander option per command:

```typescript
function createRuntimeFeatureOption() {
  return new Option('--feature <feature>', 'Runtime feature level')
    .choices(['core', 'local-embeddings'])
    .default('core');
}
```

Then update the existing `install` command so it accepts `--yes` without
changing behavior:

```typescript
  runtime
    .command('install')
    .description('Install the bundled Python runtime wheel into the managed runtime')
    .addOption(createRuntimeFeatureOption())
    .option('--yes', 'Accept runtime installation without prompting', false)
    .option('--force', 'Reinstall even when the runtime already looks ready', false)
    .action(async (options: { feature: RuntimeFeature; yes?: boolean; force?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'install',
        cliVersion: context.packageInfo.version,
        feature: options.feature,
        force: options.force === true,
      });
    });
```

Add this `start` command after the `install` command:

```typescript
  runtime
    .command('start')
    .description('Start the KTX-managed Python HTTP daemon')
    .addOption(createRuntimeFeatureOption())
    .option('--force', 'Restart even when a matching daemon is already running', false)
    .action(async (options: { feature: RuntimeFeature; force?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'start',
        cliVersion: context.packageInfo.version,
        feature: options.feature,
        force: options.force === true,
      });
    });
```

Add this `stop` command after the `start` command:

```typescript
  runtime
    .command('stop')
    .description('Stop the KTX-managed Python HTTP daemon')
    .action(async () => {
      await runRuntimeArgs(context, {
        command: 'stop',
        cliVersion: context.packageInfo.version,
      });
    });
```

- [ ] **Step 8: Export daemon lifecycle helpers**

In `packages/cli/src/index.ts`, add this export near the other public test and
programmatic exports:

```typescript
export {
  allocateDaemonPort,
  readManagedPythonDaemonStatus,
  startManagedPythonDaemon,
  stopManagedPythonDaemon,
} from './managed-python-daemon.js';
export type {
  ManagedPythonDaemonStartResult,
  ManagedPythonDaemonState,
  ManagedPythonDaemonStatus,
  ManagedPythonDaemonStopResult,
} from './managed-python-daemon.js';
```

- [ ] **Step 9: Verify CLI routing tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/index.test.ts src/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```bash
git add packages/cli/src/runtime.ts packages/cli/src/runtime.test.ts packages/cli/src/commands/runtime-commands.ts packages/cli/src/index.test.ts packages/cli/src/index.ts
git commit -m "feat: add runtime daemon start stop commands"
```

### Task 4: Verify daemon lifecycle end to end

**Files:**

- Verify: `packages/cli/src/managed-python-daemon.ts`
- Verify: `packages/cli/src/runtime.ts`
- Verify: `python/ktx-daemon/src/ktx_daemon/app.py`

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-runtime.test.ts src/managed-python-daemon.test.ts src/runtime.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused Python tests**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_app.py python/ktx-daemon/tests/test_cli.py -q
```

Expected: PASS.

- [ ] **Step 3: Run TypeScript type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 4: Run Python pre-commit for modified files**

Run:

```bash
source .venv/bin/activate && uv run pre-commit run --files python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_app.py packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts packages/cli/src/managed-python-daemon.ts packages/cli/src/managed-python-daemon.test.ts packages/cli/src/runtime.ts packages/cli/src/runtime.test.ts packages/cli/src/commands/runtime-commands.ts packages/cli/src/index.test.ts packages/cli/src/index.ts
```

Expected: PASS. If pre-commit rejects TypeScript file arguments because a hook
only handles Python, run the Python-only pre-commit command from Task 1 and
then run:

```bash
pnpm --filter @ktx/cli run check
```

- [ ] **Step 5: Build the CLI package**

Run:

```bash
pnpm --filter @ktx/cli run build
```

Expected: PASS.

- [ ] **Step 6: Build runtime wheel assets**

Run:

```bash
pnpm run artifacts:verify
```

Expected: PASS and `packages/cli/assets/python/manifest.json` exists with a
matching `kaelio_ktx-0.1.0-py3-none-any.whl`.

- [ ] **Step 7: Smoke runtime install, start, reuse, and stop**

Run:

```bash
KTX_RUNTIME_ROOT="$(mktemp -d)"
KTX_RUNTIME_ROOT="$KTX_RUNTIME_ROOT" node packages/cli/dist/bin.js runtime install --yes
KTX_RUNTIME_ROOT="$KTX_RUNTIME_ROOT" node packages/cli/dist/bin.js runtime start
KTX_RUNTIME_ROOT="$KTX_RUNTIME_ROOT" node packages/cli/dist/bin.js runtime start
KTX_RUNTIME_ROOT="$KTX_RUNTIME_ROOT" node packages/cli/dist/bin.js runtime stop
rm -rf "$KTX_RUNTIME_ROOT"
```

Expected:

```text
Installed KTX Python runtime
Started KTX Python daemon
Using existing KTX Python daemon
Stopped KTX Python daemon
```

If the existing runtime layout does not honor `KTX_RUNTIME_ROOT`, run the same
commands without that environment variable and clean up with:

```bash
node packages/cli/dist/bin.js runtime stop
node packages/cli/dist/bin.js runtime prune --dry-run
```

- [ ] **Step 8: Commit verification-only fixes if needed**

If verification exposed a small defect inside this plan's files, fix it and
commit only the touched files:

```bash
git add packages/cli/src/managed-python-daemon.ts packages/cli/src/managed-python-daemon.test.ts packages/cli/src/runtime.ts packages/cli/src/runtime.test.ts packages/cli/src/commands/runtime-commands.ts packages/cli/src/index.test.ts packages/cli/src/index.ts python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_app.py packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts packages/cli/src/managed-python-command.test.ts
git commit -m "fix: verify managed runtime daemon lifecycle"
```

Skip this step when there are no verification fixes.

## Acceptance criteria

- `ktx runtime start` installs or reuses the requested runtime feature level and
  starts `ktx-daemon serve-http` on `127.0.0.1` with a random available port.
- `ktx runtime start` reuses a healthy matching daemon and starts a fresh daemon
  when the recorded process, health response, version, or feature set is stale.
- `ktx runtime stop` terminates the recorded daemon process and removes the
  daemon state file.
- The daemon state file records `pid`, `port`, `version`, `features`,
  `startedAt`, stdout log path, and stderr log path.
- The daemon health endpoint returns `{"status": "healthy"}` by default and
  includes `version` when `KTX_DAEMON_VERSION` is set.
- Daemon stdout and stderr are preserved under the versioned runtime directory.
- Focused TypeScript tests, focused Python tests, CLI type-check, and
  Python-file pre-commit pass or have explicitly recorded environment blockers.

## Self-review checklist

- Spec coverage: this plan covers `ktx runtime start`, `ktx runtime stop`,
  daemon state, random localhost port binding, health validation, version
  matching, stale repair, and captured daemon logs. It leaves lazy embedding
  command integration and public npm renaming for later plans.
- Placeholder scan: this plan contains no placeholder steps, deferred code
  blocks, or undefined function names.
- Type consistency: runtime feature values are consistently `core` and
  `local-embeddings`; daemon state uses `schemaVersion`, `pid`, `host`, `port`,
  `version`, `features`, `startedAt`, `stdoutLog`, and `stderrLog`; command
  runner types use `startDaemon` and `stopDaemon`.
