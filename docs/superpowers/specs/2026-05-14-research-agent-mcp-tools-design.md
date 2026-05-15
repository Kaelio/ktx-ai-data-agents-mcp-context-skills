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
- Make `ktx setup-agents` install MCP client configuration for the configured
  targets pointing at the local HTTP endpoint. v1 splits this by client: for
  claude-code and cursor (JSON config), `setup-agents` writes the entry
  directly; for codex (TOML) and opencode (different JSON wrapper),
  `setup-agents` prints a copy-pasteable snippet rather than writing the file.
  See the client matrix below for full per-target behavior.
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

### Relationship to existing warehouse-verification tools

KTX already ships ingest-side implementations of `sql_execution`,
`entity_details`, and `discover_data` at
`packages/context/src/ingest/tools/warehouse-verification/{sql-execution,entity-details,discover-data}.tool.ts`,
backed by `warehouse-catalog.service.ts`. Their contracts differ from the
MCP shapes proposed below in three concrete ways:

- They currently take `connectionName` (slug-shaped); this spec renames
  them to `connectionId` in the same change (see below).
- They take `targets` (a discriminated `display` vs. `{catalog,db,name}`
  union) and `rowLimit`, not `entities` / `maxRows`.
- They return `{ markdown, structured }` with scan availability, candidate
  matches, and ingest-session-allowed-connection scoping, not the
  MCP-shaped pure-structured outputs in this spec.

To avoid two divergent contracts for the same primitives, the MCP tools
**must be implemented by extracting the shared logic out of
`warehouse-verification/*` and into reusable services**
(e.g., `WarehouseCatalogService` as the source of truth for table/column
resolution and discovery, plus a shared read-only SQL executor that wraps
`assertReadOnlySql`/`limitSqlForExecution`). The ingest tools and the new
MCP tools then become thin adapters around those services with their own
input/output shapes appropriate to each surface.

KTX has no public users yet, so the same change that introduces the MCP
tools renames the ingest-side `connectionName` parameter to `connectionId`
across `warehouse-verification/*.tool.ts`, `warehouse-catalog.service.ts`,
and any callers. `connectionId` matches the rest of the in-process MCP
surface (`sl_query`, `sl_list_sources`, `scan_trigger`, etc.) and the new
MCP tool inputs. The ingest tools and the new MCP tools then share both
the service layer and the parameter name; only their input/output shapes
differ (markdown+structured for the ingest surface, pure structured for
the MCP surface).

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
  id: string,                                  // stable id: wiki key, source name, or driver-qualified table/column display string
  score: number,                               // RRF fused score, 0-1 range
  summary: string | null,                      // one-line description; null when no source field is populated
  snippet: string | null,                      // short context snippet, ≤200 chars; null when nothing meaningful to show
  matchedOn:                                   // why this result matched (powers the snippet for non-description kinds)
    | 'name' | 'display' | 'description' | 'comment' | 'expr' | 'sample_value' | 'body',
  connectionId?: string,                       // present for non-wiki kinds
  tableRef?: {                                 // present for kind 'table' and 'column'
    catalog: string | null,
    db: string | null,
    name: string,
  },
  columnName?: string,                         // present for kind 'column'
}
```

The structured `tableRef` mirrors the live `KtxSchemaTable` identity
(`packages/context/src/scan/types.ts:74-83`) so callers can pass refs into
`entity_details` without losing `catalog`/`db` qualification on drivers
that need it (BigQuery `project.dataset.table`, Snowflake/SQL Server
`database.schema.table`).

#### `summary` and `snippet` provenance per kind

Both fields are derived from existing source data, never invented or
LLM-generated. The resolver is pure and deterministic per kind. When no
source field exists for a given kind, the field is `null`; agents must
not assume a missing snippet means "no context" — they should dereference
the ref via `wiki_read`, `sl_read_source`, or `entity_details` to get
authoritative content.

| Kind | `summary` source | `snippet` source |
|---|---|---|
| `wiki` | `WikiFrontmatter.summary` (`packages/context/src/wiki/types.ts:15`) — populated at write time | Up to 200 chars from the wiki body around the match position; falls back to first 200 chars of body when `matchedOn === 'name'`/`'display'` |
| `sl_source` | `resolveDescription(source.descriptions, priority)` (`packages/context/src/sl/descriptions.ts:16-34`) over the `user|ai|dbt|db` priority chain (`packages/context/src/sl/types.ts:5`) | When `matchedOn === 'description'`/`'body'`: a window of the resolved description; otherwise the source's `name` + first 1–2 measure or dimension names as context |
| `sl_measure` | `measure.description` (`packages/context/src/sl/types.ts:37`) | `measure.expr` truncated to 200 chars — the calculation is the most informative one-line context for a measure |
| `sl_dimension` | `resolveDescription(column.descriptions, priority)` (same precedence as `sl_source`); when empty, fall back to `null` | `${column.name} (${column.type})` formatted exactly like the existing inline rendering in `sl-search.service.ts:29-41` |
| `table` | `firstDescription(table.descriptions)` then `table.comment` (precedence already used by `warehouse-catalog.service.ts:286-287`); `null` when both are empty | When `matchedOn === 'description'`/`'comment'`: a window of that string; when `matchedOn === 'name'`/`'display'`: a comma-joined list of up to 5 of the table's column names |
| `column` | `resolveDescription(column.descriptions)` then `column.comment` (`warehouse-catalog.service.ts:228-245`); `null` when both are empty | When `matchedOn === 'description'`/`'comment'`: that text; when `matchedOn === 'sample_value'`: `${column.nativeType} · samples: <up to 5 sampleValues>` formatted from `column.sampleValues` (`warehouse-catalog.service.ts:18-23`); otherwise `${column.nativeType}` |

The `matchedOn` field is the same concept as the existing
`RawSchemaHit.matchedOn` in `warehouse-catalog.service.ts:40-54`,
extended to the wiki and SL kinds. Snippets always come from a single
already-stored field; the resolver never concatenates across sources or
invents bridging text. Length cap is enforced at the producer side (≤200
chars after a single-pass slice; no ellipsis appended — clients render
one if they want).

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
    // table accepts either a driver-display string ("project.dataset.table",
    // "schema.name", "db.schema.name") or a structured ref. The resolver
    // returns a structured error when the input is ambiguous across multiple
    // schemas/catalogs.
    table: z.union([
      z.string().min(1),
      z.object({
        catalog: z.string().nullable(),
        db: z.string().nullable(),
        name: z.string().min(1),
      }),
    ]),
    columns: z.array(z.string()).optional(),   // omit → all columns
  })).min(1).max(20),
}
```

