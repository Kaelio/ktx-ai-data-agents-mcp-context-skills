# Managed Local Embeddings Release Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in release smoke that proves the public `@kaelio/ktx`
package can install `local-embeddings`, start the managed daemon, compute a real
local embedding, and persist the managed embedding marker through setup.

**Architecture:** Keep the default `artifacts:verify` path lightweight. Add a
separate Node smoke script with an explicit opt-in gate, source-level tests, and
a package script that a release job can run only when large Python and model
downloads are acceptable.

**Tech Stack:** Node 22 ESM scripts, `node:test`, pnpm, uv, KTX managed Python
runtime assets, FastAPI embedding endpoint, sentence-transformers.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

The following plans are based on that spec and are already implemented in this
worktree:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-runtime.md`
- `docs/superpowers/plans/2026-05-11-public-kaelio-ktx-npm-package.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-release-smoke.md`

Implementation evidence found before writing this plan includes:

- `scripts/build-python-runtime-wheel.mjs` and matching tests.
- `packages/cli/src/managed-python-runtime.ts`, `runtime.ts`, and
  `commands/runtime-commands.ts`.
- `packages/cli/src/managed-python-command.ts` and `ktx sl query` runtime
  install policy flags.
- `packages/cli/src/managed-python-daemon.ts` and `ktx runtime start` /
  `ktx runtime stop`.
- `packages/cli/src/managed-local-embeddings.ts`,
  `packages/context/src/llm/local-config.ts`, and setup embedding wiring.
- `scripts/build-public-npm-package.mjs`, `release-policy.json` listing
  `@kaelio/ktx`, and public-package smoke command construction.
- `scripts/package-artifacts.mjs` installed CLI smoke that isolates
  `KTX_RUNTIME_ROOT`, lazily installs the core runtime, runs `ktx sl query`,
  checks runtime status and doctor output, and starts, reuses, and stops the
  core daemon.

The remaining spec gap is the release-check item that permits local embeddings
coverage in a separate job or opt-in check. The default release artifact smoke
must not download `sentence-transformers`, `torch`, or the
`all-MiniLM-L6-v2` model.

## File structure

- Create `scripts/local-embeddings-runtime-smoke.mjs`: an opt-in smoke script
  that consumes the built public npm tarball, installs it in a temporary pnpm
  project, isolates all runtime and model caches, installs the
  `local-embeddings` feature, starts the managed daemon, computes one real
  embedding, runs setup with local embeddings, verifies the managed config
  marker, and stops the daemon.
- Create `scripts/local-embeddings-runtime-smoke.test.mjs`: fast source-level
  tests for opt-in gating, public tarball selection, cache isolation, command
  construction, daemon URL parsing, embedding response validation, and package
  script registration.
- Modify `package.json`: add `release:local-embeddings-smoke` without adding
  it to default `check`, `test`, `artifacts:verify`, or release readiness.

### Task 1: Add failing local embeddings smoke tests

**Files:**

- Create: `scripts/local-embeddings-runtime-smoke.test.mjs`
- Test: `scripts/local-embeddings-runtime-smoke.test.mjs`

- [ ] **Step 1: Write the failing test file**

Create `scripts/local-embeddings-runtime-smoke.test.mjs` with this content:

```javascript
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  buildLocalEmbeddingsSmokeEnv,
  localEmbeddingsSmokeCommands,
  localEmbeddingsSmokeOptIn,
  parseDaemonBaseUrl,
  publicKtxTarballName,
  validateEmbeddingResponse,
} from './local-embeddings-runtime-smoke.mjs';

describe('localEmbeddingsSmokeOptIn', () => {
  it('skips unless the smoke is explicitly enabled', () => {
    assert.deepEqual(localEmbeddingsSmokeOptIn({}, []), {
      run: false,
      message: 'Set KTX_RUN_LOCAL_EMBEDDINGS_SMOKE=1 or pass --force to run the local embeddings smoke.',
    });
  });

  it('runs when the environment opt-in is set', () => {
    assert.deepEqual(localEmbeddingsSmokeOptIn({ KTX_RUN_LOCAL_EMBEDDINGS_SMOKE: '1' }, []), {
      run: true,
    });
  });

  it('runs when --force is present', () => {
    assert.deepEqual(localEmbeddingsSmokeOptIn({}, ['--force']), {
      run: true,
    });
  });
});

