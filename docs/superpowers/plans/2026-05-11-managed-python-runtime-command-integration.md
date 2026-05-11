# Managed Python Runtime Command Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ktx sl query` use the KTX-managed bundled Python runtime
instead of relying on a user-provided `python -m ktx_daemon`.

**Architecture:** Add a small CLI helper that resolves the managed runtime,
installs the `core` feature when policy permits it, and creates the existing
`@ktx/context/daemon` one-shot semantic-layer compute port with the managed
`ktx-daemon` executable. Wire `ktx sl query` to pass an explicit runtime
install policy from `--yes`, `--no-input`, or the default interactive mode.

**Tech Stack:** TypeScript, Commander, Vitest, `@clack/prompts`,
`@ktx/context/daemon`, existing KTX managed runtime installer.

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
  artifact tests. The targeted verification passes:
  `node --test scripts/build-python-runtime-wheel.test.mjs scripts/package-artifacts.test.mjs scripts/release-readiness.test.mjs`.
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md` is
  implemented. The worktree contains
  `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/runtime.ts`,
  `packages/cli/src/commands/runtime-commands.ts`, CLI registration, and
  matching Vitest coverage. The targeted CLI verification passes:
  `pnpm --filter @ktx/cli run test -- src/managed-python-runtime.test.ts src/runtime.test.ts src/index.test.ts`.

Spec requirements still outside this plan:

- `ktx runtime start` and `ktx runtime stop`.
- Managed HTTP daemon state, health checks, reuse, and stale daemon repair.
- Lazy `local-embeddings` installation and local embedding daemon reuse.
- Public npm package rename from `@ktx/cli` to `@kaelio/ktx`.

This plan implements the next runnable user path: `ktx sl query` installs or
uses the managed `core` Python runtime according to the command's input policy.

## File structure

- Create `packages/cli/src/managed-python-command.ts`: CLI helper for managed
  runtime policy, optional prompt, runtime install, and managed semantic-layer
  compute port creation.
- Create `packages/cli/src/managed-python-command.test.ts`: unit tests for
  ready runtime reuse, `--no-input` failure, `--yes` installation, and
  interactive prompt acceptance.
- Modify `packages/cli/src/sl.ts`: extend `KtxSlArgs` with CLI version and
  runtime install policy for `query`, and use the managed helper when no test
  compute port is injected.
- Modify `packages/cli/src/sl.test.ts`: update existing `query` arguments and
  assert `runKtxSl` delegates default compute creation to the managed helper.
- Modify `packages/cli/src/commands/sl-commands.ts`: add `--yes` and
  `--no-input` to `sl query`, derive the runtime install policy, and pass the
  CLI package version.
- Modify `packages/cli/src/command-schemas.ts`: validate `cliVersion` and
  `runtimeInstallPolicy` on parsed `sl query` arguments.
- Modify `packages/cli/src/index.test.ts`: assert Commander routes the new
  `sl query` runtime policy flags.

### Task 1: Add failing managed Python command helper tests

**Files:**

- Create: `packages/cli/src/managed-python-command.test.ts`
- Test: `packages/cli/src/managed-python-command.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/cli/src/managed-python-command.test.ts` with this content:

```typescript
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
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-command.test.ts
```

Expected: FAIL with an import error for
`./managed-python-command.js`.

### Task 2: Implement the managed Python command helper

**Files:**

- Create: `packages/cli/src/managed-python-command.ts`
- Test: `packages/cli/src/managed-python-command.test.ts`

- [ ] **Step 1: Create the helper**

Create `packages/cli/src/managed-python-command.ts` with this content:

```typescript
import { cancel, confirm, isCancel } from '@clack/prompts';
import { createPythonSemanticLayerComputePort, type KtxSemanticLayerComputePort } from '@ktx/context/daemon';
import type { KtxCliIo } from './cli-runtime.js';
import {
  installManagedPythonRuntime,
  readManagedPythonRuntimeStatus,
  type InstalledKtxRuntimeManifest,
  type KtxRuntimeFeature,
  type ManagedPythonRuntimeInstallOptions,
  type ManagedPythonRuntimeInstallResult,
  type ManagedPythonRuntimeLayout,
  type ManagedPythonRuntimeLayoutOptions,
  type ManagedPythonRuntimeStatus,
} from './managed-python-runtime.js';