**Output:** for each entity, a structured record:

```typescript
{
  connectionId: string,
  tableRef: {                                  // structured identity, lossless on every driver
    catalog: string | null,                    // BigQuery project, Snowflake/SQL Server database
    db: string | null,                         // schema/dataset
    name: string,
  },
  display: string,                             // driver-formatted display string
                                               //   (e.g. "project.dataset.table", "schema.name")
  kind: 'table' | 'view' | 'external' | 'event_stream',  // matches KtxSchemaTableKind
  comment: string | null,
  estimatedRows: number | null,
  columns: Array<{
    name: string,
    nativeType: string,
    normalizedType: string,
    dimensionType: 'time' | 'string' | 'number' | 'boolean',
    nullable: boolean,
    primaryKey: boolean,
    comment: string | null,
  }>,
  foreignKeys: Array<{
    fromColumn: string,
    toCatalog: string | null,                  // qualified FK target, preserves cross-db FKs
    toDb: string | null,
    toTable: string,
    toColumn: string,
    constraintName: string | null,
  }>,
  snapshot: {                                  // freshness metadata, present on every response
    syncId: string,                            // latest scan/sync identifier
    extractedAt: string,                       // ISO-8601 UTC of the snapshot
    scanRunId: string | null,                  // scan run id if available
  },
}
```

Output fields mirror `KtxSchemaTable` / `KtxSchemaColumn` /
`KtxSchemaForeignKey` from `packages/context/src/scan/types.ts:51-82`. The
full `KtxSchemaTableKind` set is preserved so BigQuery `external` tables
and warehouses with event-stream sources are not silently coerced. FK
target qualification (`toCatalog`/`toDb`) carries through so agents can
write valid SQL for cross-schema or cross-database references without
re-resolving.

If `columns` is provided, only the requested columns appear in the `columns`
array (PKs and FKs still report on the full table).

**Implementation:** new module `packages/context/src/scan/entity-details.ts`.
Reads `KtxSchemaSnapshot` from the same store the existing `scan_*` tools
read. No new infrastructure. If the requested table is not in the latest
snapshot, the tool returns a structured error with a suggestion to run
`ktx ingest <connectionId>`.