describe('publicKtxTarballName', () => {
  it('selects the public @kaelio/ktx tarball name', () => {
    assert.equal(
      publicKtxTarballName(['kaelio-ktx-0.0.0-private.tgz', 'ignore-me.tgz']),
      'kaelio-ktx-0.0.0-private.tgz',
    );
  });

  it('fails when the public package tarball is missing', () => {
    assert.throws(
      () => publicKtxTarballName(['ktx-cli-0.0.0-private.tgz']),
      /Expected exactly one @kaelio\/ktx tarball/,
    );
  });

  it('fails when multiple public package tarballs are present', () => {
    assert.throws(
      () => publicKtxTarballName(['kaelio-ktx-0.1.0.tgz', 'kaelio-ktx-0.2.0.tgz']),
      /Expected exactly one @kaelio\/ktx tarball/,
    );
  });
});

describe('buildLocalEmbeddingsSmokeEnv', () => {
  it('isolates the runtime root and model caches inside the smoke root', () => {
    const env = buildLocalEmbeddingsSmokeEnv('/tmp/ktx-local-embedding-smoke', {
      PATH: '/usr/bin',
    });

    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.KTX_RUN_LOCAL_EMBEDDINGS_SMOKE, '1');
    assert.equal(env.KTX_RUNTIME_ROOT, '/tmp/ktx-local-embedding-smoke/managed-runtime');
    assert.equal(env.HF_HOME, '/tmp/ktx-local-embedding-smoke/hf-home');
    assert.equal(env.TRANSFORMERS_CACHE, '/tmp/ktx-local-embedding-smoke/transformers-cache');
    assert.equal(env.SENTENCE_TRANSFORMERS_HOME, '/tmp/ktx-local-embedding-smoke/sentence-transformers-home');
    assert.equal(env.TORCH_HOME, '/tmp/ktx-local-embedding-smoke/torch-home');
  });
});

describe('localEmbeddingsSmokeCommands', () => {
  it('describes the installed-package commands needed for the smoke', () => {
    const commands = localEmbeddingsSmokeCommands({
      projectDir: '/tmp/ktx-local-embedding-smoke/project',
    });

    assert.deepEqual(commands.map((command) => command.label), [
      'ktx public package version',
      'ktx runtime status missing',
      'ktx runtime install local embeddings',
      'ktx runtime status local embeddings ready',
      'ktx runtime start local embeddings',
      'ktx setup local embeddings',
      'ktx runtime stop local embeddings',
    ]);
    assert.deepEqual(commands[2], {
      label: 'ktx runtime install local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'install', '--feature', 'local-embeddings', '--yes'],
      timeoutMs: 1_200_000,
    });
    assert.deepEqual(commands[4], {
      label: 'ktx runtime start local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'start', '--feature', 'local-embeddings'],
      timeoutMs: 300_000,
    });
    assert.deepEqual(commands[5].args, [
      'exec',
      'ktx',
      'setup',
      '--project-dir',
      '/tmp/ktx-local-embedding-smoke/project',
      '--new',
      '--no-input',
      '--yes',
      '--skip-llm',
      '--embedding-backend',
      'sentence-transformers',
      '--skip-databases',
      '--skip-sources',
      '--skip-agents',
    ]);
  });
});

describe('parseDaemonBaseUrl', () => {
  it('extracts the daemon URL from runtime start output', () => {
    assert.equal(
      parseDaemonBaseUrl('Started KTX Python daemon\nurl: http://127.0.0.1:61234\nfeatures: local-embeddings\n'),
      'http://127.0.0.1:61234',
    );
  });

  it('rejects output without a daemon URL', () => {
    assert.throws(() => parseDaemonBaseUrl('Started KTX Python daemon\n'), /Daemon URL was not printed/);
  });
});

