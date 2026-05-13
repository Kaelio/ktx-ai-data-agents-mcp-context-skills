<h1 align="center">
  <img src="assets/ktx-lockup.svg" alt="KTX" width="500" />
</h1>

<p align="center">
  <strong>The context layer for analytics agents</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kaelio/ktx"><img src="https://img.shields.io/npm/v/@kaelio/ktx?style=flat-square&color=f97316" alt="npm version" /></a>
  <a href="https://github.com/Kaelio/ktx/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License" /></a>
  <a href="https://github.com/Kaelio/ktx"><img src="https://img.shields.io/github/stars/Kaelio/ktx?style=flat-square" alt="GitHub stars" /></a>
</p>

---

KTX turns warehouse metadata, semantic definitions, and business knowledge into
reviewable project files that agents can use while planning, querying, and
updating analytics work.

A KTX project is a directory of plain files — YAML semantic sources, Markdown
wiki pages, and SQLite state — that you commit to git and review in PRs,
just like dbt models.

## Who KTX is for

KTX is built for analytics engineers and data teams who want data agents to
work on real analytics systems — not just generate one-off SQL.

Use KTX when you want agents to:

- **Generate SQL** from approved measures and joins
- **Repair semantic definitions** through reviewable diffs
- **Explain metric provenance** with warehouse evidence
- **Work alongside** dbt, LookML, MetricFlow, Looker, Metabase, and modern BI
  platforms

Works with PostgreSQL, Snowflake, BigQuery, ClickHouse, MySQL, SQL Server, and
SQLite.

## Quick start

Install the CLI and run the setup wizard:

```bash
npm install @kaelio/ktx
npm install -g @kaelio/ktx
ktx setup
```

The wizard walks through six steps: configuring your LLM provider, setting up
embeddings, connecting your database, adding context sources (dbt, LookML,
Metabase, Looker, Notion), building context, and installing agent integration.

If it exits before completion, rerun `ktx setup` to resume where you left off.

Check your project status:

```bash
ktx status
```

```
KTX project: /home/user/analytics
Project ready: yes
LLM ready: yes (claude-sonnet-4-6)
Embeddings ready: yes (text-embedding-3-small)
Primary sources configured: yes (postgres-warehouse)
Context sources configured: yes (dbt-main)
KTX context built: yes
Agent integration ready: yes (claude-code:project)
```

Generate SQL from a semantic-layer source:

```bash
npx @kaelio/ktx sl query --project-dir "$PROJECT_DIR" \
  --connection-id warehouse \
  --measure accounts.account_count \
  --dimension accounts.segment \
  --format sql
```

List and test a configured warehouse connection:

```bash
ktx connection list --project-dir "$PROJECT_DIR"
ktx connection test warehouse --project-dir "$PROJECT_DIR"
```

The connection test prints the configured driver and discovered table count:

```text
Driver: sqlite
Tables: 1
```

## What's in a project

```
my-project/
├── ktx.yaml                     # Project configuration
├── semantic-layer/
│   └── warehouse/
│       ├── orders.yaml           # Semantic source definitions
│       ├── customers.yaml
│       └── order_items.yaml
├── wiki/
│   ├── global/
│   │   ├── revenue.md            # Business definitions and rules
│   │   └── segment-classification.md
│   └── user/
│       └── local/
├── raw-sources/
│   └── warehouse/
│       └── <syncId>/             # Database ingest artifacts and reports
└── .ktx/
    └── db.sqlite                 # Local state (git-ignored)
```

Semantic sources and wiki pages are committed to git. The `.ktx/` directory
holds ephemeral state and is git-ignored — delete it and KTX rebuilds on the
next run.

### Build demo warehouse context

Database ingest artifacts are written under `raw-sources/warehouse/<syncId>/`
in the project directory.

```bash
ktx ingest warehouse --project-dir "$PROJECT_DIR" --fast
ktx status --project-dir "$PROJECT_DIR"
```

For non-SQLite drivers, prefer credential references such as `--url env:NAME`
or `--url file:PATH` over literal credential URLs.

## Managed Python runtime

KTX installs its Python runtime only when a Python-backed command needs it.
The runtime lives outside the npm cache, is versioned by the installed CLI
version, and is managed by `ktx dev runtime` commands.

KTX requires `uv` on `PATH` to create the managed runtime. Install `uv` with
your system package manager or the official installer before running Python-
backed KTX commands. KTX doesn't download `uv` automatically; run
`ktx dev runtime status` if runtime installation fails:

```bash
ktx dev runtime install --yes
ktx dev runtime status
ktx dev runtime start
ktx dev runtime stop
```

The release artifact manifest contains the public npm tarball and the bundled `kaelio-ktx`
runtime wheel. The `python/ktx-sl` and `python/ktx-daemon` directories remain
source packages for development, not public release artifacts.

## Use KTX with agents

KTX integrates with coding agents through CLI skills. The setup wizard
configures this automatically.

**CLI skills** — the agent calls `ktx` commands directly through a skill file
installed in your agent's config (e.g., `.claude/skills/ktx/SKILL.md`):

```bash
ktx sl query --measure orders.revenue --dimension orders.status --format sql
ktx wiki search "revenue definition"
ktx sl validate orders
```

Supported agents: Claude Code, Codex, Cursor, OpenCode, and any agent that
reads `.agents/` skills.

## Workspace packages

| Package | Purpose |
|---------|---------|
| `packages/cli` | CLI entry point |
| `packages/context` | Core context engine |
| `packages/llm` | LLM and embedding providers |
| `packages/connector-bigquery` | BigQuery scan connector |
| `packages/connector-clickhouse` | ClickHouse scan connector |
| `packages/connector-mysql` | MySQL scan connector |
| `packages/connector-postgres` | Postgres scan connector |
| `packages/connector-snowflake` | Snowflake scan connector |
| `packages/connector-sqlite` | SQLite scan connector |
| `packages/connector-sqlserver` | SQL Server scan connector |
| `python/ktx-sl` | Semantic-layer query planning |
| `python/ktx-daemon` | Portable compute service |

## Development

```bash
git clone https://github.com/kaelio/ktx.git
cd ktx
pnpm install
uv sync --all-groups
pnpm run build
pnpm run check
```

Use the development CLI for local testing:

```bash
pnpm run setup:dev
pnpm run link:dev
ktx-dev --help
```

### Debug LLM traces

KTX can capture local AI SDK DevTools traces for LLM calls that run through the
KTX provider. Enable it with an environment flag when running an LLM-backed
command:

```bash
KTX_AI_DEVTOOLS_ENABLED=true ktx ingest warehouse --project-dir "$PROJECT_DIR" --deep
```

Traces are written to `.devtools/generations.json` under the current working
directory. To inspect them, run:

```bash
pnpm dlx @ai-sdk/devtools
```

Then open `http://localhost:4983`. These traces are local-development-only and
store prompts, model outputs, tool arguments/results, and raw provider payloads
in plain text. Do not enable this in production or for sensitive runs.

The repository uses `pnpm` for TypeScript packages and `uv` for Python
packages. See [Contributing](docs-site/content/docs/community/contributing.mdx)
for full development setup, testing, and PR guidelines.

## License

KTX is licensed under the Apache License, Version 2.0. See `LICENSE`.