**Cache freshness.** Today `WarehouseCatalogService` caches `ConnectionCatalog`
per connection name with no invalidation
(`packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts:248-249`,
`:404-411`). For an ingest tool that runs inside a single short-lived ingest
session that is acceptable, but the MCP daemon is long-lived and serves
clients across multiple `scan_trigger` / `ktx ingest` runs. The MCP adapter
**must** key its cache on the latest scan artifact identity (the `syncId`
derived from the artifact path, or the artifact file mtime) and re-read when
that identity advances. The same rule applies to the shared services backing
`discover_data` and `dictionary_search`. The implementation plan must
either:

1. Extend `WarehouseCatalogService` (and equivalent dictionary/discover
   services) to invalidate cached entries when the underlying artifact
   identity advances, or
2. Wrap those services in an MCP-adapter cache layer that performs the
   identity check before returning cached values.

### dictionary_search

Find which connection, source, and column **profile-sampled** a given literal
value (or substring) such as "Acme Corp" or "shipped". Backed by the existing
`SlDictionaryEntry` extraction over relationship-profiling artifacts.

**Authoritativeness.** The dictionary index is built from *sampled* values
captured during relationship profiling — by default 5 values per column,
drawn from a sample of up to 10,000 rows
(`packages/context/src/scan/relationship-profiling.ts:409-410`,
`packages/context/src/sl/sl-dictionary-profile.ts:70`). A hit confirms a
column contains the value; a miss is **not** proof that the value is absent
from the column or warehouse — the value may simply have been outside the
profile sample. The tool must surface this distinction in its output and the
research skill must teach agents not to treat a miss as exhaustive.

**Input schema:**

```typescript
{
  values: z.array(z.string().min(1)).min(1).max(20),
  connectionId: z.string().optional(),         // omit → all connections
}
```

**Output:** for each input value, the list of matching entries plus
per-connection provenance. Coverage and miss reasons are connection-scoped
because `loadLatestSlDictionaryEntries` iterates each connection's profile
artifact independently
(`packages/context/src/sl/sl-dictionary-profile.ts:96-112`); a single
all-connections call can mix `no_profile_artifact` (one connection never
ran an enriched scan), `value_not_in_sample` (another connection ran but
the literal was outside the sample), and matches in the same response.

```typescript
{
  // The set of connections actually searched on this call. When the input
  // omits connectionId this is every configured connection; otherwise it
  // contains the single requested connection.
  searched: Array<{
    connectionId: string,
    coverage: {
      sampledRows: number | null,              // profileSampleRows used at profile time
      valuesPerColumn: number | null,          // sampleValuesPerColumn used at profile time
      profiledColumns: number,                 // count of columns in the dictionary index for this connection
      syncId: string | null,                   // identifier of the profile artifact (null when missing)
      profiledAt: string | null,               // ISO-8601 UTC of the profile artifact (null when missing)
    },
    // Per-connection status, independent of any specific input value:
    //   ready                — profile present with profiled columns
    //   no_profile_artifact  — enriched scan never ran for this connection
    //   no_candidate_columns — profile present but no columns profile-eligible
    status: 'ready' | 'no_profile_artifact' | 'no_candidate_columns',
  }>,
  results: Array<{
    value: string,                             // input value
    matches: Array<{
      connectionId: string,
      sourceName: string,
      columnName: string,
      matchedValue: string,                    // actual value found (may differ in case)
      cardinality: number | null,              // column cardinality if known
    }>,
    // Per-connection miss reasons for this value, present when that
    // connection produced no match. Connections that matched do not appear
    // in `misses`. For ready connections with no match, the reason is
    // 'value_not_in_sample' (non-authoritative miss). For unready
    // connections, the reason mirrors their `status` above.
    misses: Array<{
      connectionId: string,
      reason:
        | 'no_profile_artifact'
        | 'no_candidate_columns'
        | 'value_not_in_sample',
    }>,
  }>,
}
```

**Matching semantics:** case-insensitive substring match against the
profile-sampled values. Misses are never authoritative — they only state
that the value was not in the captured sample for the listed connection.
`misses[].reason` distinguishes "no enriched scan has run on this
connection" (`no_profile_artifact`), "enriched scan ran but no columns
were profile-eligible" (`no_candidate_columns`), and "scan ran but value
was not in the sample" (`value_not_in_sample`). The research skill must
direct agents to follow up a `value_not_in_sample` miss with
`sql_execution` against the most plausible columns, not to conclude the
value is absent.

