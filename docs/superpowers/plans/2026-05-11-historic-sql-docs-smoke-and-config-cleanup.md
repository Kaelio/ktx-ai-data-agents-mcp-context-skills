# Historic SQL Docs Smoke And Config Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the historic-SQL redesign follow-through by making setup emit the canonical config shape and replacing stale PGSS baseline/delta/reset example docs with unified artifact and no-WorkUnit idempotency checks.

**Architecture:** This is the acceptance/documentation slice after the adapter cutover. Product code changes are limited to `ktx setup` Historic SQL config serialization; the Postgres example smoke remains a deterministic stage-only path that uses the real local adapter, managed daemon, Docker Postgres, and raw artifact diffing without requiring LLM credentials. Public docs are updated to match the unified Postgres, BigQuery, and Snowflake reader behavior already present in source.

**Tech Stack:** TypeScript, Vitest, Bash, Node.js ESM, `node:test`, pnpm, Docker Compose, KTX local stage-only ingest, managed `ktx-daemon`.

---

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Plans already based on this spec:

- `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md` - implemented in source: `skill-schemas.ts`, `SemanticLayerSource.usage`, `mergeUsagePreservingExternal()`, `/sql/analyze-batch`, and `SqlAnalysisPort.analyzeBatch()`.
- `docs/superpowers/plans/2026-05-11-historic-sql-search-enrichment.md` - implemented in source: usage fields in `buildSemanticLayerSourceSearchText()`, SQLite FTS snippets, query-mode `score`, `frequencyTier`, and agent/MCP list propagation.
- `docs/superpowers/plans/2026-05-11-historic-sql-unified-hot-path.md` - implemented in source: unified config/types, bucket helpers, `stage-unified.ts`, aggregate readers, and `chunk-unified.ts`.
- `docs/superpowers/plans/2026-05-11-historic-sql-skills-projection-cutover.md` - implemented in source: replacement skills, evidence tool, projection, post-processor wiring, production adapter cutover, legacy source deletion, and `minExecutions` alias support.
- `docs/superpowers/plans/2026-05-11-historic-sql-cross-dialect-readiness.md` - implemented in source: cross-dialect CLI wiring, generic reader injection, probe result normalization, and PGSS max informational doctor output.

Remaining gap this plan covers:

- `examples/postgres-historic/scripts/smoke.sh`, `examples/postgres-historic/README.md`, `examples/README.md`, and `scripts/examples-docs.test.mjs` still describe the legacy baseline/delta/reset model.
- Public docs still mention `minCalls` and say BigQuery/Snowflake local CLI Historic SQL uses the Postgres path.
- `packages/cli/src/setup-databases.ts` still writes `serviceAccountUserPatterns` for new setup output even though the redesign's canonical runtime config is `filters.serviceAccounts`.

## File Structure

- Modify `packages/cli/src/setup-databases.ts`: write canonical `historicSql.filters.serviceAccounts` blocks from setup flags while keeping existing parser compatibility in `packages/context/src/ingest/adapters/historic-sql/types.ts`.
- Modify `packages/cli/src/setup-databases.test.ts`: assert generated YAML uses `filters` and no longer writes `serviceAccountUserPatterns`.
- Modify `scripts/examples-docs.test.mjs`: lock public example docs and smoke script to the unified artifact contract.
- Modify `examples/postgres-historic/scripts/smoke.sh`: assert `manifest.json`, `tables/*.json`, `patterns-input.json`, per-run `workUnitCount`, and stage-only runtime under 60 seconds after runtime warm-up.
- Modify `examples/postgres-historic/README.md`: replace baseline/delta/reset instructions with unified artifact, no-WorkUnit idempotency, and `minExecutions` language.
- Modify `examples/README.md`: replace the stale one-paragraph summary.
- Modify `docs/content/docs/integrations/primary-sources.mdx`: update Postgres, Snowflake, and BigQuery Historic SQL docs to the unified config and current support status.
- Modify `docs/content/docs/cli-reference/ktx-setup.mdx`: document `--historic-sql-min-executions` as primary and `--historic-sql-min-calls` as the one-release alias.

### Task 1: Emit Canonical Historic SQL Setup Config

**Files:**
- Modify: `packages/cli/src/setup-databases.test.ts`
- Modify: `packages/cli/src/setup-databases.ts`