describe('validateEmbeddingResponse', () => {
  it('accepts a finite embedding vector with the expected dimensions', () => {
    validateEmbeddingResponse({ embedding: [0.1, -0.2, 0.3] }, 3);
  });

  it('rejects a vector with the wrong dimensions', () => {
    assert.throws(
      () => validateEmbeddingResponse({ embedding: [0.1, 0.2] }, 3),
      /Expected embedding dimension 3, got 2/,
    );
  });

  it('rejects non-finite embedding values', () => {
    assert.throws(
      () => validateEmbeddingResponse({ embedding: [0.1, Number.NaN, 0.3] }, 3),
      /Embedding value at index 1 is not a finite number/,
    );
  });
});

describe('package script', () => {
  it('registers the opt-in local embeddings smoke command', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.equal(
      packageJson.scripts['release:local-embeddings-smoke'],
      'node scripts/local-embeddings-runtime-smoke.mjs --require-opt-in',
    );
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test scripts/local-embeddings-runtime-smoke.test.mjs
```

Expected: FAIL with an import error for
`./local-embeddings-runtime-smoke.mjs`.

- [ ] **Step 3: Commit the failing tests**

Run:

```bash
git add scripts/local-embeddings-runtime-smoke.test.mjs
git commit -m "test: specify local embeddings release smoke"
```

### Task 2: Implement the opt-in smoke script

**Files:**

- Create: `scripts/local-embeddings-runtime-smoke.mjs`
- Test: `scripts/local-embeddings-runtime-smoke.test.mjs`

- [ ] **Step 1: Create the smoke script**

Create `scripts/local-embeddings-runtime-smoke.mjs` with this content:

```javascript
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(SCRIPT_DIR, '..');
const PUBLIC_NPM_ARTIFACT_DIR = join('dist', 'artifacts', 'npm');
const OPT_IN_MESSAGE =
  'Set KTX_RUN_LOCAL_EMBEDDINGS_SMOKE=1 or pass --force to run the local embeddings smoke.';

export function localEmbeddingsSmokeOptIn(env = process.env, args = process.argv.slice(2)) {
  if (env.KTX_RUN_LOCAL_EMBEDDINGS_SMOKE === '1' || args.includes('--force')) {
    return { run: true };
  }
  return { run: false, message: OPT_IN_MESSAGE };
}

export function publicKtxTarballName(files) {
  const matches = files.filter((file) => /^kaelio-ktx-.+\.tgz$/.test(file)).sort();
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one @kaelio/ktx tarball in ${PUBLIC_NPM_ARTIFACT_DIR}, found ${matches.length}: ${
        matches.join(', ') || 'none'
      }. Run pnpm run artifacts:build first.`,
    );
  }
  return matches[0];
}

export async function selectPublicKtxTarball(rootDir = DEFAULT_ROOT_DIR) {
  const npmArtifactDir = join(rootDir, PUBLIC_NPM_ARTIFACT_DIR);
  const files = await readdir(npmArtifactDir);
  return join(npmArtifactDir, publicKtxTarballName(files));
}

export function buildLocalEmbeddingsSmokeEnv(root, baseEnv = process.env) {
  return {
    ...baseEnv,
    KTX_RUN_LOCAL_EMBEDDINGS_SMOKE: '1',
    KTX_RUNTIME_ROOT: join(root, 'managed-runtime'),
    HF_HOME: join(root, 'hf-home'),
    TRANSFORMERS_CACHE: join(root, 'transformers-cache'),
    SENTENCE_TRANSFORMERS_HOME: join(root, 'sentence-transformers-home'),
    TORCH_HOME: join(root, 'torch-home'),
  };
}

export function localEmbeddingsSmokeCommands(input) {
  return [
    {
      label: 'ktx public package version',
      command: 'pnpm',
      args: ['exec', 'ktx', '--version'],
      timeoutMs: 60_000,
    },
    {
      label: 'ktx runtime status missing',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'status', '--json'],
      timeoutMs: 60_000,
    },
    {
      label: 'ktx runtime install local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'install', '--feature', 'local-embeddings', '--yes'],
      timeoutMs: 1_200_000,
    },
    {
      label: 'ktx runtime status local embeddings ready',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'status', '--json'],
      timeoutMs: 60_000,
    },
    {
      label: 'ktx runtime start local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'start', '--feature', 'local-embeddings'],
      timeoutMs: 300_000,
    },
    {
      label: 'ktx setup local embeddings',
      command: 'pnpm',
      args: [
        'exec',
        'ktx',
        'setup',
        '--project-dir',
        input.projectDir,
        '--new',
        '--no-input',
        '--yes',
        '--skip-llm',
        '--embedding-backend',
        'sentence-transformers',
        '--skip-databases',
        '--skip-sources',
        '--skip-agents',
      ],
      timeoutMs: 900_000,
    },
    {
      label: 'ktx runtime stop local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'runtime', 'stop'],
      timeoutMs: 60_000,
    },
  ];
}

export function parseDaemonBaseUrl(stdout) {
  const match = stdout.match(/^url: (http:\/\/127\.0\.0\.1:\d+)$/m);
  if (!match) {
    throw new Error(`Daemon URL was not printed by runtime start:\n${stdout}`);
  }
  return match[1];
}

export function validateEmbeddingResponse(raw, expectedDimensions) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Embedding response must be a JSON object');
  }
  const embedding = raw.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('Embedding response must include an embedding array');
  }
  if (embedding.length !== expectedDimensions) {
    throw new Error(`Expected embedding dimension ${expectedDimensions}, got ${embedding.length}`);
  }
  for (const [index, value] of embedding.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Embedding value at index ${index} is not a finite number`);
    }
  }
}

