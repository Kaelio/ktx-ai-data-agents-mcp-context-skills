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
const { existsSync, readFileSync, readdirSync } = require('node:fs');

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
const legacyKeys = [
  ['de', 'graded'],
  ['baseline', 'FirstRun'],
  ['pgServer', 'Version'],
  ['stats', 'ResetAt'],
  ['templates'],
].map((parts) => parts.join(''));
for (const legacyKey of legacyKeys) {
  assert(!(legacyKey in manifest), `Legacy manifest key is still present: ${legacyKey}`);
}

function assertPatternShards(root) {
  const shardDir = join(root, 'patterns-input');
  assert(existsSync(shardDir), 'Expected patterns-input shard directory');
  const shardFiles = readdirSync(shardDir)
    .filter((file) => /^part-\d{4}\.json$/.test(file))
    .sort()
    .map((file) => `patterns-input/${file}`);
  assert(shardFiles.length > 0, 'Expected at least one pattern shard file');

  for (const shardFile of shardFiles) {
    const shard = JSON.parse(readFileSync(join(root, shardFile), 'utf8'));
    assert(Array.isArray(shard.templates), `${shardFile}: expected templates array`);
    assert(shard.templates.length > 0, `${shardFile}: expected at least one template`);
    assert(
      shard.templates.every((template) => Array.isArray(template.tablesTouched) && template.tablesTouched.length >= 2),
      `${shardFile}: expected only cross-table pattern candidates`,
    );
  }

  return shardFiles;
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
assert(Array.isArray(patterns.templates) && patterns.templates.length > 0, 'Expected patterns-input audit templates');
assert(
  patterns.templates.every((template) => Array.isArray(template.tablesTouched) && template.tablesTouched.length > 0),
  'Expected every audit pattern template to have touched tables',
);
const shardFiles = assertPatternShards(root);
assert(
  shardFiles.length <= patterns.templates.length,
  `Expected shard count ${shardFiles.length} to be no greater than audit template count ${patterns.templates.length}`,
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
assert(record.rawFileCount >= 4, `${label}: expected manifest, audit patterns input, pattern shard, and at least one table file`);
assert(Array.isArray(record.errors) && record.errors.length === 0, `${label}: expected no errors`);

if (expectedWorkUnits === 'zero') {
  assert(record.workUnitCount === 0, `${label}: expected zero WorkUnits, got ${record.workUnitCount}`);
  assert(Array.isArray(record.workUnits) && record.workUnits.length === 0, `${label}: expected empty workUnits`);
} else if (expectedWorkUnits === 'nonzero') {
  assert(record.workUnitCount > 0, `${label}: expected nonzero WorkUnits`);
  const patternUnits = record.workUnits.filter((unit) => /^historic-sql-patterns-part-\d{4}$/.test(unit.unitKey));
  assert(patternUnits.length > 0, `${label}: expected sharded patterns WorkUnit`);
  for (const unit of patternUnits) {
    assert(
      unit.rawFiles.some((rawFile) => /^patterns-input\/part-\d{4}\.json$/.test(rawFile)),
      `${label}: expected ${unit.unitKey} to read a pattern shard`,
    );
    assert(
      !unit.rawFiles.includes('patterns-input.json'),
      `${label}: expected ${unit.unitKey} not to schedule the full audit patterns input`,
    );
  }
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