- [ ] **Step 1: Update failing setup config assertions**

In `packages/cli/src/setup-databases.test.ts`, update the Snowflake expectation in `writes Historic SQL config for supported Snowflake databases after validation succeeds` to:

```typescript
    expect(config.connections.snowflake).toMatchObject({
      driver: 'snowflake',
      authMethod: 'password',
      historicSql: {
        enabled: true,
        dialect: 'snowflake',
        windowDays: 30,
        filters: {
          dropTrivialProbes: true,
          serviceAccounts: {
            patterns: ['^svc_'],
            mode: 'exclude',
          },
        },
        redactionPatterns: ['(?i)secret'],
      },
    });
    expect(config.connections.snowflake.historicSql).not.toHaveProperty('serviceAccountUserPatterns');
```

In the same file, update the Postgres expectation in `writes Postgres Historic SQL config with minExecutions and ignores window/redaction output` to:

```typescript
    expect(config.connections.warehouse).toMatchObject({
      driver: 'postgres',
      url: 'env:DATABASE_URL',
      schemas: ['public'],
      historicSql: {
        enabled: true,
        dialect: 'postgres',
        minExecutions: 12,
        filters: {
          dropTrivialProbes: true,
          serviceAccounts: {
            patterns: ['^svc_'],
            mode: 'exclude',
          },
        },
      },
    });
    expect(config.connections.warehouse.historicSql).not.toHaveProperty('minCalls');
    expect(config.connections.warehouse.historicSql).not.toHaveProperty('windowDays');
    expect(config.connections.warehouse.historicSql).not.toHaveProperty('redactionPatterns');
    expect(config.connections.warehouse.historicSql).not.toHaveProperty('serviceAccountUserPatterns');
```

Update the existing BigQuery connection expectation in `writes Historic SQL config for supported existing database connections` to:

```typescript
    expect(config.connections.analytics).toMatchObject({
      historicSql: {
        enabled: true,
        dialect: 'bigquery',
        windowDays: 45,
        filters: {
          dropTrivialProbes: true,
        },
        redactionPatterns: [],
      },
    });
    expect(config.connections.analytics.historicSql).not.toHaveProperty('serviceAccountUserPatterns');
```

Update the existing Postgres connection expectation in `enables Historic SQL on an existing Postgres connection` to:

```typescript
    expect(config.connections.warehouse).toMatchObject({
      historicSql: {
        enabled: true,
        dialect: 'postgres',
        minExecutions: 8,
        filters: {
          dropTrivialProbes: true,
        },
      },
    });
    expect(config.connections.warehouse.historicSql).not.toHaveProperty('serviceAccountUserPatterns');
```

- [ ] **Step 2: Run setup tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts --testNamePattern "Historic SQL"
```

Expected: FAIL because `historicSql.serviceAccountUserPatterns` is still written and `historicSql.filters` is missing from generated setup YAML.

- [ ] **Step 3: Write canonical setup config**

In `packages/cli/src/setup-databases.ts`, add this helper near `maybeApplyHistoricSqlConfig()`:

```typescript
function historicSqlFiltersForSetup(patterns: string[] | undefined) {
  const serviceAccountPatterns = patterns ?? [];
  return {
    dropTrivialProbes: true,
    ...(serviceAccountPatterns.length > 0
      ? {
          serviceAccounts: {
            patterns: serviceAccountPatterns,
            mode: 'exclude' as const,
          },
        }
      : {}),
  };
}
```

Then replace the `common` object inside `maybeApplyHistoricSqlConfig()` with:

```typescript
  const common: Record<string, unknown> = {
    ...existing,
    enabled: true,
    dialect,
    filters: historicSqlFiltersForSetup(input.args.historicSqlServiceAccountPatterns),
  };
  delete common.serviceAccountUserPatterns;
```

Keep the existing `minExecutions`, `windowDays`, and `redactionPatterns` branches unchanged after this object replacement.

- [ ] **Step 4: Run setup tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts --testNamePattern "Historic SQL"
```

Expected: PASS for all Historic SQL setup tests in `src/setup-databases.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts
git commit -m "fix: write canonical historic sql setup filters"
```

### Task 2: Lock Example Docs To Unified Historic SQL Terms

