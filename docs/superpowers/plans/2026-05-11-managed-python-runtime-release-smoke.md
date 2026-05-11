# Managed Python Runtime Release Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public `@kaelio/ktx` artifact smoke prove that the npm
package installs and uses its own managed Python runtime without an externally
prepared Python environment.

**Architecture:** Keep the release smoke black-box: install the packed public
npm tarball into a clean project, isolate `KTX_RUNTIME_ROOT`, and exercise the
installed `ktx` binary. The first `ktx sl query --yes` performs the lazy core
runtime install from bundled package assets, then the smoke verifies
`runtime status`, `runtime doctor`, daemon start/reuse, and daemon stop.

**Tech Stack:** Node 22 ESM scripts, `node:test`, pnpm, uv, KTX CLI managed
Python runtime assets.

---

## Existing status

This plan is based on
`docs/superpowers/specs/2026-05-11-npm-managed-python-runtime-design.md`.

Existing plans based on the spec:

- `docs/superpowers/plans/2026-05-11-bundled-python-runtime-wheel.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-installer.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-command-integration.md`
- `docs/superpowers/plans/2026-05-11-managed-python-runtime-daemon-lifecycle.md`
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-runtime.md`
- `docs/superpowers/plans/2026-05-11-public-kaelio-ktx-npm-package.md`

All six are implemented in this worktree. Evidence found before writing this
plan includes:

- `scripts/build-python-runtime-wheel.mjs` and
  `scripts/build-python-runtime-wheel.test.mjs`.
- `packages/cli/assets/python/kaelio_ktx-0.1.0-py3-none-any.whl` and
  `packages/cli/assets/python/manifest.json`.
- `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/runtime.ts`, and
  `packages/cli/src/commands/runtime-commands.ts`.
- `packages/cli/src/managed-python-command.ts` and `ktx sl query` runtime
  install policy flags.
- `packages/cli/src/managed-python-daemon.ts`, daemon state paths, and
  `ktx runtime start` / `ktx runtime stop`.
- `packages/cli/src/managed-local-embeddings.ts`,
  `packages/context/src/llm/local-config.ts` managed marker constants, and
  setup wiring in `packages/cli/src/setup-embeddings.ts`.
- `scripts/build-public-npm-package.mjs`,
  `scripts/build-public-npm-package.test.mjs`, `release-policy.json` listing
  `@kaelio/ktx`, and published smoke command construction for the required
  `@kaelio/ktx` invocation modes.

The remaining release-smoke gap is in `scripts/package-artifacts.mjs`:

- `verifyNpmArtifacts()` creates a smoke `.venv`, installs the built Python
  runtime wheel into it, and runs installed CLI smoke scripts with that venv at
  the front of `PATH`.
- The installed CLI smoke does run `ktx sl query --yes`, but it does not
  isolate `KTX_RUNTIME_ROOT`, does not assert that the first query installed
  the managed runtime from bundled npm assets, and does not exercise
  `ktx runtime status`, `doctor`, `start`, reuse, and `stop`.

This plan closes that release-flow gap without changing the separate Python
artifact smoke. `verifyPythonArtifacts()` must continue to install the built
Python wheel directly because it verifies the Python artifact itself.

## File structure

- Modify `scripts/package-artifacts.test.mjs`: remove the npm-smoke venv test,
  add a source-level guard that npm artifact verification does not prepare an
  external Python venv, and assert that the installed CLI smoke exercises the
  managed runtime lifecycle.
- Modify `scripts/package-artifacts.mjs`: remove npm-smoke Python venv PATH
  setup, isolate `KTX_RUNTIME_ROOT` inside `npmRuntimeSmokeSource()`, assert
  first-run lazy install, and add runtime status/doctor/start/reuse/stop smoke
  commands.

### Task 1: Add failing release-smoke tests

**Files:**

- Modify: `scripts/package-artifacts.test.mjs`
- Test: `scripts/package-artifacts.test.mjs`

- [ ] **Step 1: Remove the stale npm-smoke venv import**

In `scripts/package-artifacts.test.mjs`, delete `npmSmokePythonEnv` from the
import list. The surrounding import block must contain this sequence after the
edit:

```javascript
  npmDemoSmokeSource,
  npmRuntimeSmokeSource,
  npmSmokePackageJson,
  npmVerifySource,