export type KtxManagedPythonInstallPolicy = 'prompt' | 'auto' | 'never';

export interface ManagedPythonCommandRuntime {
  layout: ManagedPythonRuntimeLayout;
  manifest: InstalledKtxRuntimeManifest;
}

export interface ManagedPythonCommandDeps {
  readStatus?: (options: ManagedPythonRuntimeLayoutOptions) => Promise<ManagedPythonRuntimeStatus>;
  installRuntime?: (options: ManagedPythonRuntimeInstallOptions) => Promise<ManagedPythonRuntimeInstallResult>;
  confirmInstall?: (message: string) => Promise<boolean>;
}

export interface ManagedPythonCommandOptions extends ManagedPythonCommandDeps {
  cliVersion: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
  feature?: KtxRuntimeFeature;
}

export interface ManagedPythonSemanticLayerComputeOptions extends ManagedPythonCommandOptions {
  createPythonCompute?: typeof createPythonSemanticLayerComputePort;
}

export function managedRuntimeInstallCommand(feature: KtxRuntimeFeature): string {
  return feature === 'local-embeddings'
    ? 'ktx runtime install --feature local-embeddings --yes'
    : 'ktx runtime install --yes';
}

function installPrompt(feature: KtxRuntimeFeature): string {
  const label = feature === 'local-embeddings' ? 'local embeddings Python runtime' : 'core Python runtime';
  return `KTX needs to install the ${label}. This downloads Python dependencies with uv. Continue?`;
}

function runtimeRequiredMessage(feature: KtxRuntimeFeature): string {
  return `KTX Python runtime is required for this command. Run: ${managedRuntimeInstallCommand(feature)}`;
}

function hasFeature(manifest: InstalledKtxRuntimeManifest, feature: KtxRuntimeFeature): boolean {
  return manifest.features.includes(feature);
}

async function defaultConfirmInstall(message: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return false;
  }
  const response = await confirm({ message, initialValue: true });
  if (isCancel(response)) {
    cancel('Runtime installation cancelled.');
    return false;
  }
  return response === true;
}

export async function ensureManagedPythonCommandRuntime(
  options: ManagedPythonCommandOptions,
): Promise<ManagedPythonCommandRuntime> {
  const feature = options.feature ?? 'core';
  const readStatus = options.readStatus ?? readManagedPythonRuntimeStatus;
  const installRuntime = options.installRuntime ?? installManagedPythonRuntime;
  const status = await readStatus({ cliVersion: options.cliVersion });

  if (status.kind === 'ready' && status.manifest && hasFeature(status.manifest, feature)) {
    return { layout: status.layout, manifest: status.manifest };
  }

  if (options.installPolicy === 'never') {
    throw new Error(runtimeRequiredMessage(feature));
  }

  if (options.installPolicy === 'prompt') {
    const confirmInstall = options.confirmInstall ?? defaultConfirmInstall;
    const confirmed = await confirmInstall(installPrompt(feature));
    if (!confirmed) {
      throw new Error(`KTX Python runtime installation was cancelled. Run: ${managedRuntimeInstallCommand(feature)}`);
    }
  }

  options.io.stderr.write(`Installing KTX Python runtime (${feature}) with uv...\n`);
  const installed = await installRuntime({
    cliVersion: options.cliVersion,
    features: [feature],
    force: false,
  });
  options.io.stderr.write(`KTX Python runtime ready: ${installed.layout.versionDir}\n`);
  return { layout: installed.layout, manifest: installed.manifest };
}