**Files:**
- Modify: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Update the failing example docs test**

Replace the `documents the Postgres historic SQL smoke example` test body in `scripts/examples-docs.test.mjs` with:

```javascript
  it('documents the Postgres historic SQL smoke example', async () => {
    const examples = await readText('examples/README.md');
    const readme = await readText('examples/postgres-historic/README.md');
    const compose = await readText('examples/postgres-historic/docker-compose.yml');
    const initSql = await readText('examples/postgres-historic/init/001-schema.sql');
    const workload = await readText('examples/postgres-historic/scripts/generate-workload.sh');
    const smoke = await readText('examples/postgres-historic/scripts/smoke.sh');

    assert.match(examples, /postgres-historic/);
    assert.match(examples, /unified Historic SQL artifacts/);
    assert.match(readme, /--enable-historic-sql/);
    assert.match(readme, /--historic-sql-min-executions 2/);
    assert.match(readme, /ktx dev doctor --project-dir/);
    assert.match(readme, /Postgres Historic SQL/);
    assert.match(readme, /manifest\.json/);
    assert.match(readme, /tables\/\*\.json/);
    assert.match(readme, /patterns-input\.json/);
    assert.match(readme, /workUnitCount: 0/);
    assert.match(compose, /postgres:14/);
    assert.match(compose, /shared_preload_libraries=pg_stat_statements/);
    assert.match(compose, /pg_stat_statements.track=top/);
    assert.match(initSql, /CREATE EXTENSION IF NOT EXISTS pg_stat_statements/);
    assert.match(initSql, /GRANT pg_read_all_stats TO ktx_reader/);
    assert.match(workload, /JOIN customers/);
    assert.match(workload, /app_user/);
    assert.match(workload, /etl_user/);
    assert.match(smoke, /assert_unified_snapshot/);
    assert.match(smoke, /assert_stage_record "\$UNCHANGED_RECORD" unchanged zero/);
    assert.match(smoke, /--historic-sql-min-executions 2/);
    assert.match(smoke, /KTX_RUNTIME_ROOT/);
    assert.match(smoke, /managedDaemon/);
    assert.match(smoke, /installPolicy: 'auto'/);
    assert.match(smoke, /getKtxCliPackageInfo/);
    assert.doesNotMatch(smoke, /python-service/);
    assert.doesNotMatch(smoke, /PYTHON_SERVICE/);
    assert.doesNotMatch(smoke, /uvicorn app\.main:app/);
    assert.doesNotMatch(smoke, /export KTX_SQL_ANALYSIS_URL/);
    assert.doesNotMatch(smoke, /baselineFirstRun|degraded|statsResetAt|assert_manifest/);
    assert.doesNotMatch(readme, /python-service/);
    assert.doesNotMatch(readme, /KTX_SQL_ANALYSIS_URL/);
    assert.doesNotMatch(readme, /baselineFirstRun|degraded: true|statsResetAt|fresh PGSS baseline|delta-only/);
    assert.doesNotMatch(readme, /--historic-sql-min-calls/);
  });
```

- [ ] **Step 2: Run the docs test to verify it fails**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL because the current README and smoke script still mention `--historic-sql-min-calls`, `baselineFirstRun`, `degraded`, and the legacy `assert_manifest` helper.

- [ ] **Step 3: Commit the failing test**

```bash
git add scripts/examples-docs.test.mjs
git commit -m "test: expect unified historic sql example docs"
```

### Task 3: Rewrite The Postgres Historic SQL Smoke

**Files:**
- Modify: `examples/postgres-historic/scripts/smoke.sh`

- [ ] **Step 1: Replace the smoke script with unified artifact assertions**

