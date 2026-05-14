# Research Agent MCP Tools Design

**Date:** 2026-05-14
**Author:** Andrey Avtomonov
**Status:** Design — pending implementation plan

## Background

KTX positions itself as a standalone context layer for database agents.
External agents — Claude Code, Cursor, Codex, opencode — should be able to
connect to a local KTX instance via MCP and perform research against
configured data connections.

The existing MCP surface (`packages/context/src/mcp/context-tools.ts`) already
exposes strong **context** primitives: wiki search/read/write, semantic-layer
list/read/write/validate/query, ingest and scan run management, memory
capture. What it is missing is the **active investigation** primitives a
research agent needs:

- The agent cannot run raw SQL against a connection. `sl_query` only covers
  semantic-layer-defined queries.
- The agent cannot inspect raw table or column metadata for tables that are
  not yet modeled in the semantic layer.
- The agent cannot find which column holds a literal value mentioned by the
  user (e.g., "Acme Corp").
- The agent must call multiple separate search tools (`wiki_search`,
  `sl_list_sources`) and reconcile results manually instead of getting a
  unified ranked discovery view.

The Kaelio research agent (reference implementation at
`/Users/andrey/conductor/workspaces/kaelio-main2/douala/server/src/cores/research-execution.core.ts`)
addresses these gaps with tools named `sql_execution`, `entity_details`,
`dictionary_search`, and `discover_data`, used in a discovery → inspection →
query loop. The corresponding KTX infrastructure already exists in pieces:

- `KtxScanConnector.executeReadOnly` on every connector
  (`packages/connector-postgres/src/connector.ts:447` and siblings) — read-only
  SQL execution with `assertReadOnlySql` and `limitSqlForExecution`.
- `KtxSchemaSnapshot` from scan reports — full table/column/FK metadata.
- `SlDictionaryEntry` extraction over relationship-profiling artifacts
  (`packages/context/src/sl/sl-dictionary-profile.ts`).
- Hybrid search core with Reciprocal Rank Fusion
  (`packages/context/src/search/{hybrid-search-core,rrf}.ts`).

This design exposes those primitives as four new MCP tools, adds a research
skill to guide external agents, and introduces an HTTP-only `ktx mcp` daemon
to host the MCP server.

## Goals

- Expose four new MCP tools that turn KTX into a research-capable context
  layer for any MCP-compatible client: `discover_data`, `entity_details`,
  `dictionary_search`, `sql_execution`.
- Ship a `ktx-research` skill installable via `ktx setup-agents`, describing
  the discover → inspect → query → capture workflow for external agents.
- Provide a `ktx mcp` CLI subtree that runs the MCP server over HTTP on
  localhost, with the same lifecycle pattern as the existing managed Python
  daemon (`packages/cli/src/managed-python-daemon.ts`).
- Make `ktx setup-agents` write client-side MCP configuration entries for all
  configured targets (claude-code, codex, cursor, opencode), pointing at the
  local HTTP endpoint.
- Reuse existing infrastructure (connector `executeReadOnly`, schema
  snapshots, dictionary profile, hybrid search + RRF) rather than building
  parallel implementations.

## Non-goals

- This spec does not build an agent loop inside KTX. The system prompt, step
  budget, tool dispatch, and methodology tracking remain in the external
  client. KTX is a context provider, not an agent runner.
- This spec does not expose Python code execution. The `ktx-daemon`
  `/code/execute` endpoint exists but is not surfaced via MCP. That is a
  separate design with its own sandboxing and security considerations.
- This spec does not ship widget rendering, chart creation, or scheduled
  report execution. Those are presentation concerns the external client owns.
- This spec does not implement stdio MCP transport. HTTP-only.
- This spec does not implement OS-level auto-start (launchd, systemd user
  units). `ktx mcp start` must be run explicitly.
- This spec does not implement remote network exposure beyond loopback. Token
  auth and non-`127.0.0.1` binding are supported but TLS, audit logging, and
  multi-tenant isolation are out of scope for v1.

## Tool inventory

Four new MCP tools, registered in `packages/context/src/mcp/context-tools.ts`
alongside the existing tools.

### discover_data

Unified ranked search across wiki, semantic-layer sources/measures/dimensions,
and raw schema tables/columns. Returns refs only with a uniform shape; the
agent dereferences top hits using the existing `wiki_read`, `sl_read_source`,
or `entity_details` tools.

**Input schema:**