**Cache freshness:** the dictionary index is keyed on the profile artifact
identity (the `syncId` derived from its path or the artifact mtime). When
that identity advances, the daemon re-reads the artifact on next call. See
the `entity_details` cache-freshness note above for the shared rule.

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
  headerTypes?: string[],                      // driver-mapped type names, one per header; optional
  rows: Array<Array<unknown>>,
  rowCount: number,
}
```

`headerTypes` is optional because not every connector exposes per-column
type metadata. The current contract makes it optional
(`KtxQueryResult.headerTypes` in `packages/context/src/scan/types.ts:272-277`),
and the SQLite connector currently omits it
(`packages/connector-sqlite/src/connector.ts:237-240`, `:301-308`). When a
connector returns header types, the MCP adapter passes them through
verbatim. When a connector does not, the MCP adapter omits the field rather
than fabricating values.

**Implementation:** delegates to `KtxScanConnector.executeReadOnly` on the
matching connector. The connector calls `assertReadOnlySql` and
`limitSqlForExecution` (`packages/context/src/connections/read-only-sql.ts`).

**Read-only enforcement is lexical, not parser-backed.** The current guard
inspects the first token with regex: it accepts queries whose first non-space
token is `SELECT` or `WITH`, and rejects queries whose first non-space token
matches a fixed mutating-verb list. Implications:

- A CTE that nests a data-modifying statement (e.g., `WITH x AS (INSERT ...
  RETURNING *) SELECT ...`, valid in Postgres) passes the first-token check
  and would reach the connector.
- Dialect-specific read/write constructs and procedure calls that do not
  start with a listed verb are not caught.

Because `sql_execution` exposes this boundary to external MCP clients, the
tool **must not** be enabled until one of the following holds:

1. The guard is upgraded to a sqlglot/AST-based read-only check that
   inspects every statement and CTE node, with explicit tests for CTE-DML,
   `CALL`, `DO`, vendor pragmas, and multi-statement payloads; or
2. Connector-side execution forces a read-only transaction / session (e.g.,
   `SET TRANSACTION READ ONLY` for Postgres, `READ ONLY` connection for
   MySQL, equivalent for each connector), so the guard is defense-in-depth
   rather than the sole boundary.

The implementation plan that follows this spec is required to choose and
land one of those before registering `sql_execution` in the MCP surface.
Errors from `assertReadOnlySql` (whichever implementation) are returned as
structured tool errors so the agent can correct the query and retry.

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
ktx mcp start [--port <n>] [--host <h>] [--token <t>] [--foreground] \
              [--allowed-host <h>...] [--allowed-origin <o>...]
ktx mcp stop
ktx mcp status
ktx mcp logs [--follow]
```

`--allowed-host` and `--allowed-origin` are repeatable. They extend (not
replace) the defaults defined in the security model below.

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
`@modelcontextprotocol/sdk/server/streamableHttp.js`.

The `/mcp` endpoint must implement the full Streamable HTTP contract, not
just `POST`:

- `POST /mcp` — JSON-RPC requests (and the `initialize` handshake when no
  session exists). On the first `initialize` post, the server allocates a
  session id and returns it in the `Mcp-Session-Id` response header.
- `GET /mcp` — opens an SSE stream for server-initiated messages on an
  existing session. Requires a valid `Mcp-Session-Id` header.
- `DELETE /mcp` — explicit session termination by the client. Requires a
  valid `Mcp-Session-Id` header; the server must drop the session and any
  associated SSE streams.

**Session model.** v1 ships **stateful** sessions: the server generates a
session id with `randomUUID()` on `initialize`, stores the transport in an
in-memory map keyed by session id, reuses it on subsequent
`POST`/`GET`/`DELETE` calls that carry the same `Mcp-Session-Id`, and
removes it on `DELETE` or transport close. Requests that carry an unknown
session id are rejected with HTTP 404 so the client knows to re-initialize.

Health: `GET /health` returns `{ status: 'ok', projectDir, port }` for
liveness checks. `/health` is separate from `/mcp` and is not subject to
session-id requirements (but is subject to host/origin validation; see
below).

### Security model

- `127.0.0.1` binding is the default and requires no token auth (loopback
  only). Even on loopback, the server enforces **Host and Origin header
  validation** on every `/mcp` and `/health` request to defend against
  browser-driven DNS-rebinding attacks (the same defense the MCP SDK
  exposes in `createMcpExpressApp` / `createMcpHonoApp`).