Replace `examples/postgres-historic/scripts/smoke.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KTX_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
COMPOSE_FILE="$EXAMPLE_DIR/docker-compose.yml"
PROJECT_PARENT="${KTX_POSTGRES_HISTORIC_PROJECT_PARENT:-$(mktemp -d)}"
PROJECT_DIR="$PROJECT_PARENT/postgres-historic-ktx"
KTX_BIN="$KTX_ROOT/packages/cli/dist/bin.js"
MAX_STAGE_SECONDS="${KTX_POSTGRES_HISTORIC_MAX_STAGE_SECONDS:-60}"
export KTX_RUNTIME_ROOT="$PROJECT_PARENT/managed-runtime"
unset KTX_DAEMON_URL
unset KTX_SQL_ANALYSIS_URL

cleanup() {
  if [[ -f "$KTX_BIN" ]]; then
    node "$KTX_BIN" runtime stop >/dev/null 2>&1 || true
  fi
  if [[ "${KTX_POSTGRES_HISTORIC_KEEP_DOCKER:-0}" != "1" ]]; then
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

latest_manifest() {
  find "$PROJECT_DIR/raw-sources/warehouse/historic-sql" -name manifest.json | sort | tail -n 1
}

assert_unified_snapshot() {
  local manifest_path="$1"
  node - "$manifest_path" <<'NODE'
const { dirname, join } = require('node:path');
const { readFileSync, readdirSync } = require('node:fs');

const manifestPath = process.argv[2];
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(manifest.source === 'historic-sql', `Expected source historic-sql, got ${manifest.source}`);
assert(manifest.dialect === 'postgres', `Expected dialect postgres, got ${manifest.dialect}`);
assert(Number.isInteger(manifest.snapshotRowCount) && manifest.snapshotRowCount > 0, 'Expected snapshotRowCount > 0');
assert(Number.isInteger(manifest.touchedTableCount) && manifest.touchedTableCount > 0, 'Expected touchedTableCount > 0');
assert(Number.isInteger(manifest.parseFailures), 'Expected numeric parseFailures');
assert(Array.isArray(manifest.warnings), 'Expected warnings array');
assert(Array.isArray(manifest.probeWarnings), 'Expected probeWarnings array');
for (const legacyKey of ['degraded', 'baselineFirstRun', 'pgServerVersion', 'statsResetAt', 'templates']) {
  assert(!(legacyKey in manifest), `Legacy manifest key is still present: ${legacyKey}`);
}

const root = dirname(manifestPath);
const tableDir = join(root, 'tables');
const tableFiles = readdirSync(tableDir).filter((file) => file.endsWith('.json')).sort();
assert(tableFiles.length === manifest.touchedTableCount, `Expected ${manifest.touchedTableCount} table files, got ${tableFiles.length}`);

const firstTable = JSON.parse(readFileSync(join(tableDir, tableFiles[0]), 'utf8'));
assert(typeof firstTable.table === 'string' && firstTable.table.length > 0, 'Expected staged table name');
assert(firstTable.stats && typeof firstTable.stats.executionsBucket === 'string', 'Expected bucketed table stats');
assert(firstTable.columnsByClause && typeof firstTable.columnsByClause === 'object', 'Expected columnsByClause object');
assert(Array.isArray(firstTable.observedJoins), 'Expected observedJoins array');
assert(Array.isArray(firstTable.topTemplates) && firstTable.topTemplates.length > 0, 'Expected topTemplates');

const patterns = JSON.parse(readFileSync(join(root, 'patterns-input.json'), 'utf8'));
assert(Array.isArray(patterns.templates) && patterns.templates.length > 0, 'Expected patterns-input templates');
assert(
  patterns.templates.every((template) => Array.isArray(template.tablesTouched) && template.tablesTouched.length > 0),
  'Expected every pattern template to have touched tables',
);
NODE
}

assert_stage_record() {
  local record_path="$1"
  local label="$2"
  local expected_work_units="$3"
  node - "$record_path" "$label" "$expected_work_units" "$MAX_STAGE_SECONDS" <<'NODE'
const { readFileSync } = require('node:fs');

const record = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const label = process.argv[3];
const expectedWorkUnits = process.argv[4];
const maxSeconds = Number(process.argv[5]);
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(record.status === 'done', `${label}: expected status done, got ${record.status}`);
assert(record.adapter === 'historic-sql', `${label}: expected historic-sql adapter`);
assert(record.connectionId === 'warehouse', `${label}: expected warehouse connection`);
assert(record.rawFileCount >= 3, `${label}: expected manifest, patterns input, and at least one table file`);
assert(Array.isArray(record.errors) && record.errors.length === 0, `${label}: expected no errors`);

if (expectedWorkUnits === 'zero') {
  assert(record.workUnitCount === 0, `${label}: expected zero WorkUnits, got ${record.workUnitCount}`);
  assert(Array.isArray(record.workUnits) && record.workUnits.length === 0, `${label}: expected empty workUnits`);
} else if (expectedWorkUnits === 'nonzero') {
  assert(record.workUnitCount > 0, `${label}: expected nonzero WorkUnits`);
  assert(record.workUnits.some((unit) => unit.unitKey === 'historic-sql-patterns'), `${label}: expected patterns WorkUnit`);
  assert(record.workUnits.some((unit) => unit.unitKey.startsWith('historic-sql-table-')), `${label}: expected table WorkUnit`);
} else {
  throw new Error(`${label}: unknown expected work unit mode ${expectedWorkUnits}`);
}

const elapsedMs = Date.parse(record.completedAt) - Date.parse(record.startedAt);
assert(Number.isFinite(elapsedMs) && elapsedMs >= 0, `${label}: invalid elapsed time`);
assert(elapsedMs <= maxSeconds * 1000, `${label}: stage-only ingest took ${elapsedMs}ms, over ${maxSeconds}s`);
NODE
}

run_historic_stage_only() {
  local job_id="$1"
  local record_path="$2"
  node - "$KTX_ROOT" "$PROJECT_DIR" "$job_id" "$record_path" <<'NODE'
const { writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');

const ktxRoot = process.argv[2];
const projectDir = process.argv[3];
const jobId = process.argv[4];
const recordPath = process.argv[5];
const { loadKtxProject } = await import(join(ktxRoot, 'packages/context/dist/project/index.js'));
const { runLocalStageOnlyIngest } = await import(join(ktxRoot, 'packages/context/dist/ingest/index.js'));
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
const adapter = adapters.find((candidate) => candidate.source === 'historic-sql');
if (!adapter) throw new Error('historic-sql adapter was not registered for local run');
const record = await runLocalStageOnlyIngest({
  project,
  adapters,
  adapter: 'historic-sql',
  connectionId: 'warehouse',
  trigger: 'manual_resync',
  jobId,
});
await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(`${record.syncId} workUnits=${record.workUnitCount}`);
NODE
}

cd "$KTX_ROOT"
pnpm --filter @ktx/context run build
pnpm --filter @ktx/cli run build

docker compose -f "$COMPOSE_FILE" up -d --wait
"$EXAMPLE_DIR/scripts/generate-workload.sh" base

export WAREHOUSE_DATABASE_URL="${WAREHOUSE_DATABASE_URL:-postgresql://ktx_reader:ktx_reader@127.0.0.1:55432/analytics}" # pragma: allowlist secret
node "$KTX_BIN" --project-dir "$PROJECT_DIR" setup \
  --new \
  --skip-agents \
  --skip-llm \
  --skip-embeddings \
  --skip-sources \
  --database postgres \
  --new-database-connection-id warehouse \
  --database-url env:WAREHOUSE_DATABASE_URL \
  --database-schema public \
  --enable-historic-sql \
  --historic-sql-min-executions 2 \
  --yes \
  --no-input

node "$KTX_BIN" runtime install --yes
node "$KTX_BIN" runtime start

FIRST_RECORD="$PROJECT_PARENT/first-record.json"
run_historic_stage_only "historic-first-$$" "$FIRST_RECORD"
FIRST_MANIFEST="$(latest_manifest)"
assert_unified_snapshot "$FIRST_MANIFEST"
assert_stage_record "$FIRST_RECORD" first nonzero

UNCHANGED_RECORD="$PROJECT_PARENT/unchanged-record.json"
run_historic_stage_only "historic-unchanged-$$" "$UNCHANGED_RECORD"
UNCHANGED_MANIFEST="$(latest_manifest)"
assert_unified_snapshot "$UNCHANGED_MANIFEST"
assert_stage_record "$UNCHANGED_RECORD" unchanged zero

"$EXAMPLE_DIR/scripts/generate-workload.sh" extra
CHANGED_RECORD="$PROJECT_PARENT/changed-record.json"
run_historic_stage_only "historic-changed-$$" "$CHANGED_RECORD"
CHANGED_MANIFEST="$(latest_manifest)"
assert_unified_snapshot "$CHANGED_MANIFEST"
assert_stage_record "$CHANGED_RECORD" changed nonzero

echo "Postgres historic SQL smoke passed"
echo "Project dir: $PROJECT_DIR"
```

