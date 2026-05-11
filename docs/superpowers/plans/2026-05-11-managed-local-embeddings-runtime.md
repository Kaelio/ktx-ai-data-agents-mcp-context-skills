# Managed Local Embeddings Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local `sentence-transformers` embedding setup use the
KTX-managed Python runtime and daemon instead of requiring users to start a
manual `ktx-daemon` process.

**Architecture:** Add one managed local-embedding helper in the CLI that
prompts or fails according to the existing runtime install policy, starts the
managed daemon with the `local-embeddings` feature, and returns the daemon URL
for health checks. Store a stable managed-runtime marker in `ktx.yaml`, and
teach context embedding config resolution to turn that marker into a daemon URL
only when the CLI has provided one through the environment.

**Tech Stack:** TypeScript, Vitest, Commander, `@clack/prompts`, KTX managed
Python runtime commands, `@ktx/llm` embedding health checks.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

Existing plans based on the spec:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md` is
  implemented. The worktree contains the runtime wheel builder, runtime wheel
  packaging, the `kaelio-ktx` Python artifact policy entry, and matching
  artifact tests.
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md` is
  implemented. The worktree contains `managed-python-runtime.ts`, the runtime
  command runner, `runtime install`, `status`, `doctor`, and `prune` command
  registration, and matching CLI tests.
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
  is implemented. The worktree contains `managed-python-command.ts`, `ktx sl
  query` runtime policy flags, schema validation, and matching `sl` tests.
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
  is implemented. The worktree contains `managed-python-daemon.ts`, daemon
  state paths in the runtime layout, `runtime start`, `runtime stop`, Python
  `/health` version metadata, and matching TypeScript and Python tests.

Spec requirements still outside this plan:

- Public npm package surface rename from `@ktx/cli` to `@kaelio/ktx`.
- Managed runtime usage for non-embedding Python-backed command paths beyond
  `ktx sl query`.
- Release smoke coverage for `npx @kaelio/ktx ...` invocation modes.

This plan implements the next local-embedding runtime slice:

- Selecting local embeddings installs only the `local-embeddings` runtime
  feature.
- Local embedding setup starts or reuses the managed HTTP daemon.
- `--yes` installs and starts without prompting.
- `--no-input` fails with an exact preparation command when the managed local
  embedding runtime is missing.
- Project config records a managed local embedding marker instead of a random
  daemon port.
- Context embedding resolution only resolves the marker when the CLI provides
  the active daemon URL.

## File structure

- Modify `packages/context/src/llm/local-config.ts`: define the managed local
  embeddings marker and environment variable, and resolve that marker to a
  runtime daemon URL.
- Modify `packages/context/src/llm/local-config.test.ts`: cover marker
  resolution, missing daemon URL behavior, and provider construction.
- Modify `packages/context/src/llm/index.ts`: export the marker constants.
- Modify `packages/context/src/package-exports.test.ts`: assert root exports
  expose the marker constants.
- Create `packages/cli/src/managed-local-embeddings.ts`: start or reuse the
  managed daemon with `local-embeddings` and build health/project configs.
- Create `packages/cli/src/managed-local-embeddings.test.ts`: cover ready,
  `--yes`, prompt, and `--no-input` behavior.
- Modify `packages/cli/src/setup-embeddings.ts`: use the managed helper for
  local embeddings and persist the managed marker.
- Modify `packages/cli/src/setup-embeddings.test.ts`: update local embedding
  setup expectations and no-input failure behavior.
- Modify `packages/cli/src/setup.ts`: pass CLI version and runtime install
  policy into the embeddings step.
- Modify `packages/cli/src/commands/setup-commands.ts`: attach package version
  to setup runs.
- Modify `packages/cli/src/cli-program.ts`: attach package version to the bare
  interactive setup path.
- Modify `packages/cli/src/index.ts`: export the managed local embedding helper
  for tests and programmatic use.