export async function createManagedPythonSemanticLayerComputePort(
  options: ManagedPythonSemanticLayerComputeOptions,
): Promise<KtxSemanticLayerComputePort> {
  const runtime = await ensureManagedPythonCommandRuntime({
    cliVersion: options.cliVersion,
    installPolicy: options.installPolicy,
    io: options.io,
    feature: 'core',
    ...(options.readStatus ? { readStatus: options.readStatus } : {}),
    ...(options.installRuntime ? { installRuntime: options.installRuntime } : {}),
    ...(options.confirmInstall ? { confirmInstall: options.confirmInstall } : {}),
  });
  const createPythonCompute = options.createPythonCompute ?? createPythonSemanticLayerComputePort;
  return createPythonCompute({
    command: runtime.manifest.python.daemonExecutable,
    args: [],
  });
}
```

- [ ] **Step 2: Run the helper test**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-command.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/cli/src/managed-python-command.ts packages/cli/src/managed-python-command.test.ts
git commit -m "feat: add managed python command helper"
```

Expected: commit succeeds.

### Task 3: Add failing `runKtxSl` managed runtime tests

**Files:**

- Modify: `packages/cli/src/sl.test.ts`
- Test: `packages/cli/src/sl.test.ts`

- [ ] **Step 1: Add runtime fields to existing `query` test args**

In each existing `runKtxSl` call whose argument object has
`command: 'query'`, add these properties:

```typescript
cliVersion: '0.2.0',
runtimeInstallPolicy: 'auto',
```

For example, the first `query` argument object becomes:

```typescript
{
  command: 'query',
  projectDir: '/tmp/project',
  connectionId: 'warehouse',
  query: { measures: ['orders.order_count'], dimensions: [] },
  format: 'sql',
  execute: false,
  cliVersion: '0.2.0',
  runtimeInstallPolicy: 'auto',
}
```

- [ ] **Step 2: Add the managed helper delegation test**

In `packages/cli/src/sl.test.ts`, add this test inside
`describe('runKtxSl', () => { ... })` after the existing
`runs sl query and prints SQL output` test:

```typescript
  it('creates default sl query compute through the managed runtime helper', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir, projectName: 'warehouse' });
    project.config.connections.warehouse = { driver: 'postgres', readonly: true };
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain: [id]
columns:
  - name: id
    type: number
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const compute = {
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    };
    const createManagedSemanticLayerCompute = vi.fn(async () => compute);

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir,
          connectionId: 'warehouse',
          query: { measures: ['orders.order_count'], dimensions: [] },
          format: 'sql',
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        { stdout, stderr },
        { createManagedSemanticLayerCompute },
      ),
    ).resolves.toBe(0);

    expect(createManagedSemanticLayerCompute).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: { stdout, stderr },
    });
    expect(stdout.write).toHaveBeenCalledWith('select count(*) as order_count from public.orders\n');
  });
```

- [ ] **Step 3: Run the failing `sl` test**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/sl.test.ts
```

Expected: FAIL with a TypeScript/Vitest error because `runKtxSl` does not
accept `createManagedSemanticLayerCompute` yet.

### Task 4: Wire `runKtxSl` to the managed helper

**Files:**

- Modify: `packages/cli/src/sl.ts`
- Test: `packages/cli/src/sl.test.ts`

- [ ] **Step 1: Add the managed helper imports**

In `packages/cli/src/sl.ts`, add this import after the existing imports:

```typescript
import {
  createManagedPythonSemanticLayerComputePort,
  type KtxManagedPythonInstallPolicy,
} from './managed-python-command.js';
```

- [ ] **Step 2: Extend the `query` args type**

In the `KtxSlArgs` union, replace the current `query` object type with this
shape:

```typescript
  | {
      command: 'query';
      projectDir: string;
      connectionId?: string;
      query: SemanticLayerQueryInput;
      format: SlQueryFormat;
      execute: boolean;
      maxRows?: number;
      cliVersion: string;
      runtimeInstallPolicy: KtxManagedPythonInstallPolicy;
    };