```typescript
{
  query: z.string().min(1),
  connectionId: z.string().optional(),         // omit → all connections
  kinds: z.array(z.enum([
    'wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column',
  ])).optional(),                              // omit → all kinds
  limit: z.number().int().min(1).max(50).default(15).optional(),
}
```

**Output:** array of refs, each:

```typescript
{
  kind: 'wiki' | 'sl_source' | 'sl_measure' | 'sl_dimension' | 'table' | 'column',
  id: string,                                  // wiki key, source name, or qualified table/column id
  score: number,                               // RRF fused score, 0-1 range
  summary: string,                             // one-line description
  snippet: string,                             // short context snippet, ≤200 chars
  connectionId?: string,                       // present for non-wiki kinds
}
```

**Implementation:** new module `packages/context/src/search/discover.ts`.
Composes three sub-searches in parallel:

1. Wiki search via the existing wiki search backend.
2. SL search over sources/measures/dimensions using existing
   `sl-sources-index` (or a new lightweight index if needed for measure
   granularity).
3. Raw schema search over tables and columns from `KtxSchemaSnapshot`,
   indexed at scan time and stored alongside other scan artifacts.

Results from each sub-search are fused with `packages/context/src/search/rrf.ts`
using equal weights. The `kinds` filter constrains which sub-searches run.

### entity_details

Read structured metadata for one or more raw tables (and optionally specific
columns) from the latest scan snapshot. The raw-data equivalent of
`sl_read_source`.

**Input schema:**

```typescript
{
  connectionId: z.string().min(1),
  entities: z.array(z.object({
    table: z.string().min(1),                  // qualified or unqualified
    columns: z.array(z.string()).optional(),   // omit → all columns
  })).min(1).max(20),
}
```

**Output:** for each entity, a structured record:

```typescript
{
  connectionId: string,
  table: string,                               // qualified (schema.name)
  kind: 'table' | 'view',
  comment: string | null,
  estimatedRows: number | null,
  columns: Array<{
    name: string,
    nativeType: string,
    normalizedType: string,
    nullable: boolean,
    primaryKey: boolean,
    comment: string | null,
  }>,
  foreignKeys: Array<{
    fromColumn: string,
    toTable: string,
    toColumn: string,
    constraintName: string | null,
  }>,
}
```

If `columns` is provided, only the requested columns appear in the `columns`
array (PKs and FKs still report on the full table).

**Implementation:** new module `packages/context/src/scan/entity-details.ts`.
Reads `KtxSchemaSnapshot` from the same store the existing `scan_*` tools
read. No new infrastructure. If the requested table is not in the latest
snapshot, the tool returns a structured error with a suggestion to run
`ktx ingest <connectionId>`.

### dictionary_search

Find which connection, source, and column hold a given literal value (or
substring) such as "Acme Corp" or "shipped". Backed by the existing
`SlDictionaryEntry` extraction over relationship-profiling artifacts.

**Input schema:**

```typescript
{
  values: z.array(z.string().min(1)).min(1).max(20),
  connectionId: z.string().optional(),         // omit → all connections
}
```

**Output:** for each input value, the list of matching entries:

```typescript
{
  results: Array<{
    value: string,                             // input value
    matches: Array<{
      connectionId: string,
      sourceName: string,
      columnName: string,
      matchedValue: string,                    // actual value found (may differ in case)
      cardinality: number | null,              // column cardinality if known
    }>,
  }>,
}
```

**Matching semantics:** case-insensitive substring match. Empty results when
the relationship-profiling artifact has no candidate columns for the
connection — the tool reports this distinctly from "value not found" so the
agent can suggest running `ktx ingest --deep`.

**Implementation:** new module `packages/context/src/sl/dictionary-search.ts`.
Loads `SlDictionaryEntry` records via the existing extraction code path,
builds a per-connection in-memory index on first call, caches it for the
lifetime of the MCP daemon. Invalidated on next ingest run (the daemon
watches `.ktx/db.sqlite` for changes, or simply re-reads on each call when
the artifact mtime advances).

### sql_execution

Execute a read-only SQL query against a configured connection and return the
result. The fallback path for questions the semantic layer does not cover.

**Input schema:**

```typescript
{
  connectionId: z.string().min(1),
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(10_000).default(1000).optional(),
}
```

**Output:**

```typescript
{
  headers: string[],
  headerTypes: string[],                       // driver-mapped type names
  rows: Array<Array<unknown>>,
  rowCount: number,
}
```