- [ ] **Step 2: Run the docs test to verify smoke-script assertions now pass or expose remaining README failures**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL remains because `examples/postgres-historic/README.md`, `examples/README.md`, and public docs have not been rewritten yet. The smoke-specific assertions for `assert_unified_snapshot`, `assert_stage_record`, and `--historic-sql-min-executions 2` should pass.

- [ ] **Step 3: Commit**

```bash
git add examples/postgres-historic/scripts/smoke.sh
git commit -m "test: assert unified postgres historic sql smoke"
```

### Task 4: Update Example And Public Docs

**Files:**
- Modify: `examples/postgres-historic/README.md`
- Modify: `examples/README.md`
- Modify: `docs/content/docs/integrations/primary-sources.mdx`
- Modify: `docs/content/docs/cli-reference/ktx-setup.mdx`

- [ ] **Step 1: Replace the Postgres historic README**

Replace `examples/postgres-historic/README.md` with:

````markdown
# Postgres Historic SQL Example

This example is a manual smoke for the redesigned Postgres historic-SQL ingest
path through `pg_stat_statements`. It starts Postgres 14 with the extension
preloaded, generates query workload under separate users, runs `ktx setup` with
`--enable-historic-sql`, and verifies the unified staged artifacts:

- `manifest.json`
- `tables/*.json`
- `patterns-input.json`