```

- [ ] **Step 3: Extend `KtxSlDeps`**

In `packages/cli/src/sl.ts`, replace `KtxSlDeps` with this interface:

```typescript
interface KtxSlDeps {
  loadProject?: typeof loadKtxProject;
  createSemanticLayerCompute?: () => KtxSemanticLayerComputePort;
  createManagedSemanticLayerCompute?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxSlIo;
  }) => Promise<KtxSemanticLayerComputePort>;
  createQueryExecutor?: () => KtxSqlQueryExecutorPort;
}
```

- [ ] **Step 4: Use the managed helper in the `query` branch**

In the `args.command === 'query'` branch, replace:

```typescript
      const compute = (deps.createSemanticLayerCompute ?? createPythonSemanticLayerComputePort)();
```

with:

```typescript
      const compute = deps.createSemanticLayerCompute
        ? deps.createSemanticLayerCompute()
        : await (deps.createManagedSemanticLayerCompute ?? createManagedPythonSemanticLayerComputePort)({
            cliVersion: args.cliVersion,
            installPolicy: args.runtimeInstallPolicy,
            io,
          });
```

- [ ] **Step 5: Run the `sl` test**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/sl.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/cli/src/sl.ts packages/cli/src/sl.test.ts
git commit -m "feat: use managed runtime for sl query compute"
```

Expected: commit succeeds.

### Task 5: Add failing Commander routing tests for `sl query`

**Files:**

- Modify: `packages/cli/src/index.test.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Add routing tests**

In `packages/cli/src/index.test.ts`, add this test near the other command
routing tests:

```typescript
  it('routes sl query managed runtime install policies', async () => {
    const sl = vi.fn(async () => 0);

    const promptIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'sl', 'query', '--measure', 'orders.order_count'], promptIo.io, { sl }),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'query',
        projectDir: tempDir,
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'prompt',
        query: expect.objectContaining({ measures: ['orders.order_count'], dimensions: [] }),
      }),
      promptIo.io,
    );

    const autoIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'sl', 'query', '--measure', 'orders.order_count', '--yes'], autoIo.io, {
        sl,
      }),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'auto',
      }),
      autoIo.io,
    );

    const noInputIo = makeIo();
    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'sl', 'query', '--measure', 'orders.order_count', '--no-input'],
        noInputIo.io,
        { sl },
      ),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cliVersion: '0.0.0-private',
        runtimeInstallPolicy: 'never',
      }),
      noInputIo.io,
    );
  });

  it('rejects conflicting sl query runtime install flags', async () => {
    const io = makeIo();
    const sl = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'sl', 'query', '--measure', 'orders.order_count', '--yes', '--no-input'],
        io.io,
        { sl },
      ),
    ).resolves.toBe(1);

    expect(sl).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });
```

- [ ] **Step 2: Run the failing routing tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/index.test.ts
```

Expected: FAIL because `sl query` does not accept `--yes` or `--no-input`
and does not pass runtime policy fields yet.

### Task 6: Wire `sl query` flags and schema validation

**Files:**

- Modify: `packages/cli/src/commands/sl-commands.ts`
- Modify: `packages/cli/src/command-schemas.ts`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Add the runtime policy type import**

In `packages/cli/src/commands/sl-commands.ts`, add this import:

```typescript
import type { KtxManagedPythonInstallPolicy } from '../managed-python-command.js';
```

- [ ] **Step 2: Add the runtime policy parser**

In `packages/cli/src/commands/sl-commands.ts`, add this function near the
other option parsers:

```typescript
function runtimeInstallPolicy(options: { yes?: boolean; input?: boolean }): KtxManagedPythonInstallPolicy {
  if (options.yes === true && options.input === false) {
    throw new Error('Choose only one runtime install mode: --yes or --no-input');
  }
  if (options.yes === true) {
    return 'auto';
  }
  return options.input === false ? 'never' : 'prompt';
}
```

