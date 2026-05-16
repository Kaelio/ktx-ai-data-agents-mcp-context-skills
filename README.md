<h1 align="center">
  <img src="assets/ktx-lockup.svg" alt="KTX" width="500" />
</h1>

<h1 align="center">
  The context layer for analytics agents
</h1>

<p align="center">by Kaelio</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kaelio/ktx"><img src="https://img.shields.io/npm/v/@kaelio/ktx?style=flat-square&color=f97316" alt="npm version" /></a>
  <a href="https://codecov.io/gh/Kaelio/ktx"><img src="https://codecov.io/gh/Kaelio/ktx/branch/main/graph/badge.svg" alt="Codecov" /></a>
  <a href="https://github.com/Kaelio/ktx/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License" /></a>
  <a href="https://github.com/Kaelio/ktx"><img src="https://img.shields.io/github/stars/Kaelio/ktx?style=flat-square" alt="GitHub stars" /></a>
</p>

---

KTX turns warehouse metadata, semantic definitions, and business knowledge into
reviewable project files that agents can use to plan, query, and update
analytics work.

Use KTX when you want agents to:

- Generate SQL from approved measures and joins
- Repair semantic definitions through reviewable diffs
- Explain metric provenance with warehouse evidence
- Work alongside dbt, MetricFlow, LookML, Looker, Metabase, and Notion

Supports PostgreSQL, Snowflake, BigQuery, ClickHouse, MySQL, SQL Server, and
SQLite.

## Quick Start

```bash
pnpm add --global @kaelio/ktx
ktx setup
ktx status
```

`ktx setup` creates or resumes a local KTX project, configures providers and
connections, builds context, and installs agent integration.

Example `ktx status` output after setup:

```text
KTX project: /home/user/analytics
Project ready: yes
LLM ready: yes (claude-sonnet-4-6)
Embeddings ready: yes (text-embedding-3-small)
Databases configured: yes (postgres-warehouse)
Context sources configured: yes (dbt-main)
KTX context built: yes
Agent integration ready: yes (codex:project)
```

## Common Commands

| Command | Purpose |
|---------|---------|
| `ktx setup` | Create, resume, or update a KTX project |
| `ktx status` | Check project readiness |
| `ktx connection list` | List configured connections |
| `ktx connection test <id>` | Test one connection |
| `ktx ingest <id>` | Build context for one connection |
| `ktx ingest --all` | Build context for every configured connection |
| `ktx ingest text <file>` | Capture free-form notes into memory |
| `ktx sl list` | List semantic-layer sources |
| `ktx sl search "revenue"` | Search semantic-layer sources |
| `ktx sl validate <source> --connection-id <id>` | Validate a semantic source |
| `ktx sl query --measure <measure> --format sql` | Compile semantic-layer SQL |
| `ktx wiki search "revenue definition"` | Search local wiki context |
| `ktx mcp start` | Start the local MCP server for agent clients |

Project resolution defaults to `KTX_PROJECT_DIR`, then the nearest `ktx.yaml`,
then the current directory. Pass `--project-dir <path>` when scripting.

## Project Layout

```text
my-project/
├── ktx.yaml                         # Project configuration
├── semantic-layer/<connection-id>/  # YAML semantic sources
├── wiki/global/                     # Shared business context
├── wiki/user/<user-id>/             # User-scoped notes
├── raw-sources/<connection-id>/     # Ingest artifacts and reports
└── .ktx/                            # Local state and secrets, git-ignored
```

Commit `ktx.yaml`, `semantic-layer/`, and `wiki/`. Keep `.ktx/` local.

## Agent Usage

Setup can install KTX instructions for Claude Code, Codex, Cursor, OpenCode,
and universal `.agents` clients:

```bash
ktx setup --agents --target codex
```

Agent-facing workflows typically start with:

```bash
ktx sl search "revenue" --json
ktx wiki search "refund policy" --json
ktx sl query --connection-id warehouse --measure orders.revenue --format sql
```

During agent setup, choose **MCP tools + analytics skill** for client agents.
Choose **MCP tools + analytics skill + admin CLI skill** only when a developer
or operator agent also needs pinned `ktx` admin commands.

The analytics skill teaches client agents the MCP workflow: discover data,
prefer semantic-layer measures, inspect entity details before raw SQL, and
capture durable learnings. Admin CLI skills call `ktx` commands directly
through a skill file installed in your agent's config:

```bash
ktx sl query --measure orders.revenue --dimension orders.status --format sql
ktx wiki search "revenue definition"
ktx sl validate orders
```

Supported client agents: Claude Code, Claude Desktop, Codex, Cursor, OpenCode,
and clients that can use the printed MCP endpoint or `.agents` admin skills.
Claude Desktop setup registers a local `ktx mcp stdio` server in Claude
Desktop's config and generates `.ktx/agents/claude/ktx-plugin.zip` with the
analytics skill.

The release artifact manifest contains the public npm tarball and the bundled
`kaelio-ktx` runtime wheel. The `python/ktx-sl` and `python/ktx-daemon`
directories remain source packages for development, not public release
artifacts.

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

Use the development CLI locally:

```bash
pnpm run setup:dev
pnpm run link:dev
ktx-dev --help
```

KTX is a pnpm + uv workspace:

- TypeScript packages live in `packages/*`
- CLI source lives in `packages/cli`
- Python runtime source lives in `python/ktx-sl` and `python/ktx-daemon`
- Public docs live in `docs-site/content/docs`

Useful checks:

```bash
pnpm run type-check
pnpm run test
pnpm run dead-code
uv run pytest -q
```

## Docs

- [Quickstart](docs-site/content/docs/getting-started/quickstart.mdx)
- [CLI Reference](docs-site/content/docs/cli-reference/index.mdx)
- [Building Context](docs-site/content/docs/guides/building-context.mdx)
- [Contributing](docs-site/content/docs/community/contributing.mdx)

## License

KTX is licensed under the Apache License, Version 2.0. See `LICENSE`.
