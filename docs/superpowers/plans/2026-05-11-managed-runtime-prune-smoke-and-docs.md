# Managed Runtime Prune Smoke and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and document `ktx runtime prune` as part of the npm-managed
Python runtime release contract.

**Architecture:** The prune command already exists in the CLI runtime layer, so
this plan adds black-box package smoke coverage and public documentation only.
The smoke creates an isolated stale versioned runtime directory, previews it,
verifies confirmation is required, and removes it through the installed
`@kaelio/ktx` package.

**Tech Stack:** Node 22 ESM scripts, `node:test`, pnpm, Markdown, KTX CLI
managed Python runtime.

---

## Current state

This plan follows
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

The following plan files are based on that spec and are implemented in the
current tree:

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

Implementation evidence found before writing this plan includes:

- `packages/cli/assets/python/manifest.json` and
  `packages/cli/assets/python/kaelio_ktx-0.1.0-py3-none-any.whl`.
- `packages/cli/src/managed-python-runtime.ts`, including
  `installManagedPythonRuntime()`, `doctorManagedPythonRuntime()`, and
  `pruneManagedPythonRuntimes()`.
- `packages/cli/src/runtime.ts`, including the `install`, `status`,
  `doctor`, `start`, `stop`, and `prune` runtime command runner branches.
- `packages/cli/src/commands/runtime-commands.ts`, including the
  `runtime prune --dry-run` and `runtime prune --yes` Commander wiring.
- `scripts/build-public-npm-package.mjs`, `scripts/package-artifacts.mjs`,
  `scripts/published-package-smoke.mjs`, `scripts/local-embeddings-runtime-smoke.mjs`,
  `scripts/publish-public-npm-package.mjs`, `release-policy.json`, and
  `.github/workflows/release.yml`.
- `README.md` and `examples/package-artifacts/README.md` document the managed
  runtime but do not mention `ktx runtime prune`.

The remaining gap is narrow: the spec lists `ktx runtime prune` as part of the
runtime management command family, but public docs and installed package smoke
coverage only prove `install`, `status`, `doctor`, `start`, and `stop`.

## File structure

- Modify `scripts/package-artifacts.test.mjs`: assert that the generated
  installed npm smoke covers `ktx runtime prune --dry-run`, confirmation
  failure, and confirmed deletion.
- Modify `scripts/package-artifacts.mjs`: extend `npmRuntimeSmokeSource()` to
  create a stale runtime directory and exercise `ktx runtime prune`.
- Modify `scripts/examples-docs.test.mjs`: require public docs to mention
  `ktx runtime prune --dry-run` and `ktx runtime prune --yes`.
- Modify `README.md`: add prune commands and one sentence describing preview
  and confirmed deletion.
- Modify `examples/package-artifacts/README.md`: describe prune coverage in the
  package artifact smoke.

### Task 1: Add installed package prune smoke coverage

**Files:**

- Modify: `scripts/package-artifacts.test.mjs`
- Modify: `scripts/package-artifacts.mjs`

- [ ] **Step 1: Add failing smoke-source assertions**

In `scripts/package-artifacts.test.mjs`, inside
`it('runs installed CLI commands through the public package runtime', () => {`
and immediately after the existing assertions for `ktx runtime stop`, add:

```javascript
    assert.match(source, /ktx runtime prune dry run/);
    assert.match(source, /0\.0\.0/);
    assert.match(source, /ktx runtime prune needs confirmation/);
    assert.match(source, /Refusing to prune without --yes/);
    assert.match(source, /ktx runtime prune confirmed/);
    assert.match(source, /Removed stale KTX Python runtimes/);
    assert.match(source, /assert\.rejects\(\(\) => access\(staleRuntimeDir\)\)/);
```

- [ ] **Step 2: Run the package artifact test and verify failure**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: FAIL in the installed CLI smoke source test because
`npmRuntimeSmokeSource()` does not yet contain the prune labels, confirmation
guard, or stale runtime removal assertion.

