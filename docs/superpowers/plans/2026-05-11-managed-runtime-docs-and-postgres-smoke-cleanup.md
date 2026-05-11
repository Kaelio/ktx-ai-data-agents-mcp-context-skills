# Managed Runtime Docs and Postgres Smoke Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining manual Python service guidance from the Postgres
historic SQL smoke and update public docs so the npm-managed Python runtime is
the documented path.

**Architecture:** Keep the existing managed-runtime code unchanged. Add source
and docs guards first, then make the Postgres historic smoke use the
CLI-managed core daemon through `createKtxCliLocalIngestAdapters()`, and update
the README files that still describe internal package artifacts, manual
`ktx-daemon` startup, or `python-service/`.

**Tech Stack:** Bash, Node 22 ESM, `node:test`, Markdown, pnpm, uv, KTX CLI
managed Python runtime.

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
- `docs/superpowers/plans/2026-05-11-managed-local-embeddings-release-smoke.md`
- `docs/superpowers/plans/2026-05-11-managed-agent-mcp-semantic-runtime.md`
- `docs/superpowers/plans/2026-05-11-managed-local-ingest-daemon-runtime.md`

Implementation evidence found before writing this plan includes:

- `scripts/build-python-runtime-wheel.mjs` and
  `packages/cli/assets/python/manifest.json`.
- `packages/cli/src/managed-python-runtime.ts`,
  `packages/cli/src/runtime.ts`, and
  `packages/cli/src/commands/runtime-commands.ts`.
- `packages/cli/src/managed-python-command.ts` and managed `ktx sl query`
  runtime policy flags.
- `packages/cli/src/managed-python-daemon.ts` and `ktx runtime start` /
  `ktx runtime stop`.
- `packages/cli/src/managed-local-embeddings.ts` and local embeddings setup
  wiring.
- `scripts/build-public-npm-package.mjs`, release policy updates, release
  smoke coverage, and opt-in local embeddings smoke coverage.
- `packages/cli/src/agent-runtime.ts` and `packages/cli/src/serve.ts` now
  create managed semantic-layer compute when no explicit semantic HTTP URL is
  provided.
- `packages/cli/src/managed-python-http.ts`,
  `packages/cli/src/local-adapters.ts`, `packages/cli/src/ingest.ts`,
  `packages/cli/src/scan.ts`, and `packages/cli/src/serve.ts` wire local ingest
  helper paths to the managed core daemon.

The remaining drift is documentation and one example smoke script:

- `examples/postgres-historic/scripts/smoke.sh` still checks for
  `python-service/.venv`, starts `uvicorn app.main:app`, and exports
  `KTX_SQL_ANALYSIS_URL`.
- `examples/postgres-historic/README.md` still documents
  `python-service/.venv` or `KTX_SQL_ANALYSIS_URL` as a prerequisite.
- `examples/package-artifacts/README.md` still says the npm smoke installs
  generated `@ktx/context` and `@ktx/cli` tarballs.
- `README.md` still presents source-tree `pnpm run ktx -- ...` commands as the
  quick start and tells users to start `ktx-daemon` manually for MCP.

This plan closes that drift. It does not rename internal workspace packages and
does not remove explicit daemon URL override behavior from production code.

## File structure

- Modify `scripts/examples-docs.test.mjs`: add regression coverage for managed
  runtime docs, public npm package docs, and the Postgres smoke script.
- Modify `examples/postgres-historic/scripts/smoke.sh`: remove
  `python-service/` startup and pass managed daemon options into stage-only
  historic SQL ingest.
- Modify `examples/postgres-historic/README.md`: document the managed runtime
  and remove old SQL-analysis service instructions.
- Modify `examples/package-artifacts/README.md`: describe the single public
  `@kaelio/ktx` npm artifact and managed runtime smoke.
- Modify `README.md`: make public `@kaelio/ktx` invocation modes and managed
  runtime commands visible while keeping source-tree development commands in
  the development section.

### Task 1: Add failing docs and smoke guards

**Files:**

- Modify: `scripts/examples-docs.test.mjs`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Add public runtime README assertions**

