# Postgres Historic SQL Example

This example is a manual smoke for the redesigned Postgres historic-SQL ingest
path through `pg_stat_statements`. It starts Postgres 14 with the extension
preloaded, generates query workload under separate users, runs `ktx setup` with
`--enable-historic-sql`, and verifies the unified staged artifacts:

- `manifest.json`
- `tables/*.json`
- `patterns-input.json` as the full audit input
- `patterns-input/part-*.json` as bounded pattern WorkUnit shards

The smoke also runs the same workload twice and verifies the second stage-only
run has `workUnitCount: 0`, which proves unchanged bucketed table inputs and
unchanged bounded pattern shards do not schedule LLM work.

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
contain `patterns-input.json`, at least one `patterns-input/part-*.json` pattern
shard for cross-table candidates, and one `tables/*.json` file per touched
table.

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
