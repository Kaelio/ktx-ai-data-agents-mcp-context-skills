# Managed Runtime uv Prerequisite Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining npm-managed Python runtime open decision by
making `uv` a documented, release-policy-checked prerequisite.

**Architecture:** Keep the runtime installer behavior simple: the CLI locates
`uv` on `PATH` and prints a focused error when it is missing. Encode that
decision in `release-policy.json`, validate it during release readiness, use one
shared runtime error message, and document the prerequisite in public docs.

**Tech Stack:** Node 22 ESM scripts, `node:test`, TypeScript, Vitest, JSON
release policy, Markdown.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

The following plan files are based on that spec and are already implemented in
this worktree:

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
- `docs/superpowers/plans/2026-05-11-published-package-managed-runtime-smoke.md`
- `docs/superpowers/plans/2026-05-11-public-npm-release-handoff.md`
- `docs/superpowers/plans/2026-05-11-managed-runtime-prune-smoke-and-docs.md`

Implementation evidence found before writing this plan includes:

- `packages/cli/assets/python/manifest.json` and the bundled
  `kaelio_ktx-0.1.0-py3-none-any.whl`.
- `packages/cli/src/managed-python-runtime.ts`, including runtime roots,
  bundled wheel verification, install, status, doctor, and prune behavior.
- `packages/cli/src/managed-python-command.ts`,
  `packages/cli/src/managed-python-daemon.ts`,
  `packages/cli/src/managed-local-embeddings.ts`, and
  `packages/cli/src/managed-python-http.ts`.
- `scripts/build-public-npm-package.mjs`, `scripts/package-artifacts.mjs`,
  `scripts/published-package-smoke.mjs`,
  `scripts/local-embeddings-runtime-smoke.mjs`, and
  `scripts/publish-public-npm-package.mjs`.
- `release-policy.json` is already in `npm-public-release-ready` mode for
  `@kaelio/ktx` `0.1.0` and keeps Python package publishing disabled.
- `README.md` and `examples/package-artifacts/README.md` document the managed
  runtime command family, including `runtime prune`.

The remaining spec gap is the open decision in
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`:

```text
KTX still needs a final decision on whether uv is a hard prerequisite or a
bootstrap dependency that KTX downloads automatically.
```

This plan chooses the hard-prerequisite path for the first public release. KTX
will not download `uv` automatically in this release.

## File structure

- Modify `release-policy.json`: add a `runtimeInstaller` policy section that
  records the hard `uv` prerequisite decision.
- Modify `scripts/release-readiness.mjs`: validate the runtime installer
  policy, include it in readiness reports, and print it in text output.
- Modify `scripts/release-readiness.test.mjs`: cover the accepted policy and
  rejection paths for missing or bootstrap-style `uv` policies.
- Modify `packages/cli/src/managed-python-runtime.ts`: export one shared
  missing-`uv` message and use it for install and doctor output.
- Modify `packages/cli/src/managed-python-runtime.test.ts`: cover install and
  doctor behavior when `uv` is missing.
- Modify `scripts/examples-docs.test.mjs`: require public docs to state the
  hard `uv` prerequisite.
- Modify `README.md`: document that `uv` must be on `PATH` and KTX does not
  download it automatically.
- Modify `examples/package-artifacts/README.md`: document the artifact smoke
  `uv` prerequisite.

### Task 1: Encode the runtime installer policy

**Files:**

- Modify: `release-policy.json`
- Modify: `scripts/release-readiness.test.mjs`
- Modify: `scripts/release-readiness.mjs`
- Test: `scripts/release-readiness.test.mjs`

- [ ] **Step 1: Add failing release policy tests**

In `scripts/release-readiness.test.mjs`, inside the `releasePolicy()` helper
return value, add the `runtimeInstaller` object immediately after
`publishedPackageSmoke`:

```javascript
    runtimeInstaller: {
      uvStrategy: 'path-prerequisite',
      bootstrapUv: false,
      missingUvBehavior: 'focused-error',
    },
```

In the three `assert.deepEqual(report, { ... })` expectations, add this field
immediately after `publishedPackageSmokeGate`:

```javascript
        runtimeInstaller: {
          uvStrategy: 'path-prerequisite',
          bootstrapUv: false,
          missingUvBehavior: 'focused-error',
        },