async function run(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      timeout: options.timeoutMs ?? 120_000,
    });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : error.message;
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout,
      stderr,
    };
  }
}

function requireSuccess(label, result, options = {}) {
  if (result.code !== 0) {
    throw new Error(`${label} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (options.stderrPattern && !options.stderrPattern.test(result.stderr)) {
    throw new Error(`${label} stderr did not match ${options.stderrPattern}\nstderr:\n${result.stderr}`);
  }
}

function parseJsonStdout(label, result) {
  requireSuccess(label, result);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not write JSON stdout: ${error.message}\nstdout:\n${result.stdout}`);
  }
}

function requireOutput(label, result, pattern) {
  if (!pattern.test(result.stdout)) {
    throw new Error(`${label} stdout did not match ${pattern}\nstdout:\n${result.stdout}`);
  }
}

async function postJson(baseUrl, path, payload, timeoutMs) {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`POST ${path} returned non-JSON response: ${error.message}\n${text}`);
  }
}

async function writeSmokePackage(projectDir, tarballPath) {
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'ktx-local-embeddings-runtime-smoke',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@kaelio/ktx': `file:${tarballPath}`,
        },
      },
      null,
      2,
    )}\n`,
  );
}

export async function runLocalEmbeddingsRuntimeSmoke(options = {}) {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const tarballPath = options.tarballPath ?? (await selectPublicKtxTarball(rootDir));
  const root = await mkdtemp(join(tmpdir(), 'ktx-local-embeddings-smoke-'));
  const keepTemp = options.keepTemp ?? process.env.KTX_KEEP_LOCAL_EMBEDDINGS_SMOKE === '1';
  const installDir = join(root, 'installed-package');
  const projectDir = join(root, 'project');
  const smokeEnv = buildLocalEmbeddingsSmokeEnv(root);
  const commands = localEmbeddingsSmokeCommands({ projectDir });
  let daemonStarted = false;

  try {
    await writeSmokePackage(installDir, tarballPath);
    requireSuccess(
      'pnpm install public package',
      await run('pnpm', ['install', '--ignore-scripts=false'], {
        cwd: installDir,
        env: smokeEnv,
        timeoutMs: 300_000,
      }),
    );

    const version = await run(commands[0].command, commands[0].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[0].timeoutMs,
    });
    requireSuccess(commands[0].label, version);
    requireOutput(commands[0].label, version, /@kaelio\/ktx 0\.0\.0-private/);

    const missingStatus = parseJsonStdout(
      commands[1].label,
      await run(commands[1].command, commands[1].args, {
        cwd: installDir,
        env: smokeEnv,
        timeoutMs: commands[1].timeoutMs,
      }),
    );
    if (missingStatus.kind !== 'missing') {
      throw new Error(`Expected missing runtime before install, got ${JSON.stringify(missingStatus)}`);
    }

    const install = await run(commands[2].command, commands[2].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[2].timeoutMs,
    });
    requireSuccess(commands[2].label, install);
    requireOutput(commands[2].label, install, /Installed KTX Python runtime/);
    requireOutput(commands[2].label, install, /features: core, local-embeddings/);

    const readyStatus = parseJsonStdout(
      commands[3].label,
      await run(commands[3].command, commands[3].args, {
        cwd: installDir,
        env: smokeEnv,
        timeoutMs: commands[3].timeoutMs,
      }),
    );
    if (readyStatus.kind !== 'ready') {
      throw new Error(`Expected ready runtime after install, got ${JSON.stringify(readyStatus)}`);
    }
    if (!readyStatus.manifest?.features?.includes('local-embeddings')) {
      throw new Error(`Runtime manifest did not include local-embeddings: ${JSON.stringify(readyStatus.manifest)}`);
    }

    const start = await run(commands[4].command, commands[4].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[4].timeoutMs,
    });
    requireSuccess(commands[4].label, start);
    daemonStarted = true;
    const baseUrl = parseDaemonBaseUrl(start.stdout);

    const embeddingResponse = await postJson(
      baseUrl,
      '/embeddings/compute',
      { text: 'KTX local embeddings release smoke' },
      900_000,
    );
    validateEmbeddingResponse(embeddingResponse, 384);
    process.stdout.write('KTX local embeddings daemon computed a 384-dimensional embedding\n');

    const setup = await run(commands[5].command, commands[5].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[5].timeoutMs,
    });
    requireSuccess(commands[5].label, setup);
    requireOutput(commands[5].label, setup, /Embeddings ready: yes \(all-MiniLM-L6-v2\)/);

    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf8');
    if (!config.includes('base_url: managed:local-embeddings')) {
      throw new Error(`ktx.yaml did not contain managed local embeddings marker:\n${config}`);
    }
    process.stdout.write('KTX setup persisted managed local embeddings marker\n');

    const stop = await run(commands[6].command, commands[6].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[6].timeoutMs,
    });
    requireSuccess(commands[6].label, stop);
    daemonStarted = false;
    requireOutput(commands[6].label, stop, /Stopped KTX Python daemon/);

    process.stdout.write('KTX local embeddings runtime smoke verified\n');
  } finally {
    if (daemonStarted) {
      await run('pnpm', ['exec', 'ktx', 'runtime', 'stop'], {
        cwd: installDir,
        env: smokeEnv,
        timeoutMs: 60_000,
      });
    }
    if (!keepTemp) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stdout.write(`Kept local embeddings smoke root: ${root}\n`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const optIn = localEmbeddingsSmokeOptIn(process.env, args);
  if (!optIn.run) {
    process.stdout.write(`Skipping KTX local embeddings runtime smoke. ${optIn.message}\n`);
    if (args.includes('--require-opt-in')) {
      process.exitCode = 1;
    }
    return;
  }

  await runLocalEmbeddingsRuntimeSmoke();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 2: Run the smoke test**

Run:

```bash
node --test scripts/local-embeddings-runtime-smoke.test.mjs
```

Expected: FAIL only in the package script test because
`release:local-embeddings-smoke` is not registered yet.

- [ ] **Step 3: Commit the smoke script**

Run:

```bash
git add scripts/local-embeddings-runtime-smoke.mjs
git commit -m "feat: add local embeddings runtime smoke"
```

### Task 3: Register the opt-in package script

**Files:**

- Modify: `package.json`
- Test: `scripts/local-embeddings-runtime-smoke.test.mjs`

- [ ] **Step 1: Add the package script**

In `package.json`, add this script immediately after
`"release:published-smoke"`:

```json
"release:local-embeddings-smoke": "node scripts/local-embeddings-runtime-smoke.mjs --require-opt-in",
```

The surrounding `scripts` section must contain this sequence after the edit:

```json
"release:published-smoke": "node scripts/published-package-smoke.mjs --require-config",
"release:local-embeddings-smoke": "node scripts/local-embeddings-runtime-smoke.mjs --require-opt-in",
"release:readiness": "node scripts/release-readiness.mjs",
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
node --test scripts/local-embeddings-runtime-smoke.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Verify the script stays opt-in**