```

- [ ] **Step 2: Replace the npm-smoke venv test with a source guard**

Delete this entire test block:

```javascript
describe('npmSmokePythonEnv', () => {
  it('prepends the npm smoke virtualenv bin directory to PATH', () => {
    const env = npmSmokePythonEnv('/tmp/ktx-npm-smoke', { PATH: '/usr/bin' });

    assert.match(env.PATH, /^\/tmp\/ktx-npm-smoke\/\.venv\/(bin|Scripts)/);
    assert.match(env.PATH, /\/usr\/bin$/);
  });
});
```

Insert this block in the same location:

```javascript
describe('verifyNpmArtifacts', () => {
  it('does not prepare an external Python environment for the npm smoke', async () => {
    const source = await readFile(new URL('./package-artifacts.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('async function verifyNpmArtifacts');
    const end = source.indexOf('async function verifyNpmDemoArtifacts');
    assert.ok(start > 0, 'verifyNpmArtifacts function must exist');
    assert.ok(end > start, 'verifyNpmDemoArtifacts must follow verifyNpmArtifacts');

    const body = source.slice(start, end);
    assert.doesNotMatch(body, /uv', \['venv', '\.venv'\]/);
    assert.doesNotMatch(body, /pythonArtifactInstallArgs/);
    assert.doesNotMatch(body, /npmSmokePythonEnv/);
  });
});
```

- [ ] **Step 3: Extend the installed CLI smoke assertions**

In the `it('runs installed CLI commands through the public package runtime',
...)` test, add these assertions after the existing
`assert.match(source, /ktx sl query sqlite execute/);` assertion:

```javascript
    assert.match(source, /import Database from 'better-sqlite3'/);
    assert.doesNotMatch(source, /run\('python'/);
    assert.match(source, /KTX_RUNTIME_ROOT/);
    assert.match(source, /managed-runtime/);
    assert.match(source, /ktx runtime status missing/);
    assert.match(source, /runtimeStatusBefore\.kind, 'missing'/);
    assert.match(source, /Installing KTX Python runtime \(core\) with uv/);
    assert.match(source, /KTX Python runtime ready:/);
    assert.match(source, /ktx runtime status ready/);
    assert.match(source, /runtimeStatusAfter\.kind, 'ready'/);
    assert.match(source, /runtimeStatusAfter\.manifest\.features/);
    assert.match(source, /ktx runtime doctor/);
    assert.match(source, /PASS Managed Python runtime/);
    assert.match(source, /ktx runtime start/);
    assert.match(source, /ktx runtime start reuse/);
    assert.match(source, /Using existing KTX Python daemon/);
    assert.match(source, /ktx runtime stop/);
```

- [ ] **Step 4: Run the failing package artifact tests**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: FAIL. The guard fails because `verifyNpmArtifacts()` still creates
the npm-smoke `.venv`, and the installed CLI smoke assertions fail because
`npmRuntimeSmokeSource()` does not yet isolate or verify the managed runtime.

### Task 2: Make the npm smoke use only the managed runtime

**Files:**

- Modify: `scripts/package-artifacts.mjs`
- Modify: `scripts/package-artifacts.test.mjs`
- Test: `scripts/package-artifacts.test.mjs`

- [ ] **Step 1: Remove the npm-smoke PATH helper**

In `scripts/package-artifacts.mjs`, change the path import from:

```javascript
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
```

to:

```javascript
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
```

Then delete this exported helper:

```javascript
export function npmSmokePythonEnv(projectDir, baseEnv = process.env) {
  const binDir = process.platform === 'win32' ? join(projectDir, '.venv', 'Scripts') : join(projectDir, '.venv', 'bin');
  const existingPath = baseEnv.PATH ?? '';

  return Object.assign({}, baseEnv, {
    PATH: existingPath ? `${binDir}${delimiter}${existingPath}` : binDir,
  });
}
```

- [ ] **Step 2: Add runtime-smoke helpers to `npmRuntimeSmokeSource()`**

Inside the template string returned by `npmRuntimeSmokeSource()`, add this
helper immediately after `requireSuccess()`:

```javascript
function requireSuccessWithStderr(label, result, stderrPattern) {
  assert.equal(
    result.code,
    0,
    label + ' failed with code ' + result.code + '\\nstdout:\\n' + result.stdout + '\\nstderr:\\n' + result.stderr,
  );
  assert.match(result.stderr, stderrPattern, label + ' stderr did not match ' + stderrPattern);
}
```

Then replace the smoke root setup:

```javascript
const root = await mkdtemp(join(tmpdir(), 'ktx-installed-cli-smoke-'));
try {
  const projectDir = join(root, 'project');
  const sourceDir = join(root, 'source');
```

with:

```javascript
const root = await mkdtemp(join(tmpdir(), 'ktx-installed-cli-smoke-'));
const previousRuntimeRoot = process.env.KTX_RUNTIME_ROOT;
process.env.KTX_RUNTIME_ROOT = join(root, 'managed-runtime');
let daemonStarted = false;
try {
  const projectDir = join(root, 'project');
  const sourceDir = join(root, 'source');
```

Finally replace the existing `finally` block at the end of
`npmRuntimeSmokeSource()`:

```javascript
} finally {
  await rm(root, { recursive: true, force: true });
}
```

with:

```javascript
} finally {
  if (daemonStarted) {
    await run('pnpm', ['exec', 'ktx', 'runtime', 'stop']);
  }
  if (previousRuntimeRoot === undefined) {
    delete process.env.KTX_RUNTIME_ROOT;
  } else {
    process.env.KTX_RUNTIME_ROOT = previousRuntimeRoot;
  }
  await rm(root, { recursive: true, force: true });
}
```

- [ ] **Step 3: Create the sqlite smoke warehouse without Python**

Inside the template string returned by `npmRuntimeSmokeSource()`, add this
import after the `assert` import:

```javascript
import Database from 'better-sqlite3';
```

Then replace the current `writeSqliteWarehouse()` function:

```javascript
async function writeSqliteWarehouse(projectDir) {
  const createDb = await run('python', [
    '-c',
    [
      'import sqlite3',
      'import sys',
      'db_path = sys.argv[1]',
      'conn = sqlite3.connect(db_path)',
      'conn.executescript("""',
      'DROP TABLE IF EXISTS orders;',
      'CREATE TABLE orders (',
      '  id INTEGER PRIMARY KEY,',
      '  status TEXT NOT NULL,',
      '  amount INTEGER NOT NULL',
      ');',
      "INSERT INTO orders (status, amount) VALUES ('paid', 20), ('paid', 30), ('open', 10);",
      '""")',
      'conn.close()',
    ].join('\\n'),
    join(projectDir, 'warehouse.db'),
  ]);
  requireSuccess('create sqlite warehouse', createDb);
}
```

with:

```javascript
async function writeSqliteWarehouse(projectDir) {
  const database = new Database(join(projectDir, 'warehouse.db'));
  try {
    database.exec(`
DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  amount INTEGER NOT NULL
);
INSERT INTO orders (status, amount) VALUES ('paid', 20), ('paid', 30), ('open', 10);
`);
  } finally {
    database.close();
  }
}
```

- [ ] **Step 4: Assert the isolated runtime is initially missing**

In `npmRuntimeSmokeSource()`, insert this block immediately after the public
package version assertion:

```javascript
  const runtimeStatusBefore = parseJsonResult(
    'ktx runtime status missing',
    await run('pnpm', ['exec', 'ktx', 'runtime', 'status', '--json']),
  );
  assert.equal(runtimeStatusBefore.kind, 'missing');
  assert.equal(runtimeStatusBefore.layout.runtimeRoot, process.env.KTX_RUNTIME_ROOT);
  process.stdout.write('ktx managed runtime starts missing in isolated root\\n');
```

- [ ] **Step 5: Assert first `sl query --yes` performs lazy managed install**

In `npmRuntimeSmokeSource()`, replace the current `slQuery` verification block:

```javascript
  const slQuery = await run('pnpm', ['exec', 'ktx', 'sl', 'query',
    '--connection-id',
    'warehouse',
    '--measure',
    'orders.order_count',
    '--format',
    'json',
    '--yes',
    '--project-dir',
    projectDir,
  ]);
  requireSuccess('ktx sl query', slQuery);
  requireOutput('ktx sl query', slQuery, /"mode": "compile_only"/);
  requireOutput('ktx sl query', slQuery, /orders/);
```

with:

```javascript
  const slQuery = await run('pnpm', ['exec', 'ktx', 'sl', 'query',
    '--connection-id',
    'warehouse',
    '--measure',
    'orders.order_count',
    '--format',
    'json',
    '--yes',
    '--project-dir',
    projectDir,
  ]);
  requireSuccessWithStderr(
    'ktx sl query first managed runtime install',
    slQuery,
    /Installing KTX Python runtime \(core\) with uv[\s\S]*KTX Python runtime ready:/,
  );
  requireOutput('ktx sl query first managed runtime install', slQuery, /"mode": "compile_only"/);
  requireOutput('ktx sl query first managed runtime install', slQuery, /orders/);

  const runtimeStatusAfter = parseJsonResult(
    'ktx runtime status ready',
    await run('pnpm', ['exec', 'ktx', 'runtime', 'status', '--json']),
  );
  assert.equal(runtimeStatusAfter.kind, 'ready');
  assert.deepEqual(runtimeStatusAfter.manifest.features, ['core']);
  assert.equal(runtimeStatusAfter.layout.runtimeRoot, process.env.KTX_RUNTIME_ROOT);
  process.stdout.write('ktx managed runtime lazy install verified\\n');
```

- [ ] **Step 6: Add runtime doctor and daemon lifecycle smoke**

In `npmRuntimeSmokeSource()`, insert this block immediately after the
`sqliteSlQuery` verification block:

```javascript
  const runtimeDoctor = await run('pnpm', ['exec', 'ktx', 'runtime', 'doctor']);
  requireSuccess('ktx runtime doctor', runtimeDoctor);
  requireOutput('ktx runtime doctor', runtimeDoctor, /PASS uv/);
  requireOutput('ktx runtime doctor', runtimeDoctor, /PASS Bundled Python wheel/);
  requireOutput('ktx runtime doctor', runtimeDoctor, /PASS Managed Python runtime/);
  process.stdout.write('ktx runtime doctor verified\\n');

  const runtimeStart = await run('pnpm', ['exec', 'ktx', 'runtime', 'start']);
  requireSuccess('ktx runtime start', runtimeStart);
  daemonStarted = true;
  requireOutput('ktx runtime start', runtimeStart, /Started KTX Python daemon/);
  requireOutput('ktx runtime start', runtimeStart, /url: http:\/\/127\.0\.0\.1:\d+/);
  requireOutput('ktx runtime start', runtimeStart, /features: core/);

  const runtimeStartReuse = await run('pnpm', ['exec', 'ktx', 'runtime', 'start']);
  requireSuccess('ktx runtime start reuse', runtimeStartReuse);
  requireOutput('ktx runtime start reuse', runtimeStartReuse, /Using existing KTX Python daemon/);
  requireOutput('ktx runtime start reuse', runtimeStartReuse, /features: core/);

  const runtimeStop = await run('pnpm', ['exec', 'ktx', 'runtime', 'stop']);
  requireSuccess('ktx runtime stop', runtimeStop);
  daemonStarted = false;
  requireOutput('ktx runtime stop', runtimeStop, /Stopped KTX Python daemon/);
  process.stdout.write('ktx runtime daemon lifecycle verified\\n');
```

- [ ] **Step 7: Remove npm-smoke Python preparation from artifact verification**

In `scripts/package-artifacts.mjs`, replace `verifyNpmArtifacts()` with this
implementation:

```javascript
async function verifyNpmArtifacts(layout, tmpRoot) {
  for (const packageInfo of NPM_ARTIFACT_PACKAGES) {
    await assertPathExists(layout.npmTarballs[packageInfo.name], `${packageInfo.name} tarball`);
  }

  const projectDir = join(tmpRoot, 'npm-clean-install');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'package.json'),
    `${JSON.stringify(npmSmokePackageJson(layout), null, 2)}\n`,
  );
  await writeFile(join(projectDir, 'verify-npm.mjs'), npmVerifySource());
  await writeFile(join(projectDir, 'verify-installed-cli.mjs'), npmRuntimeSmokeSource());
  await writeFile(join(projectDir, 'verify-installed-demo.mjs'), npmDemoSmokeSource());

  await runCommand('pnpm', ['install'], { cwd: projectDir });
  await runCommand('pnpm', ['rebuild', 'better-sqlite3'], { cwd: projectDir });
  await runCommand('node', ['verify-npm.mjs'], { cwd: projectDir });
  await runCommand('pnpm', ['exec', 'ktx', '--version'], { cwd: projectDir });
  await runCommand('node', ['verify-installed-cli.mjs'], { cwd: projectDir });
  await runCommand('node', ['verify-installed-demo.mjs'], { cwd: projectDir });
}
```

- [ ] **Step 8: Run the focused package artifact tests**

Run:

```bash
node --test scripts/package-artifacts.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit the release-smoke implementation**

Run:

```bash
git add scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs
git commit -m "test: verify managed runtime in public package smoke"
```

### Task 3: Verify the release-smoke surface

**Files:**

- Test: `scripts/package-artifacts.test.mjs`
- Test: `scripts/package-artifacts.mjs`

- [ ] **Step 1: Run script unit tests that cover artifact packaging**

Run:

```bash
node --test scripts/build-python-runtime-wheel.test.mjs scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs scripts/published-package-smoke.test.mjs scripts/release-readiness.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the public package artifact smoke**

Run:

```bash
pnpm run artifacts:verify
```

Expected: PASS. The `verify-installed-cli.mjs` output must include:

```text
ktx managed runtime starts missing in isolated root
ktx managed runtime lazy install verified
ktx runtime doctor verified
ktx runtime daemon lifecycle verified
```

- [ ] **Step 3: Run release readiness**

Run:

```bash
pnpm run release:readiness
```

Expected: PASS. The report must still list `@kaelio/ktx` as the only npm
package and must still report registry publishing as disabled by
`release-policy.json`.

- [ ] **Step 4: Run pre-commit for changed files**

Run:

```bash
if [ -d .venv ]; then source .venv/bin/activate; fi
uv run pre-commit run --files scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs
```

Expected: PASS. If pre-commit cannot run because the local environment lacks a
compatible hook version, record the exact failure and keep the passing
`node --test` and artifact smoke results.

- [ ] **Step 5: Commit verification fixes if needed**

If Step 1, Step 2, Step 3, or Step 4 required edits, run:

```bash
git add scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs
git commit -m "test: finalize managed runtime release smoke"
```

If no files changed after Task 2, do not create an empty commit.

## Acceptance criteria

- `verifyNpmArtifacts()` no longer creates a Python `.venv`, no longer calls
  `pythonArtifactInstallArgs()`, and no longer runs npm smoke scripts with a
  custom Python venv at the front of `PATH`.
- The installed public npm smoke creates its sqlite warehouse with
  `better-sqlite3` and does not shell out to `python`.
- The installed public npm smoke sets an isolated `KTX_RUNTIME_ROOT` and
  confirms that `ktx runtime status --json` starts as `missing`.
- The first installed `ktx sl query --yes` installs the `core` managed Python
  runtime from bundled npm package assets and still returns compile-only SQL.
- A second semantic query executes against sqlite using the installed managed
  runtime.
- `ktx runtime doctor` passes after lazy install.
- `ktx runtime start` starts a core daemon, a second `ktx runtime start` reuses
  the daemon, and `ktx runtime stop` stops it.
- The separate Python artifact verification still installs and tests the
  Python wheel directly.
- Focused script tests, `pnpm run artifacts:verify`, release readiness, and
  pre-commit pass or have explicitly recorded environment blockers.

## Self-review

- Spec coverage: the previous six plans cover the bundled wheel, runtime
  installer, `sl query` command integration, daemon lifecycle, local embeddings,
  and public npm package surface. This plan covers release-flow checks for clean
  install of the packed npm package, first-run managed runtime install from the
  bundled wheel, one-shot semantic-layer query through the managed runtime,
  runtime status and doctor output, and daemon start/reuse/stop.
- Remaining intentional gap: optional `local-embeddings` smoke remains outside
  the default release artifact smoke because the spec permits it in a separate
  job or opt-in check and the dependency downloads are large.
- Placeholder scan: no steps contain placeholder implementation language.
- Type consistency: runtime feature names remain `core` and
  `local-embeddings`; the public npm package name remains `@kaelio/ktx`; the
  runtime root environment variable is `KTX_RUNTIME_ROOT`.