In `scripts/examples-docs.test.mjs`, insert this test after the existing
`walks through ktx connection list and ktx connection test in the README
quickstart` test:

```javascript
  it('documents public npm and managed runtime usage in the README', async () => {
    const rootReadme = await readText('README.md');

    assert.match(rootReadme, /npx @kaelio\/ktx setup demo --no-input/);
    assert.match(rootReadme, /npx @kaelio\/ktx sl query/);
    assert.match(rootReadme, /npm install @kaelio\/ktx/);
    assert.match(rootReadme, /npm install -g @kaelio\/ktx/);
    assert.match(rootReadme, /ktx runtime install/);
    assert.match(rootReadme, /ktx runtime status/);
    assert.match(rootReadme, /ktx runtime doctor/);
    assert.match(rootReadme, /ktx runtime start/);
    assert.match(rootReadme, /ktx runtime stop/);
    assert.match(rootReadme, /ktx serve --mcp stdio/);
    assert.doesNotMatch(rootReadme, /uv run ktx-daemon serve-http/);
    assert.doesNotMatch(rootReadme, /--semantic-compute-url http:\/\/127\.0\.0\.1:8765/);
  });
```

- [ ] **Step 2: Add package artifact README assertions**

In `scripts/examples-docs.test.mjs`, insert this test after the new public
runtime README test:

```javascript
  it('documents the public package artifact smoke shape', async () => {
    const readme = await readText('examples/package-artifacts/README.md');

    assert.match(readme, /@kaelio\/ktx/);
    assert.match(readme, /managed Python runtime/);
    assert.match(readme, /ktx runtime status/);
    assert.match(readme, /ktx runtime doctor/);
    assert.doesNotMatch(readme, /@ktx\/context/);
    assert.doesNotMatch(readme, /@ktx\/cli/);
    assert.doesNotMatch(readme, /python -m ktx_daemon semantic-validate/);
  });
```

- [ ] **Step 3: Extend Postgres smoke assertions**

In the existing `documents the Postgres historic SQL smoke example` test in
`scripts/examples-docs.test.mjs`, add these assertions after
`assert.match(smoke, /pg_stat_statements_reset/);`:

```javascript
    assert.match(smoke, /KTX_RUNTIME_ROOT/);
    assert.match(smoke, /managedDaemon/);
    assert.match(smoke, /installPolicy: 'auto'/);
    assert.match(smoke, /getKtxCliPackageInfo/);
    assert.doesNotMatch(smoke, /python-service/);
    assert.doesNotMatch(smoke, /PYTHON_SERVICE/);
    assert.doesNotMatch(smoke, /uvicorn app\.main:app/);
    assert.doesNotMatch(smoke, /export KTX_SQL_ANALYSIS_URL/);
    assert.doesNotMatch(readme, /python-service/);
    assert.doesNotMatch(readme, /KTX_SQL_ANALYSIS_URL/);
```

- [ ] **Step 4: Run the docs test to verify it fails**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL. The failure includes missing `@kaelio/ktx` README matches and
the existing `python-service` / `KTX_SQL_ANALYSIS_URL` references in the
Postgres smoke files.

### Task 2: Move the Postgres historic smoke to the managed runtime

**Files:**

- Modify: `examples/postgres-historic/scripts/smoke.sh`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Remove Python service process state**

In `examples/postgres-historic/scripts/smoke.sh`, replace the variable block:

```bash
KTX_BIN="$KTX_ROOT/packages/cli/dist/bin.js"
PYTHON_SERVICE_LOG="$PROJECT_PARENT/python-service.log"
PYTHON_SERVICE_PID=""
```

with:

```bash
KTX_BIN="$KTX_ROOT/packages/cli/dist/bin.js"
export KTX_RUNTIME_ROOT="$PROJECT_PARENT/managed-runtime"
unset KTX_DAEMON_URL
unset KTX_SQL_ANALYSIS_URL
```

- [ ] **Step 2: Replace cleanup**

In `examples/postgres-historic/scripts/smoke.sh`, replace the `cleanup()`
function with:

```bash
cleanup() {
  if [[ -f "$KTX_BIN" ]]; then
    node "$KTX_BIN" runtime stop >/dev/null 2>&1 || true
  fi
  if [[ "${KTX_POSTGRES_HISTORIC_KEEP_DOCKER:-0}" != "1" ]]; then
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
```

- [ ] **Step 3: Delete the old SQL analysis service starter**

Delete the entire `start_sql_analysis_if_needed()` function from
`examples/postgres-historic/scripts/smoke.sh`. The deleted function begins with
this line:

```bash
start_sql_analysis_if_needed() {
```

and ends with this line:

```bash
}
```

immediately before the `latest_manifest()` function.

- [ ] **Step 4: Pass managed daemon options to stage-only ingest**

In the Node heredoc inside `run_historic_stage_only()`, replace this block:

```javascript
const { createKtxCliLocalIngestAdapters } = await import(join(ktxRoot, 'packages/cli/dist/local-adapters.js'));

const project = await loadKtxProject({ projectDir });
const adapters = createKtxCliLocalIngestAdapters(project, { historicSqlConnectionId: 'warehouse' });
```

with:

```javascript
const { createKtxCliLocalIngestAdapters } = await import(join(ktxRoot, 'packages/cli/dist/local-adapters.js'));
const { getKtxCliPackageInfo } = await import(join(ktxRoot, 'packages/cli/dist/index.js'));

const project = await loadKtxProject({ projectDir });
const cliVersion = getKtxCliPackageInfo().version;
const managedRuntimeIo = { stdout: process.stdout, stderr: process.stderr };
const adapters = createKtxCliLocalIngestAdapters(project, {
  historicSqlConnectionId: 'warehouse',
  managedDaemon: {
    cliVersion,
    installPolicy: 'auto',
    io: managedRuntimeIo,
  },
});
```

- [ ] **Step 5: Remove the old starter call**

Delete this line from the bottom half of
`examples/postgres-historic/scripts/smoke.sh`:

```bash
start_sql_analysis_if_needed
```

- [ ] **Step 6: Run the docs test to verify the script guards pass**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL remains because README files have not been updated yet. The
Postgres smoke script assertions now pass.

### Task 3: Update Postgres historic and artifact docs

**Files:**

- Modify: `examples/postgres-historic/README.md`
- Modify: `examples/package-artifacts/README.md`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Replace Postgres prerequisites**

In `examples/postgres-historic/README.md`, replace the `## Prerequisites`
section with:

```markdown
## Prerequisites

- Docker with Compose v2
- Node and pnpm matching the KTX workspace
- `uv` on `PATH` so the KTX-managed Python runtime can install the bundled
  runtime wheel
```

- [ ] **Step 2: Replace the smoke run description**

In `examples/postgres-historic/README.md`, replace the paragraph after the
`examples/postgres-historic/scripts/smoke.sh` command with:

```markdown
The smoke creates a temporary KTX project, isolates the managed Python runtime
under the temporary project parent, starts Postgres on `127.0.0.1:55432`, and
uses this connection URL:
```

- [ ] **Step 3: Update the full ingest command**

In `examples/postgres-historic/README.md`, replace the manual ingest command:

```bash
node packages/cli/dist/bin.js --project-dir /tmp/ktx-postgres-historic dev ingest run \
  --connection-id warehouse \
  --adapter historic-sql \
  --plain \
  --no-input
```

with:

```bash
pnpm run ktx -- dev ingest run --project-dir /tmp/ktx-postgres-historic \
  --connection-id warehouse \
  --adapter historic-sql \
  --plain \
  --yes \
  --no-input
```

- [ ] **Step 4: Replace SQL-analysis troubleshooting**

In `examples/postgres-historic/README.md`, replace the final troubleshooting
bullet:

```markdown
- SQL-analysis failures: set `KTX_SQL_ANALYSIS_URL` to the running service URL
  or create `python-service/.venv` before running `scripts/smoke.sh`.
```

with:

```markdown
- SQL-analysis failures: run `pnpm run ktx -- runtime doctor` from the KTX
  repository root and confirm `uv`, the bundled Python wheel, and the managed
  runtime all pass.
```