**Implementation:** delegates to `KtxScanConnector.executeReadOnly` on the
matching connector, which already enforces `assertReadOnlySql` (rejects any
DML/DDL via SQL parsing) and `limitSqlForExecution` (wraps the query in a
row cap). The tool does not add new enforcement layers; it surfaces the
existing one through MCP.

Errors from `assertReadOnlySql` are returned as structured tool errors so
the agent can correct the query and retry.

## Tool naming convention

Match the existing KTX MCP convention (no prefix): `discover_data`,
`entity_details`, `dictionary_search`, `sql_execution`. The existing tools
(`wiki_search`, `sl_list_sources`, `scan_trigger`, `memory_capture`) all use
unprefixed snake_case; the new tools follow suit.

## Connection model

- `sql_execution` and `entity_details` require `connectionId` — these tools
  cannot operate without a target.
- `discover_data` and `dictionary_search` make `connectionId` optional. Omit
  it to search across all configured connections; provide it to scope. This
  matches the existing pattern for `sl_list_sources({ connectionId? })`.
- All tools are project-locked: the MCP daemon runs in one KTX project dir;
  to operate on a different project, restart the daemon with a different
  `--project-dir` or `cwd`.

## MCP daemon: `ktx mcp`

A new CLI subtree in `packages/cli/src/commands/mcp-commands.ts`, wired into
`cli-program.ts` alongside `setup`, `connection`, `ingest`, `wiki`, `sl`,
`status`, `dev`.

### Commands

```bash
ktx mcp start [--port <n>] [--host <h>] [--token <t>] [--foreground]
ktx mcp stop
ktx mcp status
ktx mcp logs [--follow]
```

### `ktx mcp start`

Starts a long-lived HTTP MCP server bound to the configured host and port,
serving every tool registered by `createKtxMcpServer`. The server stays alive
until `ktx mcp stop` is invoked or the process is terminated.

- Default `--host` is `127.0.0.1`. Any value other than `127.0.0.1` or
  `localhost` **requires** `--token` (or `KTX_MCP_TOKEN` in the environment);
  the command refuses otherwise.
- Default `--port` is 7878. If the port is in use, the command exits with an
  error explaining how to choose another. Allocated port is persisted to
  `.ktx/mcp.json` for subsequent `status`, `stop`, `logs`, and
  `setup-agents` calls.
- `--foreground` runs the server in the foreground and pipes all logs to
  stdout, for debugging. Default is background.
- Background runs detach via the same pattern as the managed Python daemon
  (`packages/cli/src/managed-python-daemon.ts`): spawn a detached child,
  write `pid`, `port`, `startedAt` to `.ktx/mcp.json`, return immediately
  with the URL the user should configure in their client.
- Logs go to `.ktx/logs/mcp.log` (matches existing log layout).

### `ktx mcp stop`

Reads `.ktx/mcp.json` for the daemon PID, sends SIGTERM, waits up to 10
seconds for graceful exit, then SIGKILLs if still running. Removes the state
file on success.

### `ktx mcp status`

Reads `.ktx/mcp.json`, checks the process is alive, hits the server's
`/health` endpoint, and reports:

- Running / stopped / stale (state file present but process not alive)
- Port, host, started-at, pid
- Whether token auth is enabled
- Configured project dir

### `ktx mcp logs`

Tails or follows `.ktx/logs/mcp.log`. Standard `--follow` flag.

### Lifecycle

Manual: the user runs `ktx mcp start` after each reboot or whenever they
want the server running. No auto-start on other `ktx` commands (matches the
explicit pattern established by the daemon model).

### Transport

HTTP-only via `StreamableHTTPServerTransport` from
`@modelcontextprotocol/sdk/server/streamableHttp.js`. Endpoint: `POST /mcp`.

Health: `GET /health` returns `{ status: 'ok', projectDir, port }` for
liveness checks.

### Security model

- `127.0.0.1` binding is the default and requires no auth. Loopback only;
  cannot reach the server from another host.
- Non-loopback binding requires `--token <t>` or `KTX_MCP_TOKEN`. The server
  checks `Authorization: Bearer <t>` on every `/mcp` request and rejects
  with HTTP 401 otherwise.
- TLS is out of scope. For remote access, document running KTX behind a
  reverse proxy (Caddy, nginx) that terminates TLS.

## Client config installation via `ktx setup-agents`

`ktx setup-agents` extends its existing per-target file installation
(`plannedKtxAgentFiles` in `packages/cli/src/setup-agents.ts:64`) to also
write MCP server entries:

| Target | Scope | MCP config path |
|---|---|---|
| claude-code | global | `~/.claude.json` (`mcpServers.ktx`) |
| claude-code | project | `.mcp.json` (`mcpServers.ktx`) |
| cursor | global | `~/.cursor/mcp.json` (`mcpServers.ktx`) |
| cursor | project | `.cursor/mcp.json` (`mcpServers.ktx`) |
| codex | global / project | print instructions; do not auto-write |
| opencode | global / project | print instructions; do not auto-write |

For codex and opencode, the exact MCP config conventions are still evolving;
the command prints a copy-pasteable snippet rather than writing files. This
keeps `setup-agents` from silently producing invalid configs.

Entry shape (all writers):

```json
{
  "mcpServers": {
    "ktx": {
      "url": "http://localhost:7878/mcp"
    }
  }
}
```

Port is read from `.ktx/mcp.json` if present, falling back to 7878. The
install manifest (`agentInstallManifestPath`,
`packages/cli/src/setup-agents.ts:60`) tracks each `json-key` entry so
`ktx setup-agents --remove` can roll back cleanly.

If the daemon is not running when `setup-agents` runs, the command prints a
follow-up hint: "Run `ktx mcp start` to enable the configured KTX MCP
server." It does **not** auto-start the daemon (matches the manual
lifecycle decision).

## Research skill