- Modify `packages/cli/src/index.test.ts` and `packages/cli/src/setup.test.ts`:
  update setup argument expectations for `cliVersion`.

### Task 1: Add managed embedding marker resolution in context

**Files:**

- Modify: `packages/context/src/llm/local-config.test.ts`
- Modify: `packages/context/src/llm/local-config.ts`
- Modify: `packages/context/src/llm/index.ts`
- Modify: `packages/context/src/package-exports.test.ts`

- [ ] **Step 1: Write failing marker resolution tests**

In `packages/context/src/llm/local-config.test.ts`, extend the import from
`./local-config.js` so it includes the new constants:

```typescript
import {
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV,
  createLocalKtxEmbeddingProviderFromConfig,
  createLocalKtxLlmProviderFromConfig,
  resolveLocalKtxEmbeddingConfig,
  resolveLocalKtxLlmConfig,
} from './local-config.js';
```

Add these tests inside `describe('local KTX embedding config', () => { ... })`
after the existing `resolves sentence-transformers config` test:

```typescript
  it('resolves managed sentence-transformers config from the CLI-provided daemon URL', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: {
        base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
        pathPrefix: '',
      },
      batchSize: 32,
    };

    expect(
      resolveLocalKtxEmbeddingConfig(config, {
        [MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV]: 'http://127.0.0.1:61234',
      }),
    ).toEqual({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
      batchSize: 32,
    });
  });

  it('returns null for managed sentence-transformers when no daemon URL is available', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: {
        base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
        pathPrefix: '',
      },
    };

    expect(resolveLocalKtxEmbeddingConfig(config, {})).toBeNull();
  });
```

In `packages/context/src/package-exports.test.ts`, add these assertions after
the existing `root.createLocalKtxEmbeddingProviderFromConfig` assertion:

```typescript
    expect(root.MANAGED_SENTENCE_TRANSFORMERS_BASE_URL).toBe('managed:local-embeddings');
    expect(root.MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV).toBe(
      'KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL',
    );
```

- [ ] **Step 2: Run the failing context tests**

Run:

```bash
pnpm --filter @ktx/context run test -- src/llm/local-config.test.ts src/package-exports.test.ts
```

Expected: FAIL with missing exports for
`MANAGED_SENTENCE_TRANSFORMERS_BASE_URL` and
`MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV`.

- [ ] **Step 3: Implement marker resolution**

In `packages/context/src/llm/local-config.ts`, add these exports after the
`LocalConfigDeps` interface:

```typescript
export const MANAGED_SENTENCE_TRANSFORMERS_BASE_URL = 'managed:local-embeddings';
export const MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV = 'KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL';
```

Add this helper before `resolveLocalKtxEmbeddingConfig`:

```typescript
function resolveSentenceTransformersBaseUrl(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value === MANAGED_SENTENCE_TRANSFORMERS_BASE_URL) {
    return resolveOptional(`env:${MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV}`, env);
  }
  return value;
}
```

Replace `resolveLocalKtxEmbeddingConfig` with this implementation:

```typescript
export function resolveLocalKtxEmbeddingConfig(
  config: KtxProjectEmbeddingConfig,
  env: NodeJS.ProcessEnv,
): KtxEmbeddingConfig | null {
  if (config.backend === 'none') {
    return null;
  }
  if (config.backend === 'sentence-transformers') {
    const baseURL = resolveSentenceTransformersBaseUrl(config.sentenceTransformers?.base_url, env);
    if (!baseURL) {
      return null;
    }
    return {
      backend: config.backend,
      model: config.model ?? 'all-MiniLM-L6-v2',
      dimensions: config.dimensions,
      sentenceTransformers: {
        baseURL,
        pathPrefix: config.sentenceTransformers?.pathPrefix,
      },
      batchSize: config.batchSize,
    };
  }
  return {
    backend: config.backend,
    model: config.model ?? 'deterministic',
    dimensions: config.dimensions,
    ...(resolvedProviderConfig(config.openai, env) ? { openai: resolvedProviderConfig(config.openai, env) } : {}),
    batchSize: config.batchSize,
  };
}
```