Run:

```bash
pnpm run release:local-embeddings-smoke
```

Expected: FAIL with:

```text
Skipping KTX local embeddings runtime smoke. Set KTX_RUN_LOCAL_EMBEDDINGS_SMOKE=1 or pass --force to run the local embeddings smoke.
```

The command must exit non-zero because `--require-opt-in` is present. This
protects local and CI runs from downloading large dependencies by accident.

- [ ] **Step 4: Commit the package script**

Run:

```bash
git add package.json
git commit -m "chore: register local embeddings smoke"
```

### Task 4: Verify the opt-in smoke path

**Files:**

- Verify: `scripts/local-embeddings-runtime-smoke.mjs`
- Verify: `scripts/local-embeddings-runtime-smoke.test.mjs`
- Verify: `package.json`

- [ ] **Step 1: Run fast script tests**

Run:

```bash
node --test scripts/local-embeddings-runtime-smoke.test.mjs scripts/package-artifacts.test.mjs
```

Expected: PASS. Existing package artifact tests must still prove that the
default npm artifact smoke does not prepare an external Python environment or
run local embeddings downloads.

- [ ] **Step 2: Build release artifacts for the smoke**

Run:

```bash
pnpm run artifacts:build
```

Expected: PASS and `dist/artifacts/npm/` contains exactly one
`kaelio-ktx-*.tgz` tarball.

