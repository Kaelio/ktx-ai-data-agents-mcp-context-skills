# Published Package Managed Runtime Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the post-publication smoke prove that the published
`@kaelio/ktx` package uses the same isolated managed Python runtime across
`npx @kaelio/ktx`, local `npx ktx`, and global `ktx` invocation modes.

**Architecture:** Keep the smoke black-box and network-gated. Strengthen the
command builder so every Python-backed published-package command receives the
same temporary `KTX_RUNTIME_ROOT`, then run a real semantic-layer query through
the direct `npx`, local install, and global install paths instead of checking
only `--version` for local and global binaries.

**Tech Stack:** Node 22 ESM scripts, `node:test`, pnpm, npx, KTX managed Python
runtime, published `@kaelio/ktx` package smoke.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

The following plans are based on that spec and are implemented in this
worktree:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-runtime.md`
- `docs/superpowers/plans/2026-05-11-public-kaelio-ktx-npm-package.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-agent-mcp-semantic-runtime.md`
- `docs/superpowers/plans/2026-05-11-managed-local-ingest-daemon-runtime.md`
- `docs/superpowers/plans/2026-05-11-managed-runtime-docs-and-postgres-smoke-cleanup.md`

Implementation evidence found before writing this plan includes:

- `scripts/build-python-runtime-wheel.mjs` and
  `packages/cli/assets/python/manifest.json`.
- `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/runtime.ts`,
  `packages/cli/src/commands/runtime-commands.ts`,
  `packages/cli/src/managed-python-command.ts`,
  `packages/cli/src/managed-python-daemon.ts`,
  `packages/cli/src/managed-local-embeddings.ts`, and
  `packages/cli/src/managed-python-http.ts`.
- `scripts/build-public-npm-package.mjs`, `scripts/package-artifacts.mjs`,
  `scripts/local-embeddings-runtime-smoke.mjs`, and
  `scripts/published-package-smoke.mjs`.
- `packages/cli/src/agent-runtime.ts`, `packages/cli/src/serve.ts`,
  `packages/cli/src/ingest.ts`, and `packages/cli/src/scan.ts` thread managed
  runtime policy through the Python-backed CLI paths.
- `examples/postgres-historic/scripts/smoke.sh`,
  `examples/postgres-historic/README.md`,
  `examples/package-artifacts/README.md`, and `README.md` now document the
  managed runtime instead of a manual `python-service/` process.

The remaining release-confidence gap is in the post-publication smoke:

- `scripts/published-package-smoke-config.mjs` runs `npx @kaelio/ktx setup
  demo` and `npx @kaelio/ktx sl query ... --yes`, but it does not isolate
  `KTX_RUNTIME_ROOT` for those commands.
- The same smoke installs `@kaelio/ktx` locally and globally, but local and
  global verification only run `--version`.
- The design spec requires the direct `npx @kaelio/ktx`, local `npx ktx`, and
  global `ktx` modes to work for real KTX commands. A semantic-layer query is
  the smallest Python-backed command that proves the bundled managed runtime is
  usable in each mode.

## File structure

- Modify `scripts/published-package-smoke.test.mjs`: expect a shared
  `KTX_RUNTIME_ROOT` in the published smoke commands, expect local and global
  semantic query commands, and cover label classification used by the runner.
- Modify `scripts/published-package-smoke-config.mjs`: derive a temporary
  runtime root from the smoke project directory, merge it with registry
  environment settings, and add local and global `sl query` commands.
- Modify `scripts/published-package-smoke.mjs`: validate the renamed version
  labels and semantic query labels when the smoke runs.

### Task 1: Isolate runtime roots and add real local/global command coverage

**Files:**

- Modify: `scripts/published-package-smoke.test.mjs`
- Modify: `scripts/published-package-smoke-config.mjs`
- Test: `scripts/published-package-smoke.test.mjs`

- [ ] **Step 1: Write the failing command-list test**

In `scripts/published-package-smoke.test.mjs`, replace the existing
`it('builds the full public package smoke command list', ...)` block with this
test:

```javascript
  it('builds the full public package smoke command list', () => {
    assert.deepEqual(
      buildPublishedPackageSmokeCommands(
        config,
        '/tmp/ktx-smoke/demo',
        '/tmp/ktx-smoke/managed-runtime',
      ),
      [
        {
          label: 'published package npx version',
          command: 'npx',
          args: ['--yes', '@kaelio/ktx@latest', '--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package setup demo',
          command: 'npx',
          args: [
            '--yes',
            '@kaelio/ktx@latest',
            'setup',
            'demo',
            '--project-dir',
            '/tmp/ktx-smoke/demo',
            '--no-input',
            '--plain',
          ],
          env: {
            npm_config_registry: 'https://registry.npmjs.org/',
            KTX_RUNTIME_ROOT: '/tmp/ktx-smoke/managed-runtime',
          },
        },
        {
          label: 'published package npx sl query',
          command: 'npx',
          args: [
            '--yes',
            '@kaelio/ktx@latest',
            'sl',
            'query',
            '--project-dir',
            '/tmp/ktx-smoke/demo',
            '--connection-id',
            'orbit_demo',
            '--measure',
            'contracts.contract_count',
            '--format',
            'sql',
            '--yes',
          ],
          env: {
            npm_config_registry: 'https://registry.npmjs.org/',
            KTX_RUNTIME_ROOT: '/tmp/ktx-smoke/managed-runtime',
          },
        },
        {
          label: 'published package local install',
          command: 'pnpm',
          args: ['add', '@kaelio/ktx@latest'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package local version',
          command: 'npx',
          args: ['ktx', '--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package local sl query',
          command: 'npx',
          args: [
            'ktx',
            'sl',
            'query',
            '--project-dir',
            '/tmp/ktx-smoke/demo',
            '--connection-id',
            'orbit_demo',
            '--measure',
            'contracts.contract_count',
            '--format',
            'sql',
            '--yes',
          ],
          env: {
            npm_config_registry: 'https://registry.npmjs.org/',
            KTX_RUNTIME_ROOT: '/tmp/ktx-smoke/managed-runtime',
          },
        },
        {
          label: 'published package global install',
          command: 'pnpm',
          args: ['add', '--global', '@kaelio/ktx@latest'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package global version',
          command: 'ktx',
          args: ['--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package global sl query',
          command: 'ktx',
          args: [
            'sl',
            'query',
            '--project-dir',
            '/tmp/ktx-smoke/demo',
            '--connection-id',
            'orbit_demo',
            '--measure',
            'contracts.contract_count',
            '--format',
            'sql',
            '--yes',
          ],
          env: {
            npm_config_registry: 'https://registry.npmjs.org/',
            KTX_RUNTIME_ROOT: '/tmp/ktx-smoke/managed-runtime',
          },
        },
      ],
    );
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --test scripts/published-package-smoke.test.mjs
```

Expected: FAIL with an `AssertionError` showing that the actual command list
still uses `published package version`, lacks `KTX_RUNTIME_ROOT`, and lacks the
local/global `sl query` commands.

- [ ] **Step 3: Implement the command builder changes**

In `scripts/published-package-smoke-config.mjs`, add this import before the
existing `node:assert/strict` import:

```javascript
import { dirname, join } from 'node:path';
```

In the same file, add these helper functions after
`assertHttpRegistry(registry, label)`:

```javascript
function registryEnv(config) {
  return config.registry ? { npm_config_registry: config.registry } : {};
}

function runtimeCommandEnv(config, runtimeRoot) {
  return { ...registryEnv(config), KTX_RUNTIME_ROOT: runtimeRoot };
}

function semanticQueryArgs(projectDir) {
  return [
    'sl',
    'query',
    '--project-dir',
    projectDir,
    '--connection-id',
    'orbit_demo',
    '--measure',
    'contracts.contract_count',
    '--format',
    'sql',
    '--yes',
  ];
}
```

Replace `buildPublishedPackageNpxCommand()` and
`buildPublishedPackageSmokeCommands()` with this implementation:

```javascript
export function buildPublishedPackageNpxCommand(config, args, label = 'published package command', extraEnv = {}) {
  return {
    label,
    command: 'npx',
    args: ['--yes', publishedPackageSpec(config), ...args],
    env: { ...registryEnv(config), ...extraEnv },
  };
}

export function buildPublishedPackageSmokeCommands(
  config,
  projectDir,
  runtimeRoot = join(dirname(projectDir), 'managed-runtime'),
) {
  const runtimeEnv = runtimeCommandEnv(config, runtimeRoot);
  const packageEnv = registryEnv(config);
  const queryArgs = semanticQueryArgs(projectDir);

  return [
    buildPublishedPackageNpxCommand(config, ['--version'], 'published package npx version'),
    buildPublishedPackageNpxCommand(
      config,
      ['setup', 'demo', '--project-dir', projectDir, '--no-input', '--plain'],
      'published package setup demo',
      { KTX_RUNTIME_ROOT: runtimeRoot },
    ),
    buildPublishedPackageNpxCommand(config, queryArgs, 'published package npx sl query', {
      KTX_RUNTIME_ROOT: runtimeRoot,
    }),
    {
      label: 'published package local install',
      command: 'pnpm',
      args: ['add', publishedPackageSpec(config)],
      env: packageEnv,
    },
    {
      label: 'published package local version',
      command: 'npx',
      args: ['ktx', '--version'],
      env: packageEnv,
    },
    {
      label: 'published package local sl query',
      command: 'npx',
      args: ['ktx', ...queryArgs],
      env: runtimeEnv,
    },
    {
      label: 'published package global install',
      command: 'pnpm',
      args: ['add', '--global', publishedPackageSpec(config)],
      env: packageEnv,
    },
    {
      label: 'published package global version',
      command: 'ktx',
      args: ['--version'],
      env: packageEnv,
    },
    {
      label: 'published package global sl query',
      command: 'ktx',
      args: queryArgs,
      env: runtimeEnv,
    },
  ];
}
```

- [ ] **Step 4: Run the command-list test and verify it passes**

Run:

```bash
node --test scripts/published-package-smoke.test.mjs
```

Expected: PASS for the command construction tests, with remaining failures only
if the runner label validation test from Task 2 has already been added.

- [ ] **Step 5: Commit the command-builder change**

Run:

```bash
git add scripts/published-package-smoke-config.mjs scripts/published-package-smoke.test.mjs
git commit -m "test: cover published package runtime smoke commands"
```

### Task 2: Validate smoke runner labels for the new command list

**Files:**

- Modify: `scripts/published-package-smoke.test.mjs`
- Modify: `scripts/published-package-smoke.mjs`
- Test: `scripts/published-package-smoke.test.mjs`

- [ ] **Step 1: Write the failing label classification test**

In `scripts/published-package-smoke.test.mjs`, replace the import from
`./published-package-smoke.mjs` with this import:

```javascript
import {
  buildPublishedPackageNpxCommand,
  buildPublishedPackageSmokeCommands,
  isPublishedPackageSemanticQueryLabel,
  isPublishedPackageVersionLabel,
  publishedPackageSpec,
  readPublishedPackageSmokeConfig,
} from './published-package-smoke.mjs';
```

Add this test after the `describe('published package smoke command
construction', ...)` block:

```javascript
describe('published package smoke output validation labels', () => {
  it('classifies version and semantic query commands', () => {
    assert.equal(isPublishedPackageVersionLabel('published package npx version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package local version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package global version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package setup demo'), false);

    assert.equal(isPublishedPackageSemanticQueryLabel('published package npx sl query'), true);
    assert.equal(isPublishedPackageSemanticQueryLabel('published package local sl query'), true);
    assert.equal(isPublishedPackageSemanticQueryLabel('published package global sl query'), true);
    assert.equal(isPublishedPackageSemanticQueryLabel('published package local install'), false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --test scripts/published-package-smoke.test.mjs
```

Expected: FAIL with an import error because
`isPublishedPackageSemanticQueryLabel` and `isPublishedPackageVersionLabel` are
not exported yet.

- [ ] **Step 3: Implement label classification and runner validation**

In `scripts/published-package-smoke.mjs`, add these constants and exports after
`const SMOKE_TIMEOUT_MS = 180_000;`:

```javascript
const VERSION_LABELS = new Set([
  'published package npx version',
  'published package local version',
  'published package global version',
]);

const SEMANTIC_QUERY_LABELS = new Set([
  'published package npx sl query',
  'published package local sl query',
  'published package global sl query',
]);

export function isPublishedPackageVersionLabel(label) {
  return VERSION_LABELS.has(label);
}

export function isPublishedPackageSemanticQueryLabel(label) {
  return SEMANTIC_QUERY_LABELS.has(label);
}
```

In `runPublishedPackageSmoke(config)`, replace this block:

```javascript
      if (
        command.label === 'published package version' ||
        command.label === 'published package local binary' ||
        command.label === 'published package global binary'
      ) {
        assert.match(result.stdout, /@kaelio\/ktx /);
      }
      if (command.label === 'published package sl query') {
        assert.match(result.stdout, /SELECT/i);
        assert.match(result.stdout, /contracts/i);
      }
```

with this block:

```javascript
      if (isPublishedPackageVersionLabel(command.label)) {
        assert.match(result.stdout, /@kaelio\/ktx /);
      }
      if (isPublishedPackageSemanticQueryLabel(command.label)) {
        assert.match(result.stdout, /SELECT/i);
        assert.match(result.stdout, /contracts/i);
      }
```

- [ ] **Step 4: Run the label tests and verify they pass**

Run:

```bash
node --test scripts/published-package-smoke.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the runner-label change**

Run:

```bash
git add scripts/published-package-smoke.mjs scripts/published-package-smoke.test.mjs
git commit -m "test: validate published package smoke outputs"
```

### Task 3: Verify release-script compatibility

**Files:**

- Verify: `scripts/published-package-smoke-config.mjs`
- Verify: `scripts/published-package-smoke.mjs`
- Verify: `scripts/published-package-smoke.test.mjs`
- Verify: `scripts/release-readiness.test.mjs`
- Verify: `package.json`

- [ ] **Step 1: Run the focused Node tests**

Run:

```bash
node --test scripts/published-package-smoke.test.mjs scripts/release-readiness.test.mjs
```

Expected: PASS. The release-readiness tests must continue to report the
published package smoke gate without executing the network smoke.

- [ ] **Step 2: Run release readiness**

Run:

```bash
pnpm run release:readiness
```

Expected: PASS and output containing these lines:

```text
Release mode: ci-artifact-only
NPM publish enabled: false
Published package smoke: pending
Published package smoke script: pnpm run release:published-smoke
```

- [ ] **Step 3: Confirm the network smoke stays explicit**

Run:

```bash
rg -n '"release:published-smoke": "node scripts/published-package-smoke.mjs --require-config"' package.json
```

Expected: PASS with one match in `package.json`. Do not run
`pnpm run release:published-smoke` in normal CI before the package is published
to the configured registry.

- [ ] **Step 4: Check pre-commit availability**

Run:

```bash
test ! -f .pre-commit-config.yaml
```

Expected: PASS in the current worktree. If a pre-commit config exists when this
plan is executed, run this instead after activating `.venv`:

```bash
source .venv/bin/activate
uv run pre-commit run --files scripts/published-package-smoke-config.mjs scripts/published-package-smoke.mjs scripts/published-package-smoke.test.mjs
```

- [ ] **Step 5: Commit verification-only fixes if needed**

If Step 1 or Step 2 required additional source changes, commit them with:

```bash
git add scripts/published-package-smoke-config.mjs scripts/published-package-smoke.mjs scripts/published-package-smoke.test.mjs scripts/release-readiness.test.mjs package.json
git commit -m "chore: verify published package runtime smoke"
```

If no files changed after Task 2, do not create an empty commit.

## Acceptance criteria

- `buildPublishedPackageSmokeCommands()` derives
  `<smoke root>/managed-runtime` from the demo project directory by default.
- Direct `npx @kaelio/ktx`, local `npx ktx`, and global `ktx` semantic query
  commands all receive the same `KTX_RUNTIME_ROOT`.
- Local and global post-publication smoke coverage runs `sl query ... --yes`,
  not only `--version`.
- `runPublishedPackageSmoke()` validates version output for all version labels
  and validates generated SQL output for all semantic query labels.
- `node --test scripts/published-package-smoke.test.mjs scripts/release-readiness.test.mjs`
  passes.
- `pnpm run release:readiness` still reports the published-package smoke as a
  pending explicit release gate while registry publishing is disabled.

## Self-review notes

- Spec coverage: this plan covers the remaining invocation-mode confidence gap
  from the spec by proving the published package uses an isolated managed
  runtime across direct `npx`, local binary, and global binary paths.
- Placeholder scan: the plan contains concrete file paths, exact code blocks,
  exact commands, and exact expected outcomes.
- Type consistency: the command label strings are consistent across tests,
  command construction, and smoke-runner output validation.