- **Host validation** compares the incoming `Host` header to the allowed-host
  list after normalizing: lowercase, strip any port, strip surrounding
  brackets from IPv6 literals (`[::1]:7878` → `::1`). Comparison is exact
  on the normalized host string. The default allowed-host list is
  `['localhost', '127.0.0.1', '::1']`. `--allowed-host` values are appended
  after the same normalization.
- **Origin validation** compares the full browser `Origin` header (scheme +
  host + port) to the allowed-origin list. The default allowed-origin list
  is empty: any request that carries an `Origin` header is rejected unless
  an explicit `--allowed-origin` entry matches. Non-browser clients that
  do not send an `Origin` header (Claude Code, Cursor, Codex, opencode
  HTTP transports) are accepted regardless of `Origin`. Each
  `--allowed-origin` value must be a full origin string
  (e.g., `http://localhost:7878`); KTX validates the format at startup.
- Non-loopback binding requires `--token <t>` or `KTX_MCP_TOKEN`. The
  server checks `Authorization: Bearer <t>` on **every** `/mcp` method —
  `POST`, `GET` (SSE), and `DELETE` — and rejects with HTTP 401 otherwise.
  Token enforcement is independent of the session check; both must pass.
  When `--host` is non-loopback, the allowed-host list expands to include
  the normalized bound host plus any user-supplied `--allowed-host`
  values.
- TLS is out of scope. For remote access, document running KTX behind a
  reverse proxy (Caddy, nginx) that terminates TLS.

## Client config installation via `ktx setup-agents`

`ktx setup-agents` extends its existing per-target file installation
(`plannedKtxAgentFiles` in `packages/cli/src/setup-agents.ts:64`) to also
write MCP server entries.

The per-client config matrix is **not uniform**. Each client has its own
file location, scope semantics, and entry shape; `setup-agents` must
produce the correct shape per target rather than emit one JSON blob.

| Target | Scope | MCP config path | Writer behavior |
|---|---|---|---|
| claude-code | user (global) | `~/.claude.json` → root `mcpServers.ktx` | write JSON |
| claude-code | local (per-project, private) | `~/.claude.json` → `projects[<absProjectPath>].mcpServers.ktx` | write JSON |
| claude-code | project (shared, checked in) | `<projectDir>/.mcp.json` → `mcpServers.ktx` | write JSON |
| cursor | global | `~/.cursor/mcp.json` → `mcpServers.ktx` | write JSON |
| cursor | project | `<projectDir>/.cursor/mcp.json` → `mcpServers.ktx` | write JSON |
| codex | user (global) | `~/.codex/config.toml` → `[mcp_servers.ktx]` (TOML) | print instructions; do not auto-write in v1 |
| opencode | user (global) | `~/.config/opencode/opencode.json` → `mcp.ktx` | print instructions; do not auto-write in v1 |
| opencode | project | `<projectDir>/opencode.json` → `mcp.ktx` | print instructions; do not auto-write in v1 |

The shared global `~/.claude.json` and per-project `~/.claude.json` →
`projects[...]` scope are both supported because Claude Code's "user" vs.
"local" scopes write to different sub-trees of the same file; `setup-agents`
must select the scope explicitly per invocation.

Codex and opencode entries are **printed as copy-pasteable snippets** in v1
because their config formats (TOML for codex, a different JSON wrapper for
opencode) diverge enough from the JSON writers above that mixing them into
the same writer codepath risks silently producing invalid files. This is a
deliberate v1 scoping decision, not a permanent limitation.

#### Entry shapes by target

Claude Code (HTTP):

```jsonc
{
  "mcpServers": {
    "ktx": {
      "type": "http",
      "url": "http://localhost:7878/mcp"
      // when token auth is active, env-var expansion only:
      // "headers": { "Authorization": "Bearer ${KTX_MCP_TOKEN}" }
    }
  }
}
```

Cursor (HTTP, project `.cursor/mcp.json` or global `~/.cursor/mcp.json`):

```jsonc
{
  "mcpServers": {
    "ktx": {
      "url": "http://localhost:7878/mcp"
      // when token auth is active, env-var expansion only:
      // "headers": { "Authorization": "Bearer ${KTX_MCP_TOKEN}" }
    }
  }
}
```

Codex (printed snippet, `~/.codex/config.toml`):

```toml
[mcp_servers.ktx]
url = "http://localhost:7878/mcp"
# Codex MCP config does not currently document a headers field; if token
# auth is active, instruct the user to either run KTX on loopback without a
# token or wait for codex header support before enabling.
```

opencode (printed snippet, `opencode.json`):