- [ ] **Step 3: Run the opt-in local embeddings smoke**

Run this only in an environment where downloading `sentence-transformers`,
`torch`, and `all-MiniLM-L6-v2` is acceptable:

```bash
KTX_RUN_LOCAL_EMBEDDINGS_SMOKE=1 pnpm run release:local-embeddings-smoke
```

Expected: PASS with output containing:

```text
KTX local embeddings daemon computed a 384-dimensional embedding
KTX setup persisted managed local embeddings marker
KTX local embeddings runtime smoke verified
```

- [ ] **Step 4: Run release readiness**

Run:

```bash
pnpm run release:readiness
```

Expected: PASS. The readiness report must not require
`release:local-embeddings-smoke`; that smoke remains a separately triggered
release job.

- [ ] **Step 5: Run pre-commit for changed files when configured**

Run:

```bash
uv run pre-commit run --files scripts/local-embeddings-runtime-smoke.mjs scripts/local-embeddings-runtime-smoke.test.mjs package.json
```

Expected: PASS. If pre-commit is unavailable in the environment, record the
tooling failure and keep the previous verification output.

- [ ] **Step 6: Commit verification fixes if needed**

If verification required edits, run:

```bash
git add scripts/local-embeddings-runtime-smoke.mjs scripts/local-embeddings-runtime-smoke.test.mjs package.json
git commit -m "fix: verify local embeddings smoke"
```

Skip this commit when no files changed after the previous commits.

## Acceptance criteria

- `node --test scripts/local-embeddings-runtime-smoke.test.mjs` passes.
- `pnpm run release:local-embeddings-smoke` fails fast without the opt-in
  environment variable and prints the exact opt-in guidance.
- `KTX_RUN_LOCAL_EMBEDDINGS_SMOKE=1 pnpm run release:local-embeddings-smoke`
  installs the public `@kaelio/ktx` tarball into a clean project, isolates
  `KTX_RUNTIME_ROOT` and model caches, installs `local-embeddings`, starts the
  managed daemon, computes a 384-dimensional embedding through
  `/embeddings/compute`, runs setup with `--embedding-backend
  sentence-transformers`, verifies `base_url: managed:local-embeddings` in
  `ktx.yaml`, and stops the daemon.
- The default `pnpm run artifacts:verify`, `pnpm run release:readiness`, and
  `pnpm run check` paths do not run the local embeddings smoke.

## Self-review

- Spec coverage: this plan covers the remaining release-check item for local
  embeddings in a separate job or opt-in check. Earlier implemented plans cover
  the bundled wheel, managed runtime installer, `sl query` command integration,
  daemon lifecycle, managed local embeddings runtime behavior, public npm
  package assembly, and default core runtime release smoke.
- Placeholder scan: no steps contain placeholder implementation language.
- Type consistency: runtime feature names are consistently `core` and
  `local-embeddings`; the public npm package name is `@kaelio/ktx`; the opt-in
  environment variable is `KTX_RUN_LOCAL_EMBEDDINGS_SMOKE`; the managed local
  embedding marker remains `managed:local-embeddings`.