- [ ] **Step 5: Replace package artifact README body**

Replace the full contents of `examples/package-artifacts/README.md` with:

````markdown
# Package artifact smoke checks

The package artifact smoke checks create temporary projects instead of storing
sample projects in this directory. Run the checks from `ktx/`:

```bash
pnpm run artifacts:check
```

The npm smoke project installs the generated public `@kaelio/ktx` tarball,
imports the package entry point, and runs installed `ktx` commands against a
generated local project.

The managed runtime smoke isolates `KTX_RUNTIME_ROOT`, verifies
`ktx runtime status`, runs `ktx sl query --yes` to install the core runtime from
the bundled wheel, checks `ktx runtime doctor`, starts and reuses the managed
daemon, and stops it.

The Python smoke project still installs the Python artifacts directly because
it verifies the standalone Python distributions that feed the bundled runtime
wheel.
````

- [ ] **Step 6: Run the docs test to verify these docs pass**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL remains because `README.md` still lacks the public npm managed
runtime documentation. The Postgres and package artifact assertions now pass.

### Task 4: Update the root README public runtime path

**Files:**

- Modify: `README.md`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Replace quick start**

In `README.md`, replace the `## Quick start` section through the end of the
full-demo paragraph with:

````markdown
## Quick start

Run the pre-seeded demo through the public npm package:

```bash
npx @kaelio/ktx setup demo --no-input
npx @kaelio/ktx setup demo inspect
```

The default demo uses packaged sample data and prebuilt context. It does not
require API keys, network access, or an LLM provider.

To replay the packaged ingest run, use:

```bash
npx @kaelio/ktx setup demo --mode replay --no-input
```

To run the full agentic demo with an LLM provider, set a provider key for the
current process:

```bash
ANTHROPIC_API_KEY=$YOUR_ANTHROPIC_API_KEY \
  npx @kaelio/ktx setup demo --mode full --no-input
```

Interactive full-demo setup can prompt for a provider key without writing the
key to `ktx.yaml`.

You can also install the CLI in a project or globally:

```bash
npm install @kaelio/ktx
npx ktx --help
npm install -g @kaelio/ktx
ktx --help
```
````

- [ ] **Step 2: Replace local project setup command**

In the `## Build a local project` section of `README.md`, replace:

```bash
uv sync --all-packages
source .venv/bin/activate

PROJECT_DIR="$(mktemp -d)/ktx-demo"
pnpm run ktx -- init "$PROJECT_DIR" --name ktx-demo
```

with:

```bash
npm install @kaelio/ktx
PROJECT_DIR="$(mktemp -d)/ktx-demo"
npx ktx init "$PROJECT_DIR" --name ktx-demo
```

- [ ] **Step 3: Replace README command prefixes**

In `README.md`, replace the source-tree command prefix `pnpm run ktx --` with
`npx ktx` in all user workflow commands under `## Build a local project`,
`### Scan the demo warehouse`, and `## Serve MCP`. Keep `pnpm run ktx --` in
the `## Development` section.

For example, this command:

```bash
pnpm run ktx -- sl query --project-dir "$PROJECT_DIR" \
```

becomes:

```bash
npx ktx sl query --project-dir "$PROJECT_DIR" \
```

- [ ] **Step 4: Add managed runtime section**

Insert this section after the scan walkthrough in `README.md`:

````markdown
## Managed Python runtime

KTX installs its Python runtime only when a Python-backed command needs it.
The runtime lives outside the npm cache, is versioned by the installed CLI
version, and is managed by `ktx runtime` commands:

```bash
npx ktx runtime install --yes
npx ktx runtime status
npx ktx runtime doctor
npx ktx runtime start
npx ktx runtime stop
```

Commands such as `npx @kaelio/ktx sl query ... --yes` can install the core
runtime lazily from the bundled wheel. Local embeddings remain lazy; prepare
them only when you select local `sentence-transformers` embeddings:

```bash
npx ktx runtime install --feature local-embeddings --yes
npx ktx runtime start --feature local-embeddings
```
````