```jsonc
{
  "mcp": {
    "ktx": {
      "type": "remote",
      "url": "http://localhost:7878/mcp",
      "enabled": true
      // when token auth is active, env-var expansion only:
      // "headers": { "Authorization": "Bearer ${KTX_MCP_TOKEN}" }
    }
  }
}
```

#### Token handling per client

When `--token` / `KTX_MCP_TOKEN` is active, `setup-agents` writes the bearer
token **only via environment-variable reference** (`Bearer ${KTX_MCP_TOKEN}`),
never as a literal token value. Claude Code, Cursor, and opencode all
support environment-variable expansion inside `headers` values; the
written entry references `${KTX_MCP_TOKEN}` and the user is responsible
for exporting it in the shell that launches the MCP client.

Rules:

- **No literal-token writes, anywhere.** Even the user-scope (private)
  Claude Code / Cursor config receives env-var references, not the raw
  token. This keeps the same writer codepath for every scope and avoids a
  branch that materializes secrets.
- **Project-scope (shared, checked-in) configs are gated.** When a token is
  active and the user requests a shared scope — `<projectDir>/.mcp.json`
  for Claude Code, `<projectDir>/.cursor/mcp.json` for Cursor — `setup-agents`
  prints a warning and offers a choice: (a) write the entry with the
  `${KTX_MCP_TOKEN}` reference (the file is safe to commit; readers must
  export the variable locally), or (b) skip the shared entry and rely on a
  user-scope entry instead. The default is (a).
- **Verify header support per client before writing.** The matrix below
  reflects the current state of each client's MCP config docs:
  - claude-code: supports `headers` with `${VAR}` expansion on HTTP entries.
  - cursor: supports `headers` with `${VAR}` expansion on HTTP entries.
  - opencode: supports `headers` with `${VAR}` expansion on remote MCP
    entries.
  - codex: **not currently supported** in published config docs. When a
    token is active and the user selects codex, `setup-agents` prints a
    warning and skips the codex entry rather than writing an entry that
    codex will silently ignore. The recommended workaround is to bind KTX
    to loopback without a token for codex users.
- **Implementation acceptance test.** Setup-agents writer tests must assert
  that no rendered output contains the literal token string for any
  scope/target combination — only the `${KTX_MCP_TOKEN}` reference.

Port is read from `.ktx/mcp.json` if present, falling back to 7878. The
install manifest (`agentInstallManifestPath`,
`packages/cli/src/setup-agents.ts:60`) tracks each **written** entry so
`ktx setup-agents --remove` can roll back cleanly. The current manifest
entry kinds are `file` and `json-key`
(`packages/cli/src/setup-agents.ts:42-50`); the MCP client writers for
claude-code and cursor add `json-key` entries for their respective config
files. Printed-only snippets for codex and opencode are **not** tracked in
the manifest, and `--remove` does not attempt to mutate user-written
files for those targets; the printed instructions tell the user how to
remove the entry by hand.

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
- Validate value mentions with `dictionary_search` instead of guessing case/spelling — but treat a `dictionary_search` *miss* as non-authoritative. The index is built from profile-sampled values, so a missing value may simply have been outside the sample. Follow up with `sql_execution` against the most plausible columns before concluding the value is absent.
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
  records from `KtxSchemaSnapshot`, sharing resolution logic with
  `warehouse-verification/warehouse-catalog.service.ts` (refactored or
  imported, not duplicated).
- `packages/context/src/sl/dictionary-search.ts` — builds and queries the
  dictionary index over relationship-profiling artifacts.
- `packages/context/src/search/discover.ts` — composes wiki, SL, and raw
  schema searches; fuses results via `rrf.ts`. Reuses the same wiki/SL/raw
  search building blocks as `warehouse-verification/discover-data.tool.ts`.
- `packages/cli/src/commands/mcp-commands.ts` — `ktx mcp start|stop|status|logs`.
- `packages/cli/src/managed-mcp-daemon.ts` — daemon lifecycle (spawn,
  pidfile, log management), mirroring `managed-python-daemon.ts`.
- `packages/cli/src/skills/research/SKILL.md` — research workflow skill.
- Tests for each new module following existing patterns
  (`*.test.ts` siblings), including coverage of the per-client config
  writer/printer matrix.

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
- Setup-agents tests verifying behavior per target: claude-code and cursor
  writers add the correct JSON entry and a corresponding `json-key`
  manifest entry that `--remove` cleans up; codex and opencode targets
  produce printed snippet output and do not mutate any user config file
  or add manifest entries in v1.
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