- [ ] **Step 3: Extend the generated installed CLI smoke**

In `scripts/package-artifacts.mjs`, inside `npmRuntimeSmokeSource()`, add this
block immediately after:

```javascript
  process.stdout.write('ktx runtime daemon lifecycle verified\n');
```

Add:

```javascript
  const staleRuntimeDir = join(process.env.KTX_RUNTIME_ROOT, '0.0.0');
  await mkdir(staleRuntimeDir, { recursive: true });

  const runtimePruneDryRun = await run('pnpm', ['exec', 'ktx', 'runtime', 'prune', '--dry-run']);
  requireSuccess('ktx runtime prune dry run', runtimePruneDryRun);
  requireOutput('ktx runtime prune dry run', runtimePruneDryRun, /Stale KTX Python runtimes/);
  requireOutput('ktx runtime prune dry run', runtimePruneDryRun, /0\.0\.0/);
  await access(staleRuntimeDir);

  const runtimePruneNeedsConfirmation = await run('pnpm', ['exec', 'ktx', 'runtime', 'prune']);
  assert.equal(runtimePruneNeedsConfirmation.code, 1, 'ktx runtime prune without --yes must fail');
  assert.equal(runtimePruneNeedsConfirmation.stdout, '', 'ktx runtime prune confirmation failure wrote stdout');
  assert.match(runtimePruneNeedsConfirmation.stderr, /Refusing to prune without --yes/);

  const runtimePruneConfirmed = await run('pnpm', ['exec', 'ktx', 'runtime', 'prune', '--yes']);
  requireSuccess('ktx runtime prune confirmed', runtimePruneConfirmed);
  requireOutput('ktx runtime prune confirmed', runtimePruneConfirmed, /Removed stale KTX Python runtimes/);
  requireOutput('ktx runtime prune confirmed', runtimePruneConfirmed, /0\.0\.0/);
  await assert.rejects(() => access(staleRuntimeDir));
  process.stdout.write('ktx runtime prune verified\n');
```

No import changes are needed because the generated smoke already imports
`assert`, `access`, `mkdir`, and `join`.

- [ ] **Step 4: Run the package artifact test and verify pass**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: PASS. The source assertions now find prune dry-run coverage,
confirmation failure coverage, confirmed prune coverage, and stale directory
deletion verification.

- [ ] **Step 5: Commit the smoke coverage**

Run:

```bash
git add scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs
git commit -m "test: cover managed runtime prune in package smoke"
```

### Task 2: Document runtime prune in public docs

**Files:**

- Modify: `scripts/examples-docs.test.mjs`
- Modify: `README.md`
- Modify: `examples/package-artifacts/README.md`

- [ ] **Step 1: Add failing docs assertions**

In `scripts/examples-docs.test.mjs`, inside
`it('documents public npm and managed runtime usage in the README', async () => {`
and immediately after:

```javascript
    assert.match(rootReadme, /ktx runtime stop/);
```

Add:

```javascript
    assert.match(rootReadme, /ktx runtime prune --dry-run/);
    assert.match(rootReadme, /ktx runtime prune --yes/);
```

In the same file, inside
`it('documents the public package artifact smoke shape', async () => {` and
immediately after:

```javascript
    assert.match(readme, /ktx runtime doctor/);
```

Add:

```javascript
    assert.match(readme, /ktx runtime prune --dry-run/);
    assert.match(readme, /ktx runtime prune --yes/);
```

- [ ] **Step 2: Run the docs test and verify failure**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL because `README.md` and
`examples/package-artifacts/README.md` do not yet mention `ktx runtime prune`.

- [ ] **Step 3: Update the root README runtime section**

In `README.md`, in the `## Managed Python runtime` command block, replace:

```bash
npx ktx runtime install --yes
npx ktx runtime status
npx ktx runtime doctor
npx ktx runtime start
npx ktx runtime stop
```

with:

```bash
npx ktx runtime install --yes
npx ktx runtime status
npx ktx runtime doctor
npx ktx runtime start
npx ktx runtime stop
npx ktx runtime prune --dry-run
npx ktx runtime prune --yes
```