- [ ] **Step 5: Replace Serve MCP section**

In `README.md`, replace the full `## Serve MCP` section with:

````markdown
## Serve MCP

Start the stdio MCP server from the project directory:

```bash
npx ktx serve --mcp stdio --project-dir "$PROJECT_DIR" \
  --user-id local \
  --semantic-compute \
  --execute-queries \
  --yes
```

The `--semantic-compute` flag uses the managed Python runtime when no explicit
semantic compute URL is provided. KTX starts or reuses the managed runtime as
needed.

The MCP server exposes `connection_list`, `knowledge_search`,
`knowledge_read`, `knowledge_write`, `sl_list_sources`, `sl_read_source`,
`sl_write_source`, `sl_validate`, `sl_query`, `ingest_trigger`,
`ingest_status`, `ingest_report`, and `ingest_replay`.
````

- [ ] **Step 6: Update release status wording**

In `README.md`, replace this sentence in `## Release status`:

```markdown
This repository is prepared for source publication. Package publishing is still
disabled by `release-policy.json`; registry names, public versions, package
visibility, and provenance policy must be chosen before publishing artifacts to
npm or Python package indexes.
```

with:

```markdown
This repository builds a single public npm artifact named `@kaelio/ktx`.
Package publishing is still disabled by `release-policy.json`; registry
credentials, public versions, release tags, and provenance policy must be
chosen before publishing artifacts to npm or Python package indexes.
```

- [ ] **Step 7: Run the docs test to verify the README passes**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

### Task 5: Final verification and commit

**Files:**

- Verify: `scripts/examples-docs.test.mjs`
- Verify: `examples/postgres-historic/scripts/smoke.sh`
- Verify: `examples/postgres-historic/README.md`
- Verify: `examples/package-artifacts/README.md`
- Verify: `README.md`

- [ ] **Step 1: Run the script test suite affected by docs**

Run:

```bash
node --test scripts/examples-docs.test.mjs scripts/check-boundaries.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the boundary check**

Run:

```bash
node scripts/check-boundaries.mjs
```

Expected:

```text
ktx boundary check passed
```

- [ ] **Step 3: Search for removed external runtime references**

Run:

```bash
rg -n "python-service|uvicorn app\\.main:app|export KTX_SQL_ANALYSIS_URL|uv run ktx-daemon serve-http|@ktx/context.*@ktx/cli" README.md examples/postgres-historic/README.md examples/postgres-historic/scripts/smoke.sh examples/package-artifacts/README.md
```

Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add scripts/examples-docs.test.mjs \
  examples/postgres-historic/scripts/smoke.sh \
  examples/postgres-historic/README.md \
  examples/package-artifacts/README.md \
  README.md
git commit -m "docs: align managed runtime examples"
```

## Acceptance criteria

- The Postgres historic SQL smoke no longer references `python-service/`,
  `uvicorn app.main:app`, or `export KTX_SQL_ANALYSIS_URL`.
- The stage-only Postgres historic smoke uses `createKtxCliLocalIngestAdapters`
  with managed daemon options and `installPolicy: 'auto'`.
- The root README documents `npx @kaelio/ktx`, local `npx ktx`, global `ktx`,
  `ktx runtime ...`, and MCP `--semantic-compute --yes` managed-runtime usage.
- Package artifact docs describe the single public `@kaelio/ktx` tarball and
  the managed runtime smoke.
- `node --test scripts/examples-docs.test.mjs scripts/check-boundaries.test.mjs`
  passes.
- `node scripts/check-boundaries.mjs` passes.

## Self-review

- Spec coverage: This plan covers the remaining user-facing drift from the
  npm-managed runtime spec by removing manual Python service guidance,
  documenting public `@kaelio/ktx` invocation modes, and making the Postgres
  example smoke use the managed core daemon.
- Placeholder scan: The plan contains exact files, edits, commands, expected
  outcomes, and commit instructions.
- Type consistency: The plan uses the existing `managedDaemon` option shape
  from `packages/cli/src/local-adapters.ts` and the existing
  `installPolicy: 'auto'` value from `packages/cli/src/managed-python-command.ts`.
