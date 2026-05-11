# KTX

KTX is a workspace-first context layer for database agents. It stores warehouse
memory in a project directory, generates and validates semantic-layer YAML,
indexes knowledge, scans database schemas, and exposes the result through a CLI
and MCP server.

KTX projects are plain files: YAML, Markdown, SQLite state, and generated
artifacts. You can inspect them, commit them, and serve them to any MCP client.

## What KTX provides

- Durable warehouse memory with semantic-layer sources and knowledge pages.
- Native scan connectors for SQLite, Postgres, MySQL, ClickHouse, SQL Server,
  BigQuery, and Snowflake.
- Agentic ingest with provenance links, tool transcripts, and replay metadata.
- Local semantic-layer query planning and optional query execution.
- A stdio MCP server with tools for connections, knowledge, semantic-layer
  sources, ingest reports, and replay.

## Quick start

Run the pre-seeded demo from the repository root:

```bash
pnpm install
pnpm run setup:dev
pnpm run ktx -- setup demo --no-input
pnpm run ktx -- setup demo inspect
```

The default demo uses packaged sample data and prebuilt context. It does not
require API keys, network access, or an LLM provider.

To replay the packaged ingest run, use:

```bash
pnpm run ktx -- setup demo --mode replay --no-input
```

To run the full agentic demo with an LLM provider, set a provider key for the
current process:

```bash
ANTHROPIC_API_KEY=$YOUR_ANTHROPIC_API_KEY \
  pnpm run ktx -- setup demo --mode full --no-input
```

Interactive full-demo setup can prompt for a provider key without writing the
key to `ktx.yaml`.

## Build a local project

Create a project from the repository root:

```bash
uv sync --all-packages
source .venv/bin/activate

PROJECT_DIR="$(mktemp -d)/ktx-demo"
pnpm run ktx -- init "$PROJECT_DIR" --name ktx-demo
```

Create a SQLite warehouse:

```bash
python - "$PROJECT_DIR/demo.db" <<'PY'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
conn.executescript("""
DROP TABLE IF EXISTS accounts;
CREATE TABLE accounts (
  account_id INTEGER PRIMARY KEY,
  account_name TEXT NOT NULL,
  segment TEXT NOT NULL,
  region TEXT NOT NULL
);
INSERT INTO accounts VALUES
  (1, 'Acme Analytics', 'Mid-Market', 'NA'),
  (2, 'Beacon Bank', 'Enterprise', 'EMEA'),
  (3, 'Cobalt Coffee', 'SMB', 'NA'),
  (4, 'Delta Devices', 'Mid-Market', 'APAC'),
  (5, 'Evergreen Energy', 'Enterprise', 'NA');
""")
conn.close()
PY
```

Replace the generated `ktx.yaml`:

```bash
cat > "$PROJECT_DIR/ktx.yaml" <<YAML
project: ktx-demo
connections:
  warehouse:
    driver: sqlite
    path: $PROJECT_DIR/demo.db
    readonly: true
storage:
  state: sqlite
  search: sqlite-fts5
  git:
    auto_commit: true
    author: "ktx <ktx@example.com>"
memory:
  auto_commit: true
YAML
```

Write and validate a semantic-layer source:

```bash
pnpm run ktx -- sl write accounts --project-dir "$PROJECT_DIR" \
  --connection-id warehouse --yaml 'name: accounts
table: accounts
description: CRM accounts with segmentation attributes.
grain:
  - account_id
columns:
  - name: account_id
    type: number
  - name: account_name
    type: string
  - name: segment
    type: string
  - name: region
    type: string
measures:
  - name: account_count
    expr: count(account_id)
joins: []
'

pnpm run ktx -- sl validate accounts --project-dir "$PROJECT_DIR" \
  --connection-id warehouse
```

Generate SQL and execute the query:

```bash
pnpm run ktx -- sl query --project-dir "$PROJECT_DIR" \
  --connection-id warehouse \
  --measure accounts.account_count \
  --dimension accounts.segment \
  --order-by accounts.account_count:desc \
  --limit 5 \
  --format sql

pnpm run ktx -- sl query --project-dir "$PROJECT_DIR" \
  --connection-id warehouse \
  --measure accounts.account_count \
  --dimension accounts.segment \
  --order-by accounts.account_count:desc \
  --limit 5 \
  --execute \
  --max-rows 5
```

List and test the warehouse connection:

```bash
pnpm run ktx -- connection list --project-dir "$PROJECT_DIR"
pnpm run ktx -- connection test warehouse --project-dir "$PROJECT_DIR"
```

The connection test prints the configured driver and discovered table count:

```text
Driver: sqlite
Tables: 1
```

### Scan the demo warehouse

Scan artifacts are written under
`raw-sources/warehouse/live-database/<syncId>/` in the project directory.

```bash

SCAN_OUTPUT="$(pnpm run ktx -- scan warehouse --project-dir "$PROJECT_DIR")"
printf '%s\n' "$SCAN_OUTPUT"
SCAN_RUN_ID="$(printf '%s\n' "$SCAN_OUTPUT" | awk '/^Run: / { print $2 }')"
pnpm run ktx -- scan status --project-dir "$PROJECT_DIR" "$SCAN_RUN_ID"
pnpm run ktx -- scan report --project-dir "$PROJECT_DIR" "$SCAN_RUN_ID"
```

For non-SQLite drivers, prefer credential references such as `--url env:NAME`
or `--url file:PATH` over literal credential URLs.

## Serve MCP

Start the Python compute daemon in one terminal:

```bash
source .venv/bin/activate
uv run ktx-daemon serve-http --host 127.0.0.1 --port 8765
```

Start the stdio MCP server in another terminal:

```bash
pnpm run ktx -- serve --mcp stdio --project-dir "$PROJECT_DIR" \
  --user-id local \
  --semantic-compute-url http://127.0.0.1:8765 \
  --execute-queries
```

The MCP server exposes `connection_list`, `knowledge_search`,
`knowledge_read`, `knowledge_write`, `sl_list_sources`, `sl_read_source`,
`sl_write_source`, `sl_validate`, `sl_query`, `ingest_trigger`,
`ingest_status`, `ingest_report`, and `ingest_replay`.

## Workspace packages

- `packages/context`: core TypeScript context library.
- `packages/cli`: CLI wrapper over the context package.
- `packages/llm`: LLM and embedding provider helpers.
- `packages/connector-bigquery`: BigQuery scan connector.
- `packages/connector-clickhouse`: ClickHouse scan connector.
- `packages/connector-mysql`: MySQL scan connector.
- `packages/connector-postgres`: Postgres scan connector.
- `packages/connector-snowflake`: Snowflake scan connector.
- `packages/connector-sqlite`: SQLite scan connector.
- `packages/connector-sqlserver`: SQL Server scan connector.
- `python/ktx-sl`: semantic-layer engine.
- `python/ktx-daemon`: portable compute service for semantic-layer operations.

## Development

Install dependencies and run checks:

```bash
pnpm install
pnpm run check
uv sync --all-packages
source .venv/bin/activate
uv run pytest
```

Use the optional development binary when you want a local `ktx-dev` command:

```bash
pnpm run link:dev
ktx-dev --help
```

The repository uses `pnpm` for TypeScript packages and `uv` for Python
packages.

## Release status

This repository is prepared for source publication. Package publishing is still
disabled by `release-policy.json`; registry names, public versions, package
visibility, and provenance policy must be chosen before publishing artifacts to
npm or Python package indexes.

Build local package artifacts with:

```bash
source .venv/bin/activate
pnpm run artifacts:check
pnpm run release:readiness
```

## License

KTX is licensed under the Apache License, Version 2.0. See `LICENSE`.
