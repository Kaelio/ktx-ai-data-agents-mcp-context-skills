#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KTX_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
COMPOSE_FILE="$EXAMPLE_DIR/docker-compose.yml"
PROJECT_PARENT="${KTX_POSTGRES_HISTORIC_PROJECT_PARENT:-$(mktemp -d)}"
PROJECT_DIR="$PROJECT_PARENT/postgres-historic-ktx"
KTX_BIN="$KTX_ROOT/packages/cli/dist/bin.js"
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

assert_manifest() {
  local manifest_path="$1"
  local expected_first_run="$2"
  node - "$manifest_path" "$expected_first_run" <<'NODE'
const { readFileSync } = require('node:fs');
const manifestPath = process.argv[2];
const expectedFirstRun = process.argv[3] === 'true';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.dialect !== 'postgres') throw new Error(`Expected dialect postgres, got ${manifest.dialect}`);
if (manifest.degraded !== true) throw new Error('Expected degraded:true for Postgres PGSS v1');
if (manifest.baselineFirstRun !== expectedFirstRun) {
  throw new Error(`Expected baselineFirstRun:${expectedFirstRun}, got ${manifest.baselineFirstRun}`);
}
if (!manifest.pgServerVersion) throw new Error('Expected pgServerVersion');
if (!manifest.statsResetAt) throw new Error('Expected statsResetAt');
if (!Array.isArray(manifest.templates) || manifest.templates.length === 0) {
  throw new Error('Expected at least one staged historic-SQL template');
}
NODE
}

run_historic_stage_only() {
  local job_id="$1"
  node - "$KTX_ROOT" "$PROJECT_DIR" "$job_id" <<'NODE'
const { join } = await import('node:path');

const ktxRoot = process.argv[2];
const projectDir = process.argv[3];
const jobId = process.argv[4];
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
await adapter.onPullSucceeded?.({
  connectionId: 'warehouse',
  sourceKey: 'historic-sql',
  syncId: record.syncId,
  trigger: 'manual_resync',
  completedAt: new Date(record.completedAt),
  stagedDir: join(project.projectDir, '.ktx/cache/local-ingest', jobId, 'staged'),
});
console.log(record.syncId);
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
  --historic-sql-min-calls 2 \
  --yes \
  --no-input

run_historic_stage_only "historic-first-$$"
FIRST_MANIFEST="$(latest_manifest)"
assert_manifest "$FIRST_MANIFEST" true

"$EXAMPLE_DIR/scripts/generate-workload.sh" extra
run_historic_stage_only "historic-second-$$"
SECOND_MANIFEST="$(latest_manifest)"
assert_manifest "$SECOND_MANIFEST" false

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U postgres -d analytics -v ON_ERROR_STOP=1 -c "SELECT pg_stat_statements_reset();" >/dev/null
"$EXAMPLE_DIR/scripts/generate-workload.sh" extra
run_historic_stage_only "historic-reset-$$"
RESET_MANIFEST="$(latest_manifest)"
assert_manifest "$RESET_MANIFEST" true

echo "Postgres historic SQL smoke passed"
echo "Project dir: $PROJECT_DIR"
