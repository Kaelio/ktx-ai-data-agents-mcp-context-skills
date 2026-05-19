<h1 align="center">
  <img src="assets/ktx-lockup.svg" alt="KTX" width="500" />
</h1>

<h1 align="center">
  The context layer for analytics agents
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@kaelio/ktx"><img src="https://img.shields.io/npm/v/@kaelio/ktx?style=flat-square&color=f97316" alt="npm version" /></a>
  <a href="https://codecov.io/gh/Kaelio/ktx"><img src="https://codecov.io/gh/Kaelio/ktx/graph/badge.svg?branch=main" alt="Codecov" /></a>
  <a href="https://github.com/Kaelio/ktx/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/Kaelio/ktx/ci.yml?branch=main&label=tests&style=flat-square" alt="Tests" /></a>
  <a href="https://docs.kaelio.com/ktx/docs/"><img src="https://img.shields.io/badge/docs-KTX-22c55e?style=flat-square" alt="Documentation" /></a>
  <a href="https://join.slack.com/t/ktxcommunity/shared_invite/zt-3y9b44m1x-LVyNNJD5nwaZHq4XS29LMQ"><img src="https://img.shields.io/badge/slack-join%20community-4A154B?style=flat-square&logo=slack&logoColor=white" alt="Join the KTX Slack community" /></a>
  <a href="https://github.com/Kaelio/ktx/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License" /></a>
</p>

---

KTX is a self-improving context layer that teaches agents how to query your
warehouse accurately - from approved metric definitions, joinable columns, and
business knowledge it builds and maintains for you.

Works with PostgreSQL, Snowflake, BigQuery, ClickHouse, MySQL, SQL Server, and
SQLite. Integrates with dbt, MetricFlow, LookML, Looker, Metabase, and Notion.

## Why KTX

General-purpose agents struggle on data tasks. They re-explore your warehouse
on every question, invent their own metric logic, and return numbers that
don't match approved definitions.

Traditional semantic layers don't fix this. They demand constant manual
upkeep and don't absorb the rest of your company's knowledge.

KTX does both, automatically:

- **Learns from company knowledge.** Ingests wiki content, organizes it,
  removes duplicates, and flags contradictions for human review.
- **Maps the data stack.** Samples tables, captures metadata and usage
  patterns, detects joinable columns, and annotates sources so agents write
  better queries.
- **Builds a semantic layer.** Combines raw tables and high-level metrics
  through a join graph that automatically resolves chasm and fan traps, so
  agents fetch metrics declaratively instead of rewriting canonical SQL each
  time.
- **Serves agents at execution.** Exposes CLI and MCP tools with combined
  full-text and semantic search across wiki and semantic-layer entities.

Agents can run raw SQL when they need it, or compose semantic-layer queries
when they want approved metrics with reliable joins.

<p align="center">
  <img src="docs-site/public/images/ingestion-flow-transparent.svg" alt="KTX ingestion flow from source systems through validation to wiki and semantic-layer outputs" width="900" />
</p>

## Agent Setup

Ask an agent such as Claude Code, Codex, Cursor, or OpenCode to install and
configure KTX from your project directory:

```text
Follow instructions from
https://docs.kaelio.com/ktx/docs/agents-setup.md
to install and configure ktx
```

## Quick Start

```bash
npm install -g @kaelio/ktx
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
Databases configured: yes (warehouse)
Context sources configured: yes (dbt_main)
KTX context built: yes
Agent integration ready: yes (codex:project)
```

## Common Commands

| Command | Purpose |
|---------|---------|
| `ktx setup` | Create, resume, or update a KTX project |
| `ktx status` | Check project readiness |
| `ktx connection` | List configured connections |
| `ktx connection test` | Test every configured connection |
| `ktx connection test <id>` | Test one connection |
| `ktx ingest` | Build context for every configured connection |
| `ktx ingest <id>` | Build context for one connection |
| `ktx ingest --text "..."` | Capture free-form notes into memory |
| `ktx ingest --file notes.md --connection-id <id>` | Capture a text file into memory |
| `ktx sl` | List semantic-layer sources |
| `ktx sl "revenue"` | Search semantic-layer sources |
| `ktx sl validate <source> --connection-id <id>` | Validate a semantic source |
| `ktx sl query --measure <measure> --format sql` | Compile semantic-layer SQL |
| `ktx sql --connection <id> "select 1"` | Execute read-only SQL |
| `ktx wiki` | List local wiki pages |
| `ktx wiki "revenue definition"` | Search local wiki context |
| `ktx mcp` | Show MCP daemon status |
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

Install KTX integration for Claude Code, Claude Desktop, Codex, Cursor,
OpenCode, and generic `.agents` clients:

```bash
ktx setup --agents
```

Pass `--target <target>` to install or repair one specific integration.

A typical agent workflow combines wiki and semantic-layer search before
querying:

```bash
ktx sl "revenue" --json
ktx wiki "refund policy" --json
ktx sl query --connection-id warehouse --measure orders.revenue --format sql
```

During setup, choose **Ask data questions with KTX MCP** for client agents.
Choose **Ask data questions + manage KTX with CLI commands** when an operator
agent also needs pinned `ktx` admin commands.

After setup, KTX prints **Required before using agents** with the exact
commands to run. If the output includes `ktx mcp start --project-dir ...`, run
it before opening your agent. Claude Desktop uses its own launcher and prints
separate skill upload steps under `.ktx/agents/claude/`.

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
- [CLI Reference](docs-site/content/docs/cli-reference/ktx.mdx)
- [Building Context](docs-site/content/docs/guides/building-context.mdx)
- [Community & Support](docs-site/content/docs/community/support.mdx)
- [Contributing](docs-site/content/docs/community/contributing.mdx)

## Community

- **[Slack](https://join.slack.com/t/ktxcommunity/shared_invite/zt-3y9b44m1x-LVyNNJD5nwaZHq4XS29LMQ)** — ask questions, share what you're building, and chat with maintainers and other users.
- **[GitHub Issues](https://github.com/Kaelio/ktx/issues)** — report bugs and request features.
- **[Contributing guide](docs-site/content/docs/community/contributing.mdx)** — set up the repo, run tests, and open a PR.

See [Community & Support](docs-site/content/docs/community/support.mdx) for the
full guide on where to ask what.

## License

KTX is licensed under the Apache License, Version 2.0. See `LICENSE`.