A new skill source file at `packages/cli/src/skills/research/SKILL.md`,
installed by `ktx setup-agents` to all configured targets. The skill is
separate from the existing setup skill (different triggers: "work in a KTX
project" vs. "answer a data question") and lives in its own per-target
folder so global vs. project scope and removal stay clean.

`plannedKtxAgentFiles` in `packages/cli/src/setup-agents.ts:64` is extended
to return both the existing `ktx` entries and new `ktx-research` entries:

| Target | Scope | Path |
|---|---|---|
| claude-code | global | `~/.claude/skills/ktx-research/SKILL.md` |
| claude-code | project | `.claude/skills/ktx-research/SKILL.md` |
| codex | global | `${CODEX_HOME}/skills/ktx-research/SKILL.md` |
| codex | project | `.agents/skills/ktx-research/SKILL.md` |
| cursor | project | `.cursor/rules/ktx-research.mdc` |
| opencode | project | `.opencode/commands/ktx-research.md` |
| universal | project | `.agents/skills/ktx-research/SKILL.md` |

The skill body is identical across targets; only the wrapper format and
file path differ to match each target's convention.

### Skill content

```markdown
---
name: ktx-research
description: Use when answering a question that needs data from a KTX-connected database — investigating, analyzing, "how many", "show me", "what's the breakdown of", finding records by value, exploring tables, comparing periods, or any data-investigation request. Triggers even when the user does not say "research"; if the answer requires querying a configured KTX connection, this skill applies.
---

# KTX Research Workflow

You have access to KTX MCP tools for investigating data. Follow this workflow.

<workflow>
1. **Discover** — call `discover_data(query)` first to see what exists across wiki, semantic-layer sources, and raw tables. Returns refs only.
2. **Inspect top hits in parallel** — for each promising ref:
   - `kind: 'wiki'` → `wiki_read(key)`
   - `kind: 'sl_source'` / `'sl_measure'` / `'sl_dimension'` → `sl_read_source(connectionId, sourceName)`
   - `kind: 'table'` / `'column'` → `entity_details(connectionId, entities)`
3. **Resolve literals** — if the user named a value (e.g., "Acme Corp", "status=shipped"), call `dictionary_search(values)` to find which column holds it.
4. **Query** —
   - Prefer `sl_query` when the semantic layer covers the question (joins, measures pre-defined).
   - Use `sql_execution` only for things the semantic layer doesn't cover.
5. **Capture learnings** — at the end of the turn, call `memory_capture(userMessage, assistantMessage)` so future turns benefit. Skip when the answer carries no durable knowledge (e.g., the user only asked for schema info).
</workflow>

<rules>
- Always run `discover_data` before writing SQL. Do not guess table names.
- Prefer the semantic layer over raw SQL when both can answer the question — measures are the source of truth.
- Read entity details before writing SQL against an unfamiliar table; do not assume column names.
- Treat `sql_execution` as read-only. Writes are rejected by the server.
- Validate value mentions with `dictionary_search` instead of guessing case/spelling.
</rules>

<examples>
**Input:** "How many orders did Acme Corp place last month?"

**Output workflow:**
1. `dictionary_search(["Acme Corp"])` → finds `customers.name`
2. `discover_data("orders customer monthly")` → finds `orders_facts` SL source
3. `sl_read_source("warehouse", "orders_facts")` → confirms measure `order_count`, dim `customer_name`, dim `ordered_at`
4. `sl_query({ measures: ["order_count"], filters: ["customer_name = 'Acme Corp'", "ordered_at >= date_trunc('month', now() - interval '1 month')"], dimensions: [{ field: "ordered_at", granularity: "month" }] })`
5. `memory_capture(userMessage, assistantMessage)`

---

**Input:** "What columns does the events table have?"

**Output workflow:**
1. `discover_data("events table")` → top hit `kind: 'table', id: 'analytics.events'`
2. `entity_details("warehouse", [{ table: "analytics.events" }])` → returns columns, types, FKs
3. Answer directly. (No query needed; no `memory_capture` since no durable learning.)
</examples>
```

## Files

### New

- `packages/context/src/scan/entity-details.ts` — derives entity-detail
  records from `KtxSchemaSnapshot`.
- `packages/context/src/sl/dictionary-search.ts` — builds and queries the
  dictionary index over relationship-profiling artifacts.
- `packages/context/src/search/discover.ts` — composes wiki, SL, and raw
  schema searches; fuses results via `rrf.ts`.
- `packages/cli/src/commands/mcp-commands.ts` — `ktx mcp start|stop|status|logs`.
- `packages/cli/src/managed-mcp-daemon.ts` — daemon lifecycle (spawn,
  pidfile, log management), mirroring `managed-python-daemon.ts`.
- `packages/cli/src/skills/research/SKILL.md` — research workflow skill.
- Tests for each new module following existing patterns
  (`*.test.ts` siblings).

### Modified

- `packages/context/src/mcp/context-tools.ts` — register the four new tools
  with their Zod schemas.
- `packages/context/src/mcp/server.ts` — extend `KtxMcpContextPorts` with the
  new ports (`sqlExecution`, `entityDetails`, `dictionarySearch`, `discover`).
- `packages/context/src/mcp/types.ts` — add the new port interface
  definitions.
- `packages/cli/src/cli-program.ts` — register the `mcp` command subtree.
- `packages/cli/src/setup-agents.ts` — install the research skill and write
  MCP client config entries to each configured target.

## Testing strategy

- Unit tests for each new module (`entity-details.ts`,
  `dictionary-search.ts`, `discover.ts`) using existing fixture patterns.
- MCP-level integration test in `packages/context/src/mcp/server.test.ts`
  that registers a fake server, invokes each tool, and asserts the
  responses.
- CLI integration test for `ktx mcp start|stop|status` lifecycle following
  the pattern in `managed-python-daemon.test.ts`.
- Setup-agents test verifying the MCP client config entries are written for
  each target.
- Verification commands per CLAUDE.md: `pnpm --filter @ktx/context run test`
  and `pnpm --filter @ktx/cli run test` for the affected packages, plus
  `pnpm run type-check`.

## Out of scope / follow-ups

- **Python code execution via MCP.** The daemon's `/code/execute` endpoint
  exists; surfacing it via MCP is a separate design with sandbox/security
  considerations.
- **Stdio MCP transport.** HTTP-only for now. Stdio can be added later as an
  additional transport mode without changing the tool surface.
- **OS-level auto-start.** Manual `ktx mcp start` only. Adding launchd /
  systemd unit installation is a UX polish for a later release.
- **TLS in the daemon itself.** Reverse proxy is the documented path. Native
  TLS support if/when demand emerges.
- **Multi-project / project-switching MCP.** One daemon per project. A
  cross-project model would require per-call `projectDir` arguments or a
  `set_project_dir` tool and is deferred.
- **Audit logging, rate limiting, per-tool authorization.** Not in scope for
  v1; the security boundary is loopback or bearer token.

## Open trade-offs

- **`dictionary_search` requires `--deep` (enriched) scan to have run.** The
  relationship-profiling artifact that powers the dictionary index is only
  produced by enriched scans. The tool reports this distinctly when missing,
  but the dependency is real: without enriched scan, the tool returns
  empty.
- **`entity_details` reads from the latest snapshot, not live.** If the
  database schema changes after the last scan, the tool will reflect the
  scan state, not reality. Surfacing this clearly in the tool's response
  (snapshot timestamp) is part of the implementation.
- **No streaming for `sql_execution`.** Large results are capped at
  `maxRows` (default 1000, max 10k). The tool returns the full result set
  in one response. Streaming partial results is left for a later iteration
  if real workloads demand it.
