# ktx examples

## local-warehouse

`local-warehouse/` is a runnable standalone KTX project for local CLI and MCP
smoke testing. It uses the fake ingest adapter and does not require a database
or external app server.

Copy it before running commands:

```bash
pnpm --filter @ktx/cli run build
EXAMPLE_DIR="$(mktemp -d)/local-warehouse"
cp -R examples/local-warehouse "$EXAMPLE_DIR"
node packages/cli/dist/bin.js knowledge list --project-dir "$EXAMPLE_DIR"
node packages/cli/dist/bin.js sl list --project-dir "$EXAMPLE_DIR" --connection-id warehouse
node packages/cli/dist/bin.js ingest run --project-dir "$EXAMPLE_DIR" --connection-id warehouse --adapter fake --source-dir "$EXAMPLE_DIR/source"
```

The copied project initializes its own Git repository on first use.

## orbit-relationship-verification

`orbit-relationship-verification/` is a checked-in KTX project used by
`pnpm run relationships:verify-orbit`. It points the `orbit` SQLite connection
at the Orbit-style no-declared-constraint relationship fixture and verifies that
relationship enrichment writes nine accepted joins without requiring a local
warehouse credential.

## postgres-historic

`postgres-historic/` is a manual Docker-backed smoke for Postgres historic-SQL
ingest via `pg_stat_statements`. It verifies setup, unified Historic SQL artifacts,
managed daemon batch SQL analysis, bounded pattern WorkUnit shards, and
no-WorkUnit idempotency for unchanged bucketed table inputs and pattern shards.

## package-artifacts

`package-artifacts/` documents the artifact smoke checks. Those checks create
temporary projects instead of storing sample projects in this directory.