The smoke also runs the same workload twice and verifies the second stage-only
run has `workUnitCount: 0`, which proves unchanged bucketed table and pattern
inputs do not schedule LLM work.

## Prerequisites

- Docker with Compose v2
- Node and pnpm matching the KTX workspace
- `uv` on `PATH` so the KTX-managed Python runtime can install the bundled
  runtime wheel

## Run

From the KTX repository root:

```bash
examples/postgres-historic/scripts/smoke.sh
```

The smoke creates a temporary KTX project, isolates the managed Python runtime
under the temporary project parent, starts Postgres on `127.0.0.1:55432`, and
uses this connection URL:

```bash
postgresql://ktx_reader:ktx_reader@127.0.0.1:55432/analytics # pragma: allowlist secret
```

Set `KTX_POSTGRES_HISTORIC_KEEP_DOCKER=1` to leave the container running after
the script exits.

The smoke validates the historic-SQL raw snapshot path without requiring LLM
credentials. It uses KTX's local stage-only ingest API after `ktx setup`, so the
deterministic reader, batch SQL parser, stable artifact writer, and diff-based
WorkUnit planning are checked independently from curation.

## Manual Commands

Start Postgres and generate the base workload:

```bash
docker compose -f examples/postgres-historic/docker-compose.yml up -d --wait
examples/postgres-historic/scripts/generate-workload.sh base
```

Create a project and enable historic SQL:

```bash
export WAREHOUSE_DATABASE_URL=postgresql://ktx_reader:ktx_reader@127.0.0.1:55432/analytics # pragma: allowlist secret
pnpm --filter @ktx/cli run build
node packages/cli/dist/bin.js --project-dir /tmp/ktx-postgres-historic setup \
  --new \
  --skip-agents \
  --skip-llm \
  --skip-embeddings \
  --skip-sources \
  --database postgres \
  --new-database-connection-id warehouse \
  --database-url env:WAREHOUSE_DATABASE_URL \
  --database-schema public \
  --enable-historic-sql \
  --historic-sql-min-executions 2 \
  --yes \
  --no-input
```

### Readiness check

```bash
pnpm run ktx -- dev doctor --project-dir /tmp/ktx-postgres-historic --no-input
```

The installed CLI form is:

```bash
ktx dev doctor --project-dir /tmp/ktx-postgres-historic --no-input
```

Expected output includes `PASS Postgres Historic SQL (warehouse)` when
`pg_stat_statements` is installed, `pg_read_all_stats` is granted, and tracking
is enabled. A low `pg_stat_statements.max` value is reported as an informational
note, not a warning.

Run local historic-SQL ingest:

```bash
pnpm run ktx -- dev ingest run --project-dir /tmp/ktx-postgres-historic \
  --connection-id warehouse \
  --adapter historic-sql \
  --plain \
  --yes \
  --no-input
```

The full `dev ingest run` path also runs curation WorkUnits, so it requires a
configured LLM provider.