In `packages/context/src/llm/index.ts`, add the new constants to the existing
export from `./local-config.js`:

```typescript
export {
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV,
  createLocalKtxEmbeddingProviderFromConfig,
  createLocalKtxLlmProviderFromConfig,
  resolveLocalKtxEmbeddingConfig,
  resolveLocalKtxLlmConfig,
} from './local-config.js';
```

- [ ] **Step 4: Verify the context marker tests pass**

Run:

```bash
pnpm --filter @ktx/context run test -- src/llm/local-config.test.ts src/package-exports.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/src/llm/local-config.ts packages/context/src/llm/local-config.test.ts packages/context/src/llm/index.ts packages/context/src/package-exports.test.ts
git commit -m "feat: add managed local embeddings config marker"
```

### Task 2: Add the managed local embeddings CLI helper

**Files:**

- Create: `packages/cli/src/managed-local-embeddings.test.ts`
- Create: `packages/cli/src/managed-local-embeddings.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `packages/cli/src/managed-local-embeddings.test.ts` with this content:

```typescript
import { describe, expect, it, vi } from 'vitest';
import {
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV,
} from '@ktx/context';
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
      daemonStatePath: '/runtime/0.2.0/daemon.json',
      daemonStdoutPath: '/runtime/0.2.0/daemon.stdout.log',
      daemonStderrPath: '/runtime/0.2.0/daemon.stderr.log',
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
    layout: runtime().layout,
    baseUrl: 'http://127.0.0.1:61234',
    state: {
      schemaVersion: 1,
      pid: 12345,
      host: '127.0.0.1',
      port: 61234,
      version: '0.2.0',
      features: ['core', 'local-embeddings'],
      startedAt: '2026-05-11T00:00:00.000Z',
      stdoutLog: '/runtime/0.2.0/daemon.stdout.log',
      stderrLog: '/runtime/0.2.0/daemon.stderr.log',
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
        installPolicy: 'auto',
        io: io.io,
        ensureRuntime,
        startDaemon,
      }),
    ).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:61234',
      env: {
        [MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV]: 'http://127.0.0.1:61234',
      },
    });

    expect(ensureRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
      feature: 'local-embeddings',
    });
    expect(startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      features: ['local-embeddings'],
      force: false,
    });
    expect(io.stderr()).toContain('Started KTX local embeddings daemon: http://127.0.0.1:61234');
  });

  it('reuses an already running daemon without reporting a new start', async () => {
    const io = makeIo();

    await ensureManagedLocalEmbeddingsDaemon({
      cliVersion: '0.2.0',
      installPolicy: 'prompt',
      io: io.io,
      ensureRuntime: vi.fn(async () => runtime()),
      startDaemon: vi.fn(async () => daemonResult('reused')),
    });

    expect(io.stderr()).toContain('Using KTX local embeddings daemon: http://127.0.0.1:61234');
  });
});
```

- [ ] **Step 2: Run the failing helper tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-local-embeddings.test.ts
```

Expected: FAIL with an import error for
`./managed-local-embeddings.js`.

- [ ] **Step 3: Implement the helper**

Create `packages/cli/src/managed-local-embeddings.ts` with this content:

```typescript
import {
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV,
} from '@ktx/context';
import type { KtxProjectEmbeddingConfig } from '@ktx/context/project';
import type { KtxEmbeddingConfig } from '@ktx/llm';
import type { KtxCliIo } from './cli-runtime.js';
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import { startManagedPythonDaemon, type ManagedPythonDaemonStartResult } from './managed-python-daemon.js';

export interface ManagedLocalEmbeddingsDaemon {
  baseUrl: string;
  env: Record<typeof MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV, string>;
}

export interface ManagedLocalEmbeddingsOptions {
  cliVersion: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
  ensureRuntime?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
    feature: 'local-embeddings';
  }) => Promise<ManagedPythonCommandRuntime>;
  startDaemon?: (options: {
    cliVersion: string;
    features: ['local-embeddings'];
    force: boolean;
  }) => Promise<ManagedPythonDaemonStartResult>;
}

export function managedLocalEmbeddingProjectConfig(input: {
  model: string;
  dimensions: number;
}): KtxProjectEmbeddingConfig {
  return {
    backend: 'sentence-transformers',
    model: input.model,
    dimensions: input.dimensions,
    sentenceTransformers: {
      base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
      pathPrefix: '',
    },
  };
}

export function managedLocalEmbeddingHealthConfig(input: {
  baseUrl: string;
  model: string;
  dimensions: number;
}): KtxEmbeddingConfig {
  return {
    backend: 'sentence-transformers',
    model: input.model,
    dimensions: input.dimensions,
    sentenceTransformers: {
      baseURL: input.baseUrl,
      pathPrefix: '',
    },
  };
}

export async function ensureManagedLocalEmbeddingsDaemon(
  options: ManagedLocalEmbeddingsOptions,
): Promise<ManagedLocalEmbeddingsDaemon> {
  const ensureRuntime = options.ensureRuntime ?? ensureManagedPythonCommandRuntime;
  const startDaemon = options.startDaemon ?? startManagedPythonDaemon;

  await ensureRuntime({
    cliVersion: options.cliVersion,
    installPolicy: options.installPolicy,
    io: options.io,
    feature: 'local-embeddings',
  });
  const daemon = await startDaemon({
    cliVersion: options.cliVersion,
    features: ['local-embeddings'],
    force: false,
  });

  const verb = daemon.status === 'started' ? 'Started' : 'Using';
  options.io.stderr.write(`${verb} KTX local embeddings daemon: ${daemon.baseUrl}\n`);

  return {
    baseUrl: daemon.baseUrl,
    env: {
      [MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV]: daemon.baseUrl,
    },
  };
}
```

In `packages/cli/src/index.ts`, add this export after the existing
`managed-python-daemon.js` exports:

```typescript
export {
  ensureManagedLocalEmbeddingsDaemon,
  managedLocalEmbeddingHealthConfig,
  managedLocalEmbeddingProjectConfig,
  type ManagedLocalEmbeddingsDaemon,
  type ManagedLocalEmbeddingsOptions,
} from './managed-local-embeddings.js';
```

- [ ] **Step 4: Verify helper tests pass**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-local-embeddings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/cli/src/managed-local-embeddings.ts packages/cli/src/managed-local-embeddings.test.ts packages/cli/src/index.ts
git commit -m "feat: add managed local embeddings daemon helper"
```

### Task 3: Wire setup embeddings to the managed runtime

**Files:**

- Modify: `packages/cli/src/setup-embeddings.ts`
- Modify: `packages/cli/src/setup-embeddings.test.ts`

- [ ] **Step 1: Write failing setup tests for managed local embeddings**

In `packages/cli/src/setup-embeddings.test.ts`, update the import from
`./setup-embeddings.js` so it also imports the managed install policy type:

```typescript
import {
  type KtxSetupEmbeddingsPromptAdapter,
  runKtxSetupEmbeddingsStep,
} from './setup-embeddings.js';
```

Add this helper near `makePromptAdapter`:

```typescript
function managedDaemon(baseUrl = 'http://127.0.0.1:61234') {
  return {
    baseUrl,
    env: {
      KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL: baseUrl,
    },
  };
}
```

In every `runKtxSetupEmbeddingsStep` call that does not inject an `embeddingBackend:
'openai'`, add these arguments:

```typescript
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
```

In the test named `configures local sentence-transformers embeddings after
interactive selection`, add this dependency:

```typescript
    const ensureLocalEmbeddings = vi.fn(async () => managedDaemon());
```

Pass it in the deps object:

```typescript
      { prompts, env: {}, healthCheck, ensureLocalEmbeddings },
