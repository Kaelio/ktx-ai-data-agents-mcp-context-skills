# Managed Local Embeddings Smoke Public Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the opt-in local embeddings release smoke validate the public
`@kaelio/ktx` package version instead of the private workspace version.

**Architecture:** Reuse the public package constants from
`scripts/build-public-npm-package.mjs` inside the local embeddings smoke. Add a
small exported RegExp helper so the unit test can lock the version expectation
without running the expensive model-download smoke.

**Tech Stack:** Node.js ESM scripts, `node:test`, pnpm release scripts.

---

## Current State

The npm-managed Python runtime spec is
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.
The current branch already contains implementation commits for each existing
plan derived from that spec.

Implemented spec-derived plans:

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
- `docs/superpowers/plans/2026-05-11-managed-runtime-uv-prerequisite-contract.md`
- `docs/superpowers/plans/2026-05-11-single-public-runtime-artifact-cleanup.md`

The remaining gap is in
`scripts/local-embeddings-runtime-smoke.mjs`. The script selects and installs a
public tarball named `kaelio-ktx-*.tgz` and writes a smoke package dependency on
`@kaelio/ktx`, but line 267 still expects `@kaelio/ktx 0.0.0-private`. The
public package builder defines `PUBLIC_NPM_PACKAGE_VERSION = '0.1.0'`, and the
main packed-package smoke already expects `@kaelio/ktx 0.1.0`.

## File Structure

This change keeps the release version source of truth in one script and reuses
it from the opt-in smoke.

- Modify `scripts/local-embeddings-runtime-smoke.mjs`: import the public package
  constants, export `expectedPublicKtxVersionPattern()`, and use that pattern
  for the smoke version assertion.
- Modify `scripts/local-embeddings-runtime-smoke.test.mjs`: import
  `expectedPublicKtxVersionPattern()` and assert that it accepts
  `@kaelio/ktx 0.1.0` and rejects `@kaelio/ktx 0.0.0-private`.

### Task 1: Align the local embeddings smoke version assertion

**Files:**
- Modify: `scripts/local-embeddings-runtime-smoke.mjs:1-267`
- Modify: `scripts/local-embeddings-runtime-smoke.test.mjs:5-118`
- Test: `scripts/local-embeddings-runtime-smoke.test.mjs`

- [ ] **Step 1: Write the failing version-pattern test**

In `scripts/local-embeddings-runtime-smoke.test.mjs`, update the import block
to include `expectedPublicKtxVersionPattern`:

```js
import {
  buildLocalEmbeddingsSmokeEnv,
  expectedPublicKtxVersionPattern,
  localEmbeddingsSmokeCommands,
  localEmbeddingsSmokeOptIn,
  parseDaemonBaseUrl,
  publicKtxTarballName,
  validateEmbeddingResponse,
} from './local-embeddings-runtime-smoke.mjs';
```

Then add this test after the `publicKtxTarballName` describe block:

```js
describe('expectedPublicKtxVersionPattern', () => {
  it('matches the public package version and rejects the private workspace version', () => {
    const pattern = expectedPublicKtxVersionPattern();

    assert.match('@kaelio/ktx 0.1.0\n', pattern);
    assert.doesNotMatch('@kaelio/ktx 0.0.0-private\n', pattern);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test scripts/local-embeddings-runtime-smoke.test.mjs
```

Expected: FAIL with an ESM export error that says
`expectedPublicKtxVersionPattern` is not exported from
`./local-embeddings-runtime-smoke.mjs`.

- [ ] **Step 3: Import the public package constants**

In `scripts/local-embeddings-runtime-smoke.mjs`, add this import after the
existing Node imports:

```js
import {
  PUBLIC_NPM_PACKAGE_NAME,
  PUBLIC_NPM_PACKAGE_VERSION,
} from './build-public-npm-package.mjs';
```

The top of the file becomes:

```js
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  PUBLIC_NPM_PACKAGE_NAME,
  PUBLIC_NPM_PACKAGE_VERSION,
} from './build-public-npm-package.mjs';
```

- [ ] **Step 4: Add the version-pattern helper**

In `scripts/local-embeddings-runtime-smoke.mjs`, add these functions after the
`OPT_IN_MESSAGE` constant:

```js
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function expectedPublicKtxVersionPattern() {
  return new RegExp(
    `${escapeRegExp(PUBLIC_NPM_PACKAGE_NAME)} ${escapeRegExp(PUBLIC_NPM_PACKAGE_VERSION)}`,
  );
}
```

- [ ] **Step 5: Use the helper in the smoke**

In `scripts/local-embeddings-runtime-smoke.mjs`, replace this line:

```js
requireOutput(commands[0].label, version, /@kaelio\/ktx 0\.0\.0-private/);
```

with:

```js
requireOutput(commands[0].label, version, expectedPublicKtxVersionPattern());
```

- [ ] **Step 6: Run the focused test**

Run:

```bash
node --test scripts/local-embeddings-runtime-smoke.test.mjs
```

Expected: PASS. The new test proves the smoke accepts `@kaelio/ktx 0.1.0` and
rejects `@kaelio/ktx 0.0.0-private`.

- [ ] **Step 7: Run related release-script tests**

Run:

```bash
node --test scripts/local-embeddings-runtime-smoke.test.mjs scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs
```

Expected: PASS. These tests cover the public package constants, tarball name,
artifact smoke source, and local embeddings smoke helpers.

- [ ] **Step 8: Run a stale-expectation search**

Run:

```bash
rg -n "@kaelio/ktx 0\\.0\\.0-private|0\\\\\\.0\\\\\\.0-private" scripts/local-embeddings-runtime-smoke.mjs
```

Expected: no output. The opt-in local embeddings smoke no longer contains the
private package version expectation. The test file still uses
`@kaelio/ktx 0.0.0-private` as a negative fixture.

- [ ] **Step 9: Commit**

Run:

```bash
git add scripts/local-embeddings-runtime-smoke.mjs scripts/local-embeddings-runtime-smoke.test.mjs
git commit -m "fix: align local embeddings smoke with public version"
```

## Verification

Run these checks before marking the plan complete:

```bash
node --test scripts/local-embeddings-runtime-smoke.test.mjs scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs
rg -n "@kaelio/ktx 0\\.0\\.0-private|0\\\\\\.0\\\\\\.0-private" scripts/local-embeddings-runtime-smoke.mjs
```

Expected results:

- `node --test ...` exits with code 0.
- `rg ...` prints no matches.
- No Python files changed, so the repository Python pre-commit requirement does
  not apply.

## Self-Review

- Spec coverage: this plan fixes the opt-in local embeddings release smoke from
  the npm-managed runtime spec so it validates the public npm package produced
  by the current release artifact flow.
- Placeholder scan: the plan contains concrete file paths, code blocks,
  commands, and expected outcomes.
- Type consistency: the helper name is consistently
  `expectedPublicKtxVersionPattern`, and it uses
  `PUBLIC_NPM_PACKAGE_NAME` plus `PUBLIC_NPM_PACKAGE_VERSION` from the public
  package builder.