Inspect the latest manifest:

```bash
find /tmp/ktx-postgres-historic/raw-sources/warehouse/historic-sql -name manifest.json | sort | tail -n 1
```

The manifest should have `source: "historic-sql"`, `dialect: "postgres"`,
positive `snapshotRowCount`, positive `touchedTableCount`, numeric
`parseFailures`, `warnings`, and `probeWarnings`. The same directory should
contain `patterns-input.json` and one `tables/*.json` file per touched table.

## Troubleshooting

- Missing extension: confirm `shared_preload_libraries=pg_stat_statements` and
  `CREATE EXTENSION pg_stat_statements;` both happened in the `analytics`
  database.
- Missing grants: confirm `GRANT pg_read_all_stats TO ktx_reader;`.
- Empty snapshot: rerun `scripts/generate-workload.sh base` and keep
  `--historic-sql-min-executions 2` for the smoke.
- SQL-analysis failures: run `pnpm run ktx -- runtime doctor` from the KTX
  repository root and confirm `uv`, the bundled Python wheel, and the managed
  runtime all pass.
````

- [ ] **Step 2: Update the examples index paragraph**

In `examples/README.md`, replace the `postgres-historic` paragraph with:

```markdown
## postgres-historic

`postgres-historic/` is a manual Docker-backed smoke for Postgres
historic-SQL ingest via `pg_stat_statements`. It verifies setup, unified
Historic SQL artifacts, managed daemon batch SQL analysis, and no-WorkUnit
idempotency for unchanged bucketed table and pattern inputs.
```

- [ ] **Step 3: Update the setup CLI reference**

In `docs/content/docs/cli-reference/ktx-setup.mdx`, replace the Historic SQL flag rows with:

```markdown
| `--enable-historic-sql` | Enable Historic SQL when the selected database supports it | `false` |
| `--disable-historic-sql` | Disable Historic SQL for the selected database | `false` |
| `--historic-sql-window-days <number>` | Historic SQL query-history window in days | — |
| `--historic-sql-min-executions <number>` | Minimum executions for a Historic SQL template | — |
| `--historic-sql-min-calls <number>` | Alias for `--historic-sql-min-executions` for one release | — |
| `--historic-sql-service-account-pattern <pattern>` | Historic SQL service-account regex; repeatable | — |
| `--historic-sql-redaction-pattern <pattern>` | Historic SQL SQL-literal redaction regex; repeatable | — |
```

- [ ] **Step 4: Update primary source Historic SQL docs**

In `docs/content/docs/integrations/primary-sources.mdx`, replace the Postgres Historic SQL config block with:

````markdown
```yaml
historicSql:
  enabled: true
  dialect: postgres
  minExecutions: 5
  filters:
    dropTrivialProbes: true
```
````

Replace the Snowflake Historic SQL feature row with:

```markdown
| Historic SQL | Yes | Via `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` when enabled |
```

Replace the Snowflake Historic SQL paragraph and config block with:

````markdown
Snowflake Historic SQL reads aggregated query-history templates from
`SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` and feeds the same unified staged
artifact shape as Postgres and BigQuery.

```yaml
historicSql:
  enabled: true
  dialect: snowflake
  windowDays: 90
  minExecutions: 5
  filters:
    dropTrivialProbes: true
    serviceAccounts:
      patterns: ['^svc_']
      mode: exclude
  redactionPatterns: []
```
````

Replace the BigQuery Historic SQL feature row with:

```markdown
| Historic SQL | Yes | Via region-scoped `INFORMATION_SCHEMA.JOBS_BY_PROJECT` when enabled |
```

Replace the BigQuery Historic SQL paragraph and config block with:

````markdown
BigQuery Historic SQL reads aggregated query-history templates from
region-scoped `INFORMATION_SCHEMA.JOBS_BY_PROJECT` and feeds the same unified
staged artifact shape as Postgres and Snowflake.

```yaml
historicSql:
  enabled: true
  dialect: bigquery
  windowDays: 90
  minExecutions: 5
  filters:
    dropTrivialProbes: true
    serviceAccounts:
      patterns: ['@bot\\.']
      mode: exclude
  redactionPatterns: []
```
````

- [ ] **Step 5: Run docs tests to verify they pass**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS. The Postgres historic example test now sees unified artifact language and no legacy baseline/delta/reset wording.