```

Add these tests immediately after the
`it('accepts the npm public release ready policy', async () => { ... })` block:

```javascript
  it('rejects npm public release ready mode without a runtime installer policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-runtime-policy-missing-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          releaseMode: 'npm-public-release-ready',
          npm: {
            publish: true,
            registry: null,
            access: 'public',
            tag: 'latest',
          },
          publishedPackageSmoke: {
            packageName: '@kaelio/ktx',
            version: PUBLIC_NPM_PACKAGE_VERSION,
            registry: null,
          },
          runtimeInstaller: undefined,
          requiredBeforePublishing: [],
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /Release policy runtimeInstaller must be a JSON object/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects uv bootstrap download policy for the first public npm release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-runtime-policy-bootstrap-test-'));
    try {
      await writeReadyFixture(root, {
        policy: releasePolicy({
          releaseMode: 'npm-public-release-ready',
          npm: {
            publish: true,
            registry: null,
            access: 'public',
            tag: 'latest',
          },
          publishedPackageSmoke: {
            packageName: '@kaelio/ktx',
            version: PUBLIC_NPM_PACKAGE_VERSION,
            registry: null,
          },
          runtimeInstaller: {
            uvStrategy: 'bootstrap-download',
            bootstrapUv: true,
            missingUvBehavior: 'download',
          },
          requiredBeforePublishing: [],
        }),
      });

      await assert.rejects(
        () => releaseReadinessReport(root),
        /Release policy runtimeInstaller\.uvStrategy must be path-prerequisite/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the release readiness tests and verify failure**

Run:

```bash
node --test scripts/release-readiness.test.mjs
```

Expected: FAIL because `releaseReadinessReport()` does not include
`runtimeInstaller`, and `validateReleasePolicy()` does not validate the new
policy section.

- [ ] **Step 3: Validate the runtime installer policy**

In `scripts/release-readiness.mjs`, add this function immediately after the
`assertRequiredBeforePublishing(policy)` function definition:

```javascript
function assertRuntimeInstallerPolicy(policy) {
  assertPlainObject(policy.runtimeInstaller, 'Release policy runtimeInstaller');
  assertString(policy.runtimeInstaller.uvStrategy, 'Release policy runtimeInstaller.uvStrategy');
  assertBoolean(policy.runtimeInstaller.bootstrapUv, 'Release policy runtimeInstaller.bootstrapUv');
  assertString(
    policy.runtimeInstaller.missingUvBehavior,
    'Release policy runtimeInstaller.missingUvBehavior',
  );

  if (policy.runtimeInstaller.uvStrategy !== 'path-prerequisite') {
    throw new Error('Release policy runtimeInstaller.uvStrategy must be path-prerequisite');
  }
  if (policy.runtimeInstaller.bootstrapUv !== false) {
    throw new Error('Release policy runtimeInstaller.bootstrapUv must be false');
  }
  if (policy.runtimeInstaller.missingUvBehavior !== 'focused-error') {
    throw new Error('Release policy runtimeInstaller.missingUvBehavior must be focused-error');
  }
}
```

In `validateReleasePolicy(policy)`, add this call immediately after
`assertRequiredBeforePublishing(policy);`:

```javascript
  assertRuntimeInstallerPolicy(policy);
```

In `releaseReadinessReport(rootDir = scriptRootDir())`, add
`runtimeInstaller` to the returned object immediately after
`publishedPackageSmokeGate`:

```javascript
    runtimeInstaller: policy.runtimeInstaller,
```

In `main()`, add these lines immediately after the published package smoke
registry line:

```javascript
  process.stdout.write(`Runtime uv strategy: ${report.runtimeInstaller.uvStrategy}\n`);
  process.stdout.write(
    `Runtime uv bootstrap: ${report.runtimeInstaller.bootstrapUv ? 'enabled' : 'disabled'}\n`,
  );
```

- [ ] **Step 4: Encode the policy in `release-policy.json`**

Replace `release-policy.json` with this exact content:

```json
{
  "schemaVersion": 1,
  "releaseMode": "npm-public-release-ready",
  "npm": {
    "publish": true,
    "registry": null,
    "access": "public",
    "tag": "latest",
    "packages": ["@kaelio/ktx"]
  },
  "python": {
    "publish": false,
    "repository": null,
    "packages": ["ktx-sl", "ktx-daemon", "kaelio-ktx"]
  },
  "publishedPackageSmoke": {
    "packageName": "@kaelio/ktx",
    "version": "0.1.0",
    "registry": null
  },
  "runtimeInstaller": {
    "uvStrategy": "path-prerequisite",
    "bootstrapUv": false,
    "missingUvBehavior": "focused-error"
  },
  "requiredBeforePublishing": []
}
```

- [ ] **Step 5: Run the release readiness tests and verify success**

Run:

```bash
node --test scripts/release-readiness.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the release policy contract**

```bash
git add release-policy.json scripts/release-readiness.mjs scripts/release-readiness.test.mjs
git commit -m "chore: encode uv runtime prerequisite policy"
```

### Task 2: Centralize missing-uv runtime output

**Files:**

- Modify: `packages/cli/src/managed-python-runtime.test.ts`
- Modify: `packages/cli/src/managed-python-runtime.ts`
- Test: `packages/cli/src/managed-python-runtime.test.ts`

- [ ] **Step 1: Add failing missing-uv runtime tests**

In `packages/cli/src/managed-python-runtime.test.ts`, add
`MISSING_UV_RUNTIME_INSTALL_MESSAGE` to the import from
`./managed-python-runtime.js`:

```typescript
import {
  MISSING_UV_RUNTIME_INSTALL_MESSAGE,
  doctorManagedPythonRuntime,
  installManagedPythonRuntime,
  managedPythonRuntimeLayout,
  pruneManagedPythonRuntimes,
  readManagedPythonRuntimeStatus,
  verifyRuntimeAsset,
  type ManagedPythonRuntimeExec,
} from './managed-python-runtime.js';
```

Inside `describe('installManagedPythonRuntime', () => { ... })`, add this test
after the local embeddings test:

```typescript
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
```

Inside `describe('doctorManagedPythonRuntime', () => { ... })`, add this test
after the existing doctor test:

```typescript
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
      fix: 'Install uv, make sure it is on PATH, and run: ktx runtime install --yes',
    });
  });