```

Replace the expected health check config in that test with:

```typescript
    expect(ensureLocalEmbeddings).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
    });
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
```

Replace the persisted local embedding expectation in that test with:

```typescript
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { base_url: 'managed:local-embeddings', pathPrefix: '' },
    });
```

Add this new test after the existing non-interactive local embeddings test:

```typescript
  it('fails non-interactive local setup when the managed local embeddings runtime is missing', async () => {
    const io = makeIo();
    const ensureLocalEmbeddings = vi.fn(async () => {
      throw new Error(
        'KTX Python runtime is required for this command. Run: ktx runtime install --feature local-embeddings --yes',
      );
    });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'never',
        skipEmbeddings: false,
      },
      io.io,
      { env: {}, ensureLocalEmbeddings },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain(
      'KTX Python runtime is required for this command. Run: ktx runtime install --feature local-embeddings --yes',
    );
  });
```

- [ ] **Step 2: Run the failing setup tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/setup-embeddings.test.ts
```

Expected: FAIL because `KtxSetupEmbeddingsArgs` has no `cliVersion` or
`runtimeInstallPolicy`, and `KtxSetupEmbeddingsDeps` has no
`ensureLocalEmbeddings`.

- [ ] **Step 3: Update setup embeddings types and imports**

In `packages/cli/src/setup-embeddings.ts`, add these imports:

```typescript
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import {
  ensureManagedLocalEmbeddingsDaemon,
  managedLocalEmbeddingHealthConfig,
  managedLocalEmbeddingProjectConfig,
  type ManagedLocalEmbeddingsDaemon,
} from './managed-local-embeddings.js';
```

Add these fields to `KtxSetupEmbeddingsArgs` after `inputMode`:

```typescript
  cliVersion: string;
  runtimeInstallPolicy: KtxManagedPythonInstallPolicy;
```

Add this dependency to `KtxSetupEmbeddingsDeps`:

```typescript
  ensureLocalEmbeddings?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
  }) => Promise<ManagedLocalEmbeddingsDaemon>;
```

- [ ] **Step 4: Replace manual local daemon messaging and config**

In `packages/cli/src/setup-embeddings.ts`, remove these constants:

```typescript
const LOCAL_EMBEDDING_DAEMON_COMMAND = 'ktx-daemon serve-http --host 127.0.0.1 --port 8765';
const LOCAL_EMBEDDING_DAEMON_DEV_COMMAND =
  'cd ktx && source .venv/bin/activate && uv run ktx-daemon serve-http --host 127.0.0.1 --port 8765';
```

Replace `localEmbeddingSetupMessage` with:

```typescript
function localEmbeddingSetupMessage(message: string): string {
  return [
    `Local embedding health check failed: ${message}`,
    'Local embeddings use the KTX-managed Python runtime.',
    'Prepare the runtime with: ktx runtime start --feature local-embeddings',
    'Use --yes with setup to install and start the runtime without prompting.',
    'The first run may download Python packages and the all-MiniLM-L6-v2 model.',
  ].join('\n');
}
```

Inside `runKtxSetupEmbeddingsStep`, before building `healthConfig`, add this
block after the OpenAI credential block:

```typescript
    let managedLocalEmbeddings: ManagedLocalEmbeddingsDaemon | undefined;
    if (selectedBackend === LOCAL_EMBEDDING_BACKEND) {
      const ensureLocalEmbeddings = deps.ensureLocalEmbeddings ?? ensureManagedLocalEmbeddingsDaemon;
      try {
        managedLocalEmbeddings = await ensureLocalEmbeddings({
          cliVersion: args.cliVersion,
          installPolicy: args.runtimeInstallPolicy,
          io,
        });
      } catch (error) {
        io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return { status: 'failed', projectDir: args.projectDir };
      }
    }
```

Replace the `healthConfig` assignment with:

```typescript
    const healthConfig =
      selectedBackend === LOCAL_EMBEDDING_BACKEND && managedLocalEmbeddings
        ? managedLocalEmbeddingHealthConfig({
            baseUrl: managedLocalEmbeddings.baseUrl,
            model,
            dimensions,
          })
        : buildHealthConfig({
            backend: selectedBackend,
            model,
            dimensions,
            credentialValue,
          });
```

Replace the successful local persistence call inside `if (health.ok) { ... }`
with:

```typescript
      await persistEmbeddingConfig(
        args.projectDir,
        selectedBackend === LOCAL_EMBEDDING_BACKEND
          ? managedLocalEmbeddingProjectConfig({ model, dimensions })
          : buildProjectEmbeddingConfig({
              backend: selectedBackend,
              model,
              dimensions,
              credentialRef,
            }),
      );
```

- [ ] **Step 5: Verify setup embeddings tests pass**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/setup-embeddings.test.ts src/managed-local-embeddings.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/cli/src/setup-embeddings.ts packages/cli/src/setup-embeddings.test.ts
git commit -m "feat: use managed runtime for local embedding setup"
```

### Task 4: Pass runtime policy and CLI version through setup commands

**Files:**

- Modify: `packages/cli/src/setup.ts`
- Modify: `packages/cli/src/commands/setup-commands.ts`
- Modify: `packages/cli/src/cli-program.ts`
- Modify: `packages/cli/src/setup.test.ts`
- Modify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write failing setup argument expectations**

In `packages/cli/src/index.test.ts`, find the test that routes the main setup
command and add `cliVersion: '0.0.0-private'` to the expected setup run
argument object.

Add this assertion to the same test when `--yes` is present:

```typescript
        yes: true,
        cliVersion: '0.0.0-private',
```

In `packages/cli/src/setup.test.ts`, find the setup test that asserts the
embeddings runner arguments. Add these expected fields to the embeddings step
argument object:

```typescript
            cliVersion: '0.2.0',
            runtimeInstallPolicy: 'auto',
```

Add one focused unit test near the other setup flow tests:

```typescript
  it('passes no-input runtime policy to the embeddings step', async () => {
    const io = makeIo();
    const embeddings = vi.fn(async () => ({ status: 'failed' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'existing',
          agents: false,
          agentScope: 'project',
          agentInstallMode: 'cli',
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        io.io,
        {
          project: {
            run: vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir })),
          },
          embeddings,
        },
      ),
    ).resolves.toBe(1);

    expect(embeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'never',
      }),
      io.io,
    );
  });
```

- [ ] **Step 2: Run the failing setup routing tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/setup.test.ts src/index.test.ts
```

Expected: FAIL because setup args do not carry `cliVersion` yet and embeddings
args do not derive `runtimeInstallPolicy`.

- [ ] **Step 3: Add `cliVersion` to setup run args**

In `packages/cli/src/setup.ts`, add this field to the run variant of
`KtxSetupArgs` immediately after `yes`:

```typescript
      cliVersion: string;
```

Add this helper near the other setup helpers:

```typescript
function setupRuntimeInstallPolicy(args: Extract<KtxSetupArgs, { command: 'run' }>): 'prompt' | 'auto' | 'never' {
  if (args.yes) {
    return 'auto';
  }
  return args.inputMode === 'disabled' ? 'never' : 'prompt';
}
```

In the embeddings step call inside `runKtxSetupInner`, add:

```typescript
            cliVersion: args.cliVersion,
            runtimeInstallPolicy: setupRuntimeInstallPolicy(args),
```

- [ ] **Step 4: Pass package version from Commander and bare setup**

In `packages/cli/src/commands/setup-commands.ts`, add this field to the setup
run argument object:

```typescript
      cliVersion: context.packageInfo.version,
```

Place it immediately after `yes: options.yes === true`.

In `packages/cli/src/cli-program.ts`, add this field to the bare interactive
setup argument object inside `runBareInteractiveCommand`:

```typescript
        cliVersion: context.packageInfo.version,
```

Place it immediately after `yes: false`.