- [ ] **Step 3: Add the command options**

In the `sl.command('query')` option chain, add these options after
`.option('--execute', 'Execute the compiled query', false)`:

```typescript
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
```

- [ ] **Step 4: Pass runtime fields into `slQueryCommandSchema.parse`**

In the `sl.command('query')` action, add these properties to the parsed object:

```typescript
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicy(options),
```

The parsed object must include these fields next to `execute` and `format`:

```typescript
      const args = slQueryCommandSchema.parse({
        command: 'query',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connectionId,
        query: {
          measures: options.measure,
          dimensions: options.dimension,
          ...(options.filter.length > 0 ? { filters: options.filter } : {}),
          ...(options.segment.length > 0 ? { segments: options.segment } : {}),
          ...(options.orderBy.length > 0 ? { order_by: options.orderBy } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.includeEmpty === true ? { include_empty: true } : {}),
        },
        format: options.format,
        execute: options.execute === true,
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicy(options),
        ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      });
```

- [ ] **Step 5: Extend the command schema**

In `packages/cli/src/command-schemas.ts`, add these fields to
`slQueryCommandSchema` after `execute: z.boolean()`:

```typescript
  cliVersion: z.string().min(1),
  runtimeInstallPolicy: z.enum(['prompt', 'auto', 'never']),
```

- [ ] **Step 6: Run the routing tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/cli/src/commands/sl-commands.ts packages/cli/src/command-schemas.ts packages/cli/src/index.test.ts
git commit -m "feat: route sl query managed runtime policy"
```

Expected: commit succeeds.

### Task 7: Verify the full changed surface

**Files:**

- Verify: `packages/cli/src/managed-python-command.test.ts`
- Verify: `packages/cli/src/sl.test.ts`
- Verify: `packages/cli/src/index.test.ts`
- Verify: `packages/cli/src/managed-python-command.ts`
- Verify: `packages/cli/src/sl.ts`
- Verify: `packages/cli/src/commands/sl-commands.ts`
- Verify: `packages/cli/src/command-schemas.ts`

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-command.test.ts src/sl.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI type checking**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run pre-commit for changed TypeScript files**

Run:

```bash
uv run pre-commit run --files packages/cli/src/managed-python-command.ts packages/cli/src/managed-python-command.test.ts packages/cli/src/sl.ts packages/cli/src/sl.test.ts packages/cli/src/commands/sl-commands.ts packages/cli/src/command-schemas.ts packages/cli/src/index.test.ts
```

Expected: PASS. If pre-commit is unavailable because the local `uv` version
does not satisfy `pyproject.toml`, record the version mismatch and run the
focused CLI tests plus type checking from Steps 1 and 2.

- [ ] **Step 4: Commit verification fixes when needed**

If Step 1, Step 2, or Step 3 changes files through formatting hooks, run:

```bash
git add packages/cli/src/managed-python-command.ts packages/cli/src/managed-python-command.test.ts packages/cli/src/sl.ts packages/cli/src/sl.test.ts packages/cli/src/commands/sl-commands.ts packages/cli/src/command-schemas.ts packages/cli/src/index.test.ts
git commit -m "test: verify managed runtime sl query integration"
```

Expected: commit succeeds only when verification changed files. If no files
changed, leave the branch with the commits from Tasks 2, 4, and 6.

## Acceptance criteria

When this plan is complete:

- `ktx sl query` uses the managed runtime's installed `ktx-daemon` executable
  for semantic-layer compilation when no test compute dependency is injected.
- `ktx sl query --yes` installs the `core` runtime feature without prompting
  when the managed runtime is missing.
- `ktx sl query --no-input` fails with
  `KTX Python runtime is required for this command. Run: ktx runtime install --yes`
  when the managed runtime is missing.
- `ktx sl query` prompts before first managed runtime installation in an
  interactive terminal.
- Existing injected-compute tests still bypass runtime installation.