```

- [ ] **Step 2: Run the runtime tests and verify failure**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-runtime.test.ts
```

Expected: FAIL because the shared message constant does not exist and the
doctor fix text still uses the older message.

- [ ] **Step 3: Add the shared missing-uv message**

In `packages/cli/src/managed-python-runtime.ts`, add this export immediately
after the `ManagedPythonRuntimePruneResult` interface:

```typescript
export const MISSING_UV_RUNTIME_INSTALL_MESSAGE =
  'uv is required to install the KTX Python runtime. KTX does not download uv automatically. Install uv, make sure it is on PATH, and retry: ktx runtime install --yes';
```

Replace the body of the `catch` block in `ensureUv()` with:

```typescript
    throw new Error(MISSING_UV_RUNTIME_INSTALL_MESSAGE);
```

In `doctorManagedPythonRuntime()`, replace the `fix` value for the `uv` check
with:

```typescript
        fix: 'Install uv, make sure it is on PATH, and run: ktx runtime install --yes',
```

- [ ] **Step 4: Run the runtime tests and verify success**

Run:

```bash
pnpm --filter @ktx/cli run test -- src/managed-python-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the runtime output contract**

```bash
git add packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts
git commit -m "fix: clarify missing uv runtime error"
```

### Task 3: Document the hard uv prerequisite

**Files:**

- Modify: `scripts/examples-docs.test.mjs`
- Modify: `README.md`
- Modify: `examples/package-artifacts/README.md`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Add failing docs assertions**

In `scripts/examples-docs.test.mjs`, inside
`it('documents public npm and managed runtime usage in the README', ... )`, add
these assertions immediately after the existing `ktx runtime prune --yes`
assertion:

```javascript
    assert.match(rootReadme, /KTX requires `uv` on `PATH`/);
    assert.match(rootReadme, /KTX doesn't download `uv` automatically/);
```

Inside `it('documents the public package artifact smoke shape', ... )`, add
this assertion immediately after the `managed Python runtime` assertion:

```javascript
    assert.match(readme, /requires `uv` on `PATH`/);
```

- [ ] **Step 2: Run the docs test and verify failure**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL because the README files do not state the hard `uv`
prerequisite.

- [ ] **Step 3: Update the root README runtime section**

In `README.md`, in the `## Managed Python runtime` section, replace this
paragraph:

```markdown
KTX installs its Python runtime only when a Python-backed command needs it.
The runtime lives outside the npm cache, is versioned by the installed CLI
version, and is managed by `ktx runtime` commands:
```

With:

```markdown
KTX installs its Python runtime only when a Python-backed command needs it.
The runtime lives outside the npm cache, is versioned by the installed CLI
version, and is managed by `ktx runtime` commands.

KTX requires `uv` on `PATH` to create the managed runtime. Install `uv` with
your system package manager or the official installer before running Python-
backed KTX commands. KTX doesn't download `uv` automatically; run
`ktx runtime doctor` if runtime installation fails:
```

- [ ] **Step 4: Update the package artifact smoke README**

In `examples/package-artifacts/README.md`, replace this paragraph:

```markdown
The managed Python runtime smoke isolates `KTX_RUNTIME_ROOT`, verifies
`ktx runtime status`, runs `ktx sl query --yes` to install the core runtime from
the bundled wheel, checks `ktx runtime doctor`, starts and reuses the managed
daemon, stops it, previews a stale runtime with `ktx runtime prune --dry-run`,
verifies confirmation is required, and removes the stale runtime with
`ktx runtime prune --yes`.
```

With:

```markdown
The managed Python runtime smoke requires `uv` on `PATH`, isolates
`KTX_RUNTIME_ROOT`, verifies `ktx runtime status`, runs `ktx sl query --yes` to
install the core runtime from the bundled wheel, checks `ktx runtime doctor`,
starts and reuses the managed daemon, stops it, previews a stale runtime with
`ktx runtime prune --dry-run`, verifies confirmation is required, and removes
the stale runtime with `ktx runtime prune --yes`.
```

- [ ] **Step 5: Run the docs test and verify success**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the public docs update**

```bash
git add README.md examples/package-artifacts/README.md scripts/examples-docs.test.mjs
git commit -m "docs: document uv runtime prerequisite"
```

### Task 4: Verify the completed contract

**Files:**

- Verify: `release-policy.json`
- Verify: `scripts/release-readiness.mjs`
- Verify: `scripts/release-readiness.test.mjs`
- Verify: `packages/cli/src/managed-python-runtime.ts`
- Verify: `packages/cli/src/managed-python-runtime.test.ts`
- Verify: `scripts/examples-docs.test.mjs`
- Verify: `README.md`
- Verify: `examples/package-artifacts/README.md`

- [ ] **Step 1: Run focused verification**

Run:

```bash
node --test scripts/release-readiness.test.mjs scripts/examples-docs.test.mjs
pnpm --filter @ktx/cli run test -- src/managed-python-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 2: Verify release readiness text output**

Run:

```bash
pnpm run release:readiness
```

Expected output includes:

```text
KTX release mode: npm-public-release-ready
Runtime uv strategy: path-prerequisite
Runtime uv bootstrap: disabled
NPM publish target: @kaelio/ktx@0.1.0 (latest)
```

- [ ] **Step 3: Verify no pre-commit config is required**

Run:

```bash
rg --files -g '.pre-commit-config.yaml' -g 'pre-commit-config.yaml'
```

Expected: no output and exit code 1. No Python files changed, so the repository
Python pre-commit requirement does not apply.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --stat
git diff -- release-policy.json scripts/release-readiness.mjs scripts/release-readiness.test.mjs packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts scripts/examples-docs.test.mjs README.md examples/package-artifacts/README.md
```

Expected: only the runtime installer policy, missing-`uv` message/tests, and
public docs changed.

- [ ] **Step 5: Commit final verification notes if needed**

If Task 4 produces only verification output and no file changes, skip this
step. If a correction was made during verification, commit it:

```bash
git add release-policy.json scripts/release-readiness.mjs scripts/release-readiness.test.mjs packages/cli/src/managed-python-runtime.ts packages/cli/src/managed-python-runtime.test.ts scripts/examples-docs.test.mjs README.md examples/package-artifacts/README.md
git commit -m "chore: finish uv prerequisite release contract"
```

## Self-review

Spec coverage:

- The earlier implemented plans cover the single public npm package, bundled
  Python wheel, managed runtime installer, runtime commands, daemon lifecycle,
  local embeddings, Python-backed command integration, release smoke, published
  smoke, docs cleanup, release handoff, and prune coverage.
- This plan closes the spec's remaining `uv` open decision by choosing
  `path-prerequisite`, recording that decision in release policy, validating it
  in release readiness, using one CLI error message, and documenting it.
- The plan keeps Python package publication disabled and keeps KTX-owned Python
  code bundled in the npm package.

Placeholder scan:

- No task contains deferred implementation markers.
- Each code-changing step names exact files and includes the concrete code to
  add or replace.

Type consistency:

- The release policy field is consistently named `runtimeInstaller`.
- The chosen strategy is consistently `path-prerequisite`.
- The shared CLI message constant is consistently
  `MISSING_UV_RUNTIME_INSTALL_MESSAGE`.