- [ ] **Step 5: Verify setup routing tests pass**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/setup.test.ts src/index.test.ts src/setup-embeddings.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/cli/src/setup.ts packages/cli/src/commands/setup-commands.ts packages/cli/src/cli-program.ts packages/cli/src/setup.test.ts packages/cli/src/index.test.ts
git commit -m "feat: pass managed runtime policy through setup"
```

### Task 5: Final verification

**Files:**

- Verify: `packages/context/src/llm/local-config.ts`
- Verify: `packages/cli/src/managed-local-embeddings.ts`
- Verify: `packages/cli/src/setup-embeddings.ts`
- Verify: `packages/cli/src/setup.ts`

- [ ] **Step 1: Run focused context tests**

Run:

```bash
pnpm --filter @ktx/context run test -- src/llm/local-config.test.ts src/package-exports.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-local-embeddings.test.ts src/setup-embeddings.test.ts src/setup.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run TypeScript checks for changed packages**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 4: Run package-level tests if type-check changed public exports**

Run:

```bash
pnpm --filter @ktx/context run test
pnpm --filter @ktx/cli run test
```

Expected: PASS.

- [ ] **Step 5: Run pre-commit for changed files**

Run:

```bash
uv run pre-commit run --files packages/context/src/llm/local-config.ts packages/context/src/llm/local-config.test.ts packages/context/src/llm/index.ts packages/context/src/package-exports.test.ts packages/cli/src/managed-local-embeddings.ts packages/cli/src/managed-local-embeddings.test.ts packages/cli/src/setup-embeddings.ts packages/cli/src/setup-embeddings.test.ts packages/cli/src/setup.ts packages/cli/src/commands/setup-commands.ts packages/cli/src/cli-program.ts packages/cli/src/setup.test.ts packages/cli/src/index.test.ts packages/cli/src/index.ts
```

Expected: PASS. If pre-commit is unavailable because local hook versions are
missing, run the focused tests and type-check commands from steps 1 through 3
and record the pre-commit error.

- [ ] **Step 6: Commit final verification adjustments**

Run this only if final verification required small fixes:

```bash
git add packages/context/src/llm/local-config.ts packages/context/src/llm/local-config.test.ts packages/context/src/llm/index.ts packages/context/src/package-exports.test.ts packages/cli/src/managed-local-embeddings.ts packages/cli/src/managed-local-embeddings.test.ts packages/cli/src/setup-embeddings.ts packages/cli/src/setup-embeddings.test.ts packages/cli/src/setup.ts packages/cli/src/commands/setup-commands.ts packages/cli/src/cli-program.ts packages/cli/src/setup.test.ts packages/cli/src/index.test.ts packages/cli/src/index.ts
git commit -m "test: verify managed local embeddings runtime setup"
```

## Acceptance criteria

- `ktx setup --embedding-backend sentence-transformers --yes` installs the
  `local-embeddings` runtime feature when needed, starts or reuses the managed
  daemon, probes the active daemon URL, and writes `managed:local-embeddings`
  to `ktx.yaml`.
- `ktx setup --embedding-backend sentence-transformers --no-input` fails with
  the exact runtime preparation command when the runtime is missing.
- Existing OpenAI embedding setup behavior is unchanged.
- The project config no longer stores the daemon's random port.
- `resolveLocalKtxEmbeddingConfig` returns a usable `KtxEmbeddingConfig` for
  managed local embeddings only when
  `KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL` is present.
- Focused CLI and context tests pass.

## Self-review

- Spec coverage: This plan covers lazy `local-embeddings` installation after
  local embeddings are selected, separate prompt/no-input behavior, and managed
  daemon reuse for local embedding setup health checks.
- Placeholder scan: This plan contains concrete file paths, code snippets,
  commands, expected outcomes, and commit commands.
- Type consistency: The new `ManagedLocalEmbeddingsDaemon` type, managed marker
  constants, setup argument fields, and helper function names are used
  consistently across tasks.