- [ ] **Step 6: Commit**

```bash
git add examples/postgres-historic/README.md examples/README.md docs/content/docs/integrations/primary-sources.mdx docs/content/docs/cli-reference/ktx-setup.mdx
git commit -m "docs: refresh historic sql setup and smoke docs"
```

### Task 5: Final Verification

**Files:**
- Verify: `packages/cli/src/setup-databases.ts`
- Verify: `packages/cli/src/setup-databases.test.ts`
- Verify: `scripts/examples-docs.test.mjs`
- Verify: `examples/postgres-historic/scripts/smoke.sh`
- Verify: `examples/postgres-historic/README.md`
- Verify: `examples/README.md`
- Verify: `docs/content/docs/integrations/primary-sources.mdx`
- Verify: `docs/content/docs/cli-reference/ktx-setup.mdx`

- [ ] **Step 1: Run focused setup tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts --testNamePattern "Historic SQL"
```

Expected: PASS.

- [ ] **Step 2: Run example docs tests**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run CLI type check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 4: Run grep checks for stale legacy wording**

Run:

```bash
rg -n "baselineFirstRun|fresh PGSS baseline|delta-only|--historic-sql-min-calls 2|local CLI Historic SQL ingest currently uses the Postgres path" examples docs/content scripts packages/cli/src/setup-databases.test.ts
```

Expected: no matches.

Run:

```bash
rg -n "serviceAccountUserPatterns" packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts docs/content examples
```

Expected: no matches. Existing runtime compatibility in `packages/context/src/ingest/adapters/historic-sql/types.ts` must remain untouched, so do not run this grep across `packages/context`.

- [ ] **Step 5: Run the Docker-backed smoke when Docker is available**

Run:

```bash
examples/postgres-historic/scripts/smoke.sh
```

Expected: PASS with `Postgres historic SQL smoke passed`. If Docker is not running or unavailable, record the exact Docker error and still run Steps 1-4.

- [ ] **Step 6: Run pre-commit for touched files**

Run:

```bash
uv run pre-commit run --files \
  packages/cli/src/setup-databases.ts \
  packages/cli/src/setup-databases.test.ts \
  scripts/examples-docs.test.mjs \
  examples/postgres-historic/scripts/smoke.sh \
  examples/postgres-historic/README.md \
  examples/README.md \
  docs/content/docs/integrations/primary-sources.mdx \
  docs/content/docs/cli-reference/ktx-setup.mdx
```

Expected: PASS when pre-commit is configured. If pre-commit is not configured or this workspace lacks the required hook environment, keep the output and rely on Steps 1-5 plus `git diff --check`.

- [ ] **Step 7: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 8: Commit verification fixes only if verification changed files**

If any verification step required an edit, commit the exact touched files:

```bash
git add packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts scripts/examples-docs.test.mjs examples/postgres-historic/scripts/smoke.sh examples/postgres-historic/README.md examples/README.md docs/content/docs/integrations/primary-sources.mdx docs/content/docs/cli-reference/ktx-setup.mdx
git commit -m "test: verify historic sql docs and smoke cleanup"
```

If verification made no edits, do not create an empty commit.

## Self-Review

Spec coverage:

- Spec §8 setup config is covered by Task 1 and Task 4.
- Spec §10.3 docs and setup wizard updates are covered by Tasks 1 and 4.
- Spec §10.4 demo DB acceptance is covered by Task 3 and Task 5.
- The prior implemented plans already cover daemon batch analysis, unified staging, skills/projection, search enrichment, old-code deletion, and cross-dialect local adapter wiring.

Placeholder scan:

- This plan contains concrete file paths, exact replacement snippets, exact commands, and expected outcomes for every step.

Type consistency:

- `filters.dropTrivialProbes`, `filters.serviceAccounts.patterns`, and `filters.serviceAccounts.mode` match `historicSqlUnifiedPullConfigSchema`.
- `workUnitCount`, `rawFileCount`, `startedAt`, and `completedAt` match `LocalIngestRunRecord`.
- `manifest.json`, `tables/*.json`, and `patterns-input.json` match the unified staged artifact names from `stage-unified.ts`.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-docs-smoke-and-config-cleanup.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