Immediately after that command block, add:

```markdown
Use `runtime prune --dry-run` to preview stale runtime directories from older
CLI versions. Add `--yes` to remove those stale directories after daemon
processes are stopped.
```

- [ ] **Step 4: Update package artifact smoke docs**

In `examples/package-artifacts/README.md`, replace:

```markdown
The managed Python runtime smoke isolates `KTX_RUNTIME_ROOT`, verifies
`ktx runtime status`, runs `ktx sl query --yes` to install the core runtime from
the bundled wheel, checks `ktx runtime doctor`, starts and reuses the managed
daemon, and stops it.
```

with:

```markdown
The managed Python runtime smoke isolates `KTX_RUNTIME_ROOT`, verifies
`ktx runtime status`, runs `ktx sl query --yes` to install the core runtime from
the bundled wheel, checks `ktx runtime doctor`, starts and reuses the managed
daemon, stops it, previews a stale runtime with `ktx runtime prune --dry-run`,
verifies confirmation is required, and removes the stale runtime with
`ktx runtime prune --yes`.
```

- [ ] **Step 5: Run the docs test and verify pass**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS. The public README and package artifact README now document
runtime prune alongside the other managed runtime commands.

- [ ] **Step 6: Commit the docs coverage**

Run:

```bash
git add scripts/examples-docs.test.mjs README.md examples/package-artifacts/README.md
git commit -m "docs: document managed runtime prune"
```

### Task 3: Verify the completed prune release surface

**Files:**

- Verify: `scripts/package-artifacts.mjs`
- Verify: `scripts/package-artifacts.test.mjs`
- Verify: `scripts/examples-docs.test.mjs`
- Verify: `README.md`
- Verify: `examples/package-artifacts/README.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test scripts/package-artifacts.test.mjs scripts/examples-docs.test.mjs
```

Expected: PASS. The source-level tests cover generated package smoke behavior
and docs assertions.

- [ ] **Step 2: Run the installed package artifact smoke**

Run:

```bash
pnpm run artifacts:check
```

Expected: PASS. The generated installed CLI smoke prints:

```text
ktx runtime prune verified
```

and removes the temporary `0.0.0` directory from the isolated
`KTX_RUNTIME_ROOT`.

- [ ] **Step 3: Inspect git status**

Run:

```bash
git status --short
```

Expected: only the five planned files are modified before the final commit, or
no modified files remain after the task commits.

- [ ] **Step 4: Commit verification fixes if needed**

If verification required small corrections, commit only those intended files:

```bash
git add scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/examples-docs.test.mjs README.md examples/package-artifacts/README.md
git commit -m "test: verify managed runtime prune release surface"
```

## Acceptance criteria

- The generated installed npm package smoke creates a stale versioned runtime
  directory under the isolated `KTX_RUNTIME_ROOT`.
- `ktx runtime prune --dry-run` lists the stale runtime and leaves it on disk.
- `ktx runtime prune` without `--yes` exits nonzero and prints the existing
  confirmation guidance.
- `ktx runtime prune --yes` removes the stale runtime directory.
- `README.md` lists `ktx runtime prune --dry-run` and
  `ktx runtime prune --yes` with the other managed runtime commands.
- `examples/package-artifacts/README.md` describes prune coverage in the
  package artifact smoke.

## Self-review

- Spec coverage: this plan covers the remaining visible gap for the runtime
  management command family in the npm-managed Python runtime spec. The prune
  implementation already exists, and this plan adds release smoke and public
  docs coverage.
- Placeholder scan: no placeholder steps, deferred implementation notes, or
  unspecified behavior gaps remain.
- Type consistency: the plan uses existing labels and functions:
  `npmRuntimeSmokeSource()`, `requireSuccess()`, `requireOutput()`,
  `KTX_RUNTIME_ROOT`, `ktx runtime prune --dry-run`, and
  `ktx runtime prune --yes`.
