# MCP Tool Polish: Slim Research Surface + Spec Compliance

**Date:** 2026-05-16
**Author:** Andrey Avtomonov
**Status:** Design — pending implementation plan

## Background

KTX currently exposes 25 MCP tools across context, semantic-layer, ingest, and
scan ports (`packages/context/src/mcp/context-tools.ts`). The
`ktx-analytics` SKILL.md (`packages/cli/src/skills/analytics/SKILL.md`)
is installed into every supported MCP client by `ktx setup --agents` and
already describes a Douala-equivalent research methodology (Discover → Inspect
→ Resolve → Plan → Query → Validate → Capture) that references nine of those
tools.

A recent in-session audit surfaced three real bug classes:

- **`structuredContent` shape** — `discover_data` returned a bare array; MCP
  requires an object. Fixed.
- **Union-shape LLM drift** — `sl_query.order_by` accepted
  `{ field, direction }` but Claude emitted Cube-style `{ id, desc }`. Fixed
  via a `z.preprocess` that normalizes the alt-shape before strict validation.
- **Contract leak to the Python daemon** — `compileLocalSlQuery` skipped
  `toResolvedWire` and sent TS-only authoring fields (`usage`,
  `inherits_columns_from`) to a Pydantic model with `extra="forbid"`. Fixed.

The audit also identified systemic gaps applicable across the surface: no
per-field `.describe()` outside `memory_capture*`, no `outputSchema` declared
anywhere, no MCP tool annotations, lingering union-drift risk on
`slQueryDimensionSchema` (`{ dimension, granularity }`) and
`entityDetailsTableRefSchema` (`{ schema, table }`), and inconsistent error
handling (only `sql_execution` wraps thrown errors in-band per MCP spec; the
other 24 let exceptions propagate as JSON-RPC errors).

The current MCP spec (2025-11-25) provides several mechanisms KTX does not
use: `outputSchema` with `structuredContent` validation, tool annotations
(`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`/`title`),
progress notifications via `_meta.progressToken`, and a clear in-band error
contract (`isError: true` with text content).

The 25-tool surface is also wider than the agent needs. The `ktx-analytics`
SKILL only orchestrates nine of them; the rest are admin/setup/maintenance
operations that are better served by a `ktx`-CLI flow (and a future
`ktx-admin` SKILL — out of scope for this spec).

## Goals

- Reduce the MCP-registered surface to **11 tools** focused on the research
  loop: `connection_list`, `discover_data`, `wiki_search`, `wiki_read`,
  `entity_details`, `dictionary_search`, `sl_read_source`, `sl_query`,
  `sql_execution`, `memory_ingest` (new), `memory_ingest_status` (new). The
  remaining 14 tools become CLI-only by removing their MCP registration; their
  implementations stay in `packages/context/src/` to back the CLI.
- Replace `memory_capture` / `memory_capture_status` with `memory_ingest` /
  `memory_ingest_status`. The new tool takes free-form markdown `content`
  plus optional `connectionId`; the memory agent triages into wiki and SL as
  before.
- Apply the per-tool polish kit on every retained tool: MCP tool annotations,
  `outputSchema`, per-field `.describe()`, rewritten tool descriptions,
  standardized in-band error handling, union-drift normalization on the two
  remaining at-risk schemas, and a type-narrowed `jsonToolResult`.
- Emit MCP progress notifications from `sql_execution` and `sl_query`.
- Update `ktx-analytics` SKILL.md to use the renamed tool, broaden the capture
  step, and document multi-connection routing.

## Non-Goals

- Admin CLI skill (separate spec).
- Deleting the source code of the admin tools (deferred follow-up gated by
  the admin CLI skill landing).
- MCP resources (subscribable wiki / SL).
- MCP prompts pushed by the server (the analytics SKILL is the equivalent).
- Elicitation, sampling, tool icons.
- A code-execution tool / Python sandbox (separate spec; the analytics
  workflow does not require one for the goals above).
- Per-client schema-feature workarounds beyond what the audit findings
  already cover. Codex's no-header-auth limitation is unrelated to tool
  shape and is left to `setup-agents.ts` to document.
- Multi-tenancy, telemetry, rate limiting.

## Design

### 1. Surface change

#### 1.1 Retained tools (11)

| # | Tool | Port |
|---|---|---|
| 1 | `connection_list` | `KtxConnectionsMcpPort.list` |
| 2 | `discover_data` | `KtxDiscoverDataMcpPort.search` |
| 3 | `wiki_search` | `KtxKnowledgeMcpPort.search` |
| 4 | `wiki_read` | `KtxKnowledgeMcpPort.read` |
| 5 | `entity_details` | `KtxEntityDetailsMcpPort.read` |
| 6 | `dictionary_search` | `KtxDictionarySearchMcpPort.search` |
| 7 | `sl_read_source` | `KtxSemanticLayerMcpPort.readSource` |
| 8 | `sl_query` | `KtxSemanticLayerMcpPort.query` |
| 9 | `sql_execution` | `KtxSqlExecutionMcpPort.execute` |
| 10 | `memory_ingest` | New port `KtxMemoryIngestMcpPort.ingest` |
| 11 | `memory_ingest_status` | `KtxMemoryIngestMcpPort.status` |

`connection_list` is retained because in multi-connection projects, the agent
needs a way to enumerate available connections before issuing a `sql_execution`
or `sl_query` against a specific one.

**`connectionId` resolution per retained tool** (auto-resolution exists today
only on the local SL path; do not broaden it as part of this spec):

| Tool | `connectionId` | Auto-resolves to single connection if omitted? |
|---|---|---|
| `connection_list` | n/a | n/a |
| `discover_data` | optional | no — search is run unscoped when omitted |
| `wiki_search` | n/a | n/a |
| `wiki_read` | n/a | n/a |
| `entity_details` | required | no |
| `dictionary_search` | optional | no — search is run unscoped when omitted |
| `sl_read_source` | required | no |
| `sl_query` | optional | yes — `resolveLocalConnectionId` (`packages/context/src/sl/local-query.ts`) auto-resolves when the project has exactly one connection |
| `sql_execution` | required | no |
| `memory_ingest` | optional | no — omitted means "global" knowledge (wiki only — see below) |
| `memory_ingest_status` | n/a | n/a |

The skill update in §3 must reflect this matrix: when `connection_list` shows
multiple connections, the agent always passes `connectionId` for the required
tools and for `sl_query`/`discover_data`/`dictionary_search` whenever the user
intent pins a specific warehouse.

**`memory_ingest` connectionId semantics — important constraint.** The
underlying `MemoryAgentService.ingest` derives `hasSL = !!input.connectionId`
(`packages/context/src/memory/memory-agent.service.ts:55`) and only wires the
SL-capable toolset when `connectionId` is supplied
(`packages/context/src/memory/memory-agent.service.ts:116-118`). Therefore
`memory_ingest` can update the semantic layer **only** when `connectionId` is
provided. Omit `connectionId` only for genuinely global wiki-only knowledge
(company-wide policies, vocabulary, user preferences); supply `connectionId`
for any knowledge that touches a specific warehouse — including measure
definitions, schema gotchas, and any wording like "in our warehouse" or "this
warehouse". The §3 SKILL update and the worked example must enforce this.

#### 1.2 Removed from MCP registration

`connection_test`, `wiki_write`, `sl_list_sources`, `sl_write_source`,
`sl_validate`, `ingest_trigger`, `ingest_status`, `ingest_report`,
`ingest_replay`, `scan_trigger`, `scan_status`, `scan_report`,
`scan_list_artifacts`, `scan_read_artifact`,
plus `memory_capture` and `memory_capture_status` (replaced).

The conditional registration blocks in `registerKtxContextTools` for these
ports are removed. The underlying `KtxIngestMcpPort`, `KtxScanMcpPort`, etc.
implementations stay; the `ktx` CLI uses them directly. The `KtxMcpContextPorts`
type drops the removed `ingest?`, `scan?`, etc. fields. `MemoryCapturePort` is
renamed to `MemoryIngestPort`.

#### 1.3 New tool — `memory_ingest`

Replaces `memory_capture`. The change is a rename + a slightly relaxed input
contract; the underlying `MemoryCaptureService`
(`packages/context/src/memory/memory-runs.ts:81`) is reused as-is and renamed to
`MemoryIngestService`. No alias, no migration shim — per the standing
no-back-compat rule, the rename is atomic with the SKILL update.

**Final internal API shape after the rename — no compatibility wrappers:**

| Old name | New name |
|---|---|
| `MemoryCaptureService` (class) | `MemoryIngestService` |
| `MemoryCaptureService.capture(input)` (method) | `MemoryIngestService.ingest(input)` |
| `MemoryCaptureServiceDeps` | `MemoryIngestServiceDeps` |
| `MemoryCaptureStartResult` | `MemoryIngestStartResult` |
| `MemoryCaptureStatus` (return type) | `MemoryIngestStatus` |
| `MemoryCapturePort` (in `mcp/types.ts`) | `MemoryIngestPort` (with `.ingest()` and `.status()`) |
| `MemoryCapturePort.capture()` | `MemoryIngestPort.ingest()` |
| `TextMemoryCapturePort` (CLI, `text-ingest.ts`) | `TextMemoryIngestPort` (with `.ingest()`, `.waitForRun()`, `.status()`) |
| `createLocalProjectMemoryCapture` factory | `createLocalProjectMemoryIngest` |

Every internal call site (`packages/context/src/mcp/server.ts`,
`packages/context/src/mcp/local-project-ports.ts`,
`packages/cli/src/mcp-server-factory.ts`, `packages/cli/src/text-ingest.ts`,
their tests, and the `packages/context/src/memory/index.ts` re-exports) is
updated in lockstep. The agent-facing `MemoryAgentService.ingest` method and
its `MemoryAgentInput` type are unchanged.

**Mapping `memory_ingest` input → `MemoryAgentInput`** (defined in
`packages/context/src/memory/types.ts`):

| `MemoryAgentInput` field | Value supplied by `memory_ingest` handler |
|---|---|
| `userId` | `userContext.userId` (existing pattern) |
| `chatId` | `mcp-${randomUUID()}` (existing pattern) |
| `userMessage` | synthetic framing string, e.g. `Ingest external knowledge into KTX memory.` |
| `assistantMessage` | input.`content` |
| `connectionId` | input.`connectionId` (when provided) |
| `sourceType` | `'external_ingest'` |

The free-form markdown is routed into `assistantMessage` (not `userMessage`)
with a synthetic framing `userMessage`, mirroring the existing CLI text-ingest
path (`packages/cli/src/text-ingest.ts:295-302`). This mapping is required so
that `detectCaptureSignals`
(`packages/context/src/memory/capture-signals.ts:14`) can fire its
`assistantMessage`-keyed cues — SQL aggregates, LookML structure, and
definition tables — for artifact-like content. Routing content into
`userMessage` would lose those signals and silently degrade triage parity with
CLI ingest. The existing memory-agent prompt and tests already expect this
shape; no changes to the memory agent itself are required.

Acceptance criterion: an MCP `memory_ingest` call with the same markdown
content as a CLI `ktx ingest text` invocation must produce identical
`CaptureSignals` (knowledge / sl / dialect / reasons) — covered by a parity
test that feeds the same fixture content through both ingest entry points and
asserts equal `detectCaptureSignals` output.

**Input schema:**

```typescript
const memoryIngestSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'Free-form markdown to ingest. Include the knowledge itself plus any ' +
        'context (source, the user\'s question, why this came up) that the ' +
        'memory agent should consider when triaging into wiki/SL.',
    ),
  connectionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Scope this memory to a specific connection. REQUIRED when the knowledge ' +
        'is warehouse-specific (measure definitions, schema gotchas, anything ' +
        'tied to a particular warehouse) — without it the memory agent cannot ' +
        'update the semantic layer and the knowledge will land as wiki-only. ' +
        'Omit only for genuinely global wiki knowledge (company-wide policies, ' +
        'vocabulary, user preferences).',
    ),
});
```

**Tool description:**

> Ingest free-form knowledge into KTX's durable memory so it is available to
> future turns. Call this whenever a research turn produces something worth
> remembering — business rules, metric definitions, gotchas, schema
> explanations, recurring findings — **or** whenever the user asks you to
> remember something. Pass everything in `content` as markdown: the finding,
> plus any source or context that helps the memory agent triage. KTX's memory
> agent decides whether the content belongs in the wiki, the semantic layer,
> or both. Each call is a feedback loop — better notes here mean smarter
> `discover_data` and `wiki_search` results for everyone next time.

**Returns:** `{ runId: string }` — same shape as today's `memory_capture`.

**`memory_ingest_status`** mirrors today's `memory_capture_status` exactly,
renamed only.

### 2. Per-tool polish kit

#### 2.0 Registration topology — memory tools must share the polish path

Today `memory_capture` / `memory_capture_status` are registered in
`packages/context/src/mcp/server.ts` via direct `deps.server.registerTool`
calls (`server.ts:23,45`), **bypassing** `registerParsedTool` in
`context-tools.ts`. If left as-is, the polish kit below
(annotations, `outputSchema`, in-band error wrapping, per-field `.describe()`)
would not apply to `memory_ingest` / `memory_ingest_status`, contradicting the
"all 11 tools" acceptance criteria.

Therefore, as part of the polish-kit PR (PR 2), one of the following must
happen — the implementation plan picks:

1. **Preferred:** Move `memory_ingest` and `memory_ingest_status` registration
   into `registerKtxContextTools` so they go through `registerParsedTool` like
   every other tool. The `MemoryIngestPort` becomes a `contextTools.memoryIngest`
   port and the standalone `registerMemoryCaptureTools` helper in `server.ts`
   is deleted.
2. **Acceptable fallback:** Keep `registerMemoryIngestTools` in `server.ts`
   but rewrite it to call `registerParsedTool` (exported from
   `context-tools.ts`) so the same annotations / `outputSchema` /
   error-wrapping plumbing is applied uniformly.

Either way, every checklist item in §§2.1–2.4 must apply to the two memory
tools, and the §Verification annotations and `outputSchema` tests must cover
them.

#### 2.1 Tool annotations

Every tool gets annotations and a `title`:

| Tool | title | readOnly | destructive | idempotent | openWorld |
|---|---|:--:|:--:|:--:|:--:|
| `connection_list` | Connection List | ✓ | — | ✓ | — |
| `discover_data` | Discover Data | ✓ | — | — | — |
| `wiki_search` | Wiki Search | ✓ | — | — | — |
| `wiki_read` | Wiki Read | ✓ | — | ✓ | — |
| `entity_details` | Entity Details | ✓ | — | ✓ | — |
| `dictionary_search` | Dictionary Search | ✓ | — | — | — |
| `sl_read_source` | Semantic Layer Read Source | ✓ | — | ✓ | — |
| `sl_query` | Semantic Layer Query | ✓ | — | — | — |
| `sql_execution` | SQL Execution | ✓ | — | — | — |
| `memory_ingest` | Memory Ingest | — | ✓ | — | — |
| `memory_ingest_status` | Memory Ingest Status | ✓ | — | omit | — |

`openWorldHint: false` for every tool — even `sql_execution` targets a
configured, bounded warehouse, not the web. `sql_execution` is `readOnlyHint:
true` because the server-side parser enforces read-only (`assertReadOnlySql`).
`destructiveHint` is omitted (defaults to `false`) for read-only tools per the
MCP spec; explicit `false` is fine but redundant.

`ToolAnnotations` are static optional booleans per the MCP 2025-11-25 schema
(`title?`, `readOnlyHint?`, `destructiveHint?`, `idempotentHint?`,
`openWorldHint?` — no state-dependent variants). `idempotentHint` describes
whether repeated calls have additional environmental effect and is most
meaningful when `readOnlyHint` is `false`. For `memory_ingest_status`, which is
a polling read whose response shape changes while a run is active, leave
`idempotentHint` unset — the tool is read-only but not statically idempotent.

`registerTool` accepts annotations in the `config` object today; this is a
plumbing change in `registerParsedTool` to forward them.

#### 2.2 `outputSchema` on all 11 tools

Per the MCP 2025-11-25 spec, clients SHOULD validate `structuredContent`
against `outputSchema` when declared. Authoring is mechanical: each response
shape already typed in `packages/context/src/mcp/types.ts` gets a parallel
Zod schema and is passed as `outputSchema` to `registerTool`.

`registerParsedTool` is extended to accept an optional `outputSchema` arg and
forward it to `server.registerTool`. The Zod schemas live alongside the
input schemas in `context-tools.ts` (or a sibling `tool-output-schemas.ts` if
the file grows too large).

Example for `discover_data`:

```typescript
const discoverDataOutputSchema = z.object({
  refs: z.array(
    z.object({
      kind: discoverDataKindSchema,
      id: z.string(),
      score: z.number(),
      summary: z.string().nullable(),
      snippet: z.string().nullable(),
      matchedOn: z.enum(['name', 'display', 'description', 'comment', 'expr', 'sample_value', 'body']),
      connectionId: z.string().optional(),
      tableRef: z.object({ catalog: z.string().nullable(), db: z.string().nullable(), name: z.string() }).optional(),
      columnName: z.string().optional(),
    }),
  ),
});
```

#### 2.3 Per-field `.describe()` on every input

Anthropic's documented mechanism for fighting model drift, already used in
`memory_capture*`. Applied to every input field on every retained tool.
Highest leverage: `sl_query`, `entity_details`, `dictionary_search`,
`sql_execution`, `memory_ingest`. Tool-level `description` strings are
rewritten to be longer with one concrete example shape inlined (the technique
that fixed `order_by` model drift in this session).

#### 2.4 In-band error wrapping in `registerParsedTool`

Per MCP spec, tools return handler/runtime errors as `isError: true` + text
content, not JSON-RPC errors. Move the try/catch into the `registerParsedTool`
helper so every tool consistently surfaces handler exceptions as
`jsonErrorToolResult`. `sql_execution`'s local try/catch is removed (the
helper handles it).

**Scope — what becomes in-band vs. what stays JSON-RPC.** The MCP SDK
pre-validates incoming arguments against the registered `inputSchema` before
the tool callback runs, and surfaces validation failures as
`McpError(InvalidParams)` / JSON-RPC errors
(`@modelcontextprotocol/sdk/dist/esm/server/mcp.js` `validateToolInput`,
~line 166). KTX cannot intercept those without forking the SDK and we will not.
Therefore:

- Schema-validation failures on input → remain JSON-RPC `InvalidParams` errors,
  emitted by the SDK before our handler runs. This is the documented MCP
  behavior; clients already handle it.
- Handler exceptions, port/driver errors, and any post-validation runtime
  errors thrown inside the tool body → wrapped in-band as
  `{ isError: true, content: [{ type: 'text', ... }] }` by
  `registerParsedTool`'s catch.
- The redundant `inputSchema.parse(input)` inside `registerParsedTool` may be
  kept as defense-in-depth (e.g., for the rare path where the SDK was given a
  raw shape and a downstream change loosens validation) or removed; either is
  acceptable. If kept, parse failures here are wrapped in-band as well, but in
  practice they are unreachable for valid SDK registrations because the SDK
  has already parsed against the same schema.

```typescript
function registerParsedTool<TInput extends z.ZodType, TOutput extends z.ZodType>(
  server: KtxMcpServerLike,
  name: string,
  config: { title: string; description: string; inputSchema: unknown; outputSchema?: unknown; annotations: ToolAnnotations },
  inputSchema: TInput,
  handler: (input: z.infer<TInput>) => Promise<KtxMcpToolResult>,
  outputSchema?: TOutput,
): void {
  server.registerTool(name, { ...config, outputSchema: outputSchema ? outputSchema : undefined }, async (input) => {
    try {
      return await handler(inputSchema.parse(input));
    } catch (error) {
      return jsonErrorToolResult(formatToolError(error));
    }
  });
}
```

A small `formatToolError` helper renders Zod errors with `path: message` lines
and falls through to `error.message` / `String(error)` for non-Zod cases.

Acceptance tests in §Verification must therefore split the error path:

- Bad input shape (rejected by SDK pre-validation) → expect a thrown
  `McpError`/`InvalidParams` JSON-RPC error, not `isError: true`.
- Handler-thrown / port-thrown error (e.g., unknown `connectionId`, driver
  failure) → expect `{ isError: true, content: [{ type: 'text', ... }] }`.

#### 2.5 Union-drift normalization

Apply the same `z.preprocess` pattern used for `order_by` to the two remaining
at-risk unions:

**`slQueryDimensionSchema`** — accept `{ dimension, granularity }` (Cube
convention) as an alias for `{ field, granularity }`. Bare strings continue to
work unchanged.

```typescript
const slQueryDimensionSchema = z.preprocess(
  (value) => {
    if (typeof value === 'string') return { field: value };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = { ...(value as Record<string, unknown>) };
      if (!('field' in obj) && typeof obj.dimension === 'string') obj.field = obj.dimension;
      return obj;
    }
    return value;
  },
  z.object({
    field: z.string().min(1).describe('Dimension to group by, e.g. "orders.created_at" or a SL dimension key.'),
    granularity: z.string().min(1).optional().describe('Time granularity for time dimensions: day, week, month, quarter, year.'),
  }),
);
```

**`entityDetailsTableRefSchema`** — accept `{ schema, table }` (BigQuery /
SQL-style convention) as an alias for `{ db, name }`. Today's schema requires
`catalog`, `db`, and `name` (`packages/context/src/mcp/context-tools.ts:169`),
so the alias path must also default `catalog` to `null` to satisfy the
validator. Either of the two equivalent shapes below is acceptable; the
implementation plan picks one:

1. Make `catalog` (and `db`) `.nullable().default(null)` so the alias path
   doesn't have to set them, and bare `{ schema, table }` is accepted with
   `catalog === null`, `db === schema`, `name === table`.
2. Have the preprocess unconditionally fill missing `catalog`/`db` with `null`.

Acceptance criterion: a tool call with `{ table: { schema: "public", table: "orders" } }` parses successfully and resolves to `{ catalog: null, db: "public", name: "orders" }`. Existing callers passing `{ catalog, db, name }` continue to work unchanged.

```typescript
const entityDetailsTableRefSchema = z.preprocess(
  (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = { ...(value as Record<string, unknown>) };
      if (!('db' in obj) && typeof obj.schema === 'string') obj.db = obj.schema;
      if (!('name' in obj) && typeof obj.table === 'string') obj.name = obj.table;
      if (!('catalog' in obj)) obj.catalog = null;
      return obj;
    }
    return value;
  },
  z.object({
    catalog: z.string().nullable().describe('Catalog/project (BigQuery project, Snowflake database). null when not applicable.'),
    db: z.string().nullable().describe('Schema/database for the table. null when not applicable.'),
    name: z.string().min(1).describe('Table name.'),
  }),
);
```

`slQueryMeasureSchema` is **not** changed — bare strings cover the common case
and `{ expr, name }` matches Cube's measure-with-alias convention; no observed
drift.

#### 2.6 Type-narrow `jsonToolResult`

The goal is to forbid arrays at compile time without breaking the existing
`interface`-typed response shapes (e.g. `KtxKnowledgeSearchResponse` in
`packages/context/src/mcp/types.ts`). `Record<string, unknown>` is **not**
acceptable as the constraint because TypeScript interfaces without an index
signature are not assignable to it; using it would cause widespread compile
failures on valid object responses.

Use a non-array object constraint instead, e.g.:

```typescript
type NonArrayObject = object & { length?: never };

export function jsonToolResult<T extends NonArrayObject>(
  structuredContent: T,
): KtxMcpToolResult<T> { ... }
```

Acceptance criteria:

- A bare array literal at a call site fails to type-check (catches the
  `discover_data` bug class).
- Every existing `interface`-typed response (`KtxKnowledgeSearchResponse`,
  `KtxSemanticLayerQueryResponse`, `KtxSqlExecutionResponse`,
  `KtxEntityDetailsResponse`, `KtxDictionarySearchResponse`,
  `KtxDiscoverDataResponse`, `KtxConnectionTestResponse`,
  `KtxSemanticLayerReadResponse`, `KtxSemanticLayerListResponse`,
  `KtxKnowledgePage`, memory capture/status response shapes) continues to
  type-check at every existing `jsonToolResult` call site without modification.

Implementation plan can substitute an equivalent narrowing if it is more
idiomatic; the contract is "no arrays, no breaking interface assignability."
Pure defensive type change; no runtime effect on current code.

#### 2.7 Enforce the `toResolvedWire` invariant

Add a doc comment on `KtxSemanticLayerComputePort.query` and
`.validateSources` stating that callers must pass `toResolvedWire`-sanitized
sources to prevent the daemon `usage`-leak bug from regressing if a new code
path bypasses `SemanticLayerService`.

The doc comment alone is not sufficient — there is already an unsanitized
caller. `loadComputableSources` in
`packages/context/src/mcp/local-project-ports.ts` (~line 311) parses YAML and
pushes the raw record into `validateSources`
(`packages/context/src/mcp/local-project-ports.ts:586`). It must be brought into
conformance by sanitizing each record with `toResolvedWire` before handing it
to `validateSources`, mirroring the existing sanitization in
`packages/context/src/sl/local-query.ts:76`. Acceptance criterion: every
`KtxSemanticLayerComputePort.query` and `.validateSources` call site in the
repo passes `toResolvedWire`-sanitized records, verified by code review and
covered by the existing `local-query.test.ts` / `local-project-ports.test.ts`
tests for the relevant paths. Note that `sl_validate` is removed from MCP
registration (§1.2) but the underlying port keeps backing the CLI, so the
invariant must hold for the CLI path too.

#### 2.8 Progress notifications — `sql_execution` + `sl_query`

Per MCP spec, the caller may include `params._meta.progressToken` in the
request; the server emits `notifications/progress` with `{ progressToken,
progress, total?, message }` at stage transitions.

`KtxSqlExecutionMcpPort.execute` and `KtxSemanticLayerMcpPort.query` are
extended with an optional `onProgress?: (event: { progress: number; total?: number; message: string }) => void` parameter. The MCP tool handlers wire
`onProgress` to the SDK's notification channel via the handler-context object
passed by `server.registerTool`. Non-progress-supporting clients ignore the
events.

Emitted stages:

- `sql_execution`: `"Validating SQL"` (progress 0.0) → `"Executing"` (0.3) → `"Fetched N rows"` (1.0).
- `sl_query`: `"Compiling query"` (0.0) → `"Generating SQL"` (0.3) → `"Executing"` (0.6) → `"Fetched N rows"` (1.0).

Progress emission is best-effort; if the underlying port can't report a stage
boundary (e.g., a driver doesn't expose progress callbacks), the stage is
simply skipped.

`memory_ingest` does not emit progress — `runId` + `memory_ingest_status`
polling is the documented async pattern for it.

### 3. `ktx-analytics` SKILL.md refinements

File: `packages/cli/src/skills/analytics/SKILL.md`.

**Step 7 rewrite** (current vs. new):

Current:

> 7. **Capture durable learnings** - at the end of the turn, call `memory_capture` when the investigation produced reusable business context, metric definitions, or schema knowledge.

New:

> 7. **Capture durable learnings** - call `memory_ingest` whenever a turn produces something worth remembering (business rules, metric definitions, schema gotchas, recurring findings) **or** whenever the user asks you to remember something. Pass markdown in `content` including any source context the memory agent should weigh. Each call is a feedback loop — better notes today mean smarter `discover_data` and `wiki_search` results tomorrow.

**Tool-name updates** throughout: every `memory_capture` reference becomes
`memory_ingest`.

**Multi-connection rule** added under `<rules>` — phrased to match the §1.1
connection matrix so the agent does not over-scope unscoped tools:

> When `connection_list` shows multiple connections, pass an explicit
> `connectionId` to every tool that takes one **and where user intent pins a
> specific warehouse**. The matrix is:
>
> - **Required:** `entity_details`, `sl_read_source`, `sql_execution`.
> - **Required when user intent is warehouse-specific (including any wording
>   like "in our warehouse" / "this warehouse"):** `memory_ingest` — without
>   `connectionId`, the memory agent cannot update the semantic layer and the
>   knowledge will land as wiki-only.
> - **Pass when intent pins a warehouse, otherwise omit for unscoped
>   discovery:** `sl_query`, `discover_data`, `dictionary_search`.
> - **Never pass `connectionId` (the tool does not accept one):**
>   `connection_list`, `wiki_search`, `wiki_read`, `memory_ingest_status`.
>
> If intent is ambiguous for a required-or-scoped tool, ask the user which
> warehouse before calling — do not guess.

**One new worked example** demonstrating user-driven ingest:

> **Input:** "Heads up — ARR is always reported in cents in our warehouse."
>
> **Workflow:**
> 1. If multiple connections, call `connection_list` and pick the warehouse the
>    user means (asking if ambiguous). Pass its id as `connectionId` so the
>    memory agent can update the semantic layer, not just the wiki.
> 2. `memory_ingest({ connectionId: "<warehouse-id>", content: "ARR is reported in cents (not dollars) in this warehouse. Multiply by 0.01 for dollar amounts. Source: user clarification." })` — no analysis turn; just remember.

The existing Discover → Inspect → Resolve → Plan → Query → Validate → Capture
workflow stays. The existing two examples are updated only to reflect the
`memory_capture` → `memory_ingest` rename.

## Migration / sequencing

Three landings, each independently mergeable, in this order:

### PR 1 — Surface change (atomic)

- Remove the 14 admin tools from `registerKtxContextTools` (conditional
  registration blocks deleted).
- Rename `memory_capture` → `memory_ingest`, `memory_capture_status` →
  `memory_ingest_status`. Rename `MemoryCapturePort` → `MemoryIngestPort`,
  `MemoryCaptureService` → `MemoryIngestService`. Update the new tool's input
  contract per §1.3.
- Update `packages/context/src/mcp/local-project-ports.ts` and
  `packages/context/src/mcp/server.ts` to reflect the renames and the dropped
  ports.
- Update `packages/cli/src/skills/analytics/SKILL.md` per §3 in the same
  diff.
- Update all tests for the removed/renamed tools.
- Update `docs-site/content/docs/integrations/agent-clients.mdx` to replace
  the existing "memory capture" wording (currently at line ~90) with
  "memory ingest". This update is unconditional — the file already names the
  tool family.
- Update `packages/cli/src/mcp-server-factory.ts` and
  `packages/cli/src/text-ingest.ts` (plus their tests) to reflect the
  `MemoryCapture*` → `MemoryIngest*` rename. Both files import
  `createLocalProjectMemoryCapture` and use a `memoryCapture` variable, so the
  rename does cross the CLI boundary even though the tool surface used by the
  CLI is unchanged. Re-export rename in `packages/context/src/memory/index.ts`
  is part of this PR.

The CLI's runtime use of the removed admin-tool implementations is unchanged —
only the memory rename touches CLI code.

### PR 2 — Polish kit

Touches all 11 retained tools. Can be one PR or split per family
(annotations + outputSchema + descriptions + error wrapping + union-drift
fixes + `jsonToolResult` type narrowing + `toResolvedWire` doc comment).

### PR 3 — Progress notifications

Extends `KtxSqlExecutionMcpPort` and `KtxSemanticLayerMcpPort` with optional
`onProgress`, wires the MCP handler context's notification channel, emits at
the stage boundaries listed in §2.8.

Eventual **deletion** of the 14 admin tool implementations is a separate
follow-up spec gated on the `ktx-admin` SKILL landing. Until then they remain
in `packages/context/src/` and are used only by the CLI.

## Verification

### Unit tests per retained tool

For each of the 11 retained tools:

- Input schema accepts canonical input.
- Input schema accepts each documented normalized alt-shape (Cube
  `{ dimension, granularity }`, `{ schema, table }`, bare-string `order_by`,
  Cube-style `{ id, desc }` `order_by`).
- Output schema accepts the response shape returned by the underlying port.
- Error path returns `{ isError: true, content: [{ type: 'text', ... }] }`
  (not a thrown exception).

### Schema snapshot test

A `tools/list` snapshot test in `packages/context/src/mcp/server.test.ts`
captures the exact JSON Schema each client receives for every tool. Re-runs
across PRs catch accidental schema drift (e.g., a Zod change silently
broadening the contract).

### Annotations test

Assert every tool's registered config carries the expected `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`, and `title` per §2.1.

### Multi-client end-to-end smoke

Stdio (Claude Desktop) and Streamable HTTP (Claude Code) are the two
transports; the other four clients (Codex, Cursor, OpenCode, universal) share
one of these transports and their config files are static. Spin up `ktx mcp
stdio` and `ktx mcp start`, call each retained tool through both transports,
verify response shape against `outputSchema`.

### Required commands

The named test files include slow tests that are excluded from the default
`@ktx/context` `test` script and live in `test:slow`
(`packages/context/package.json:127-128`). Implementation must run both:

```bash
pnpm --filter @ktx/context run test
pnpm --filter @ktx/context run test:slow
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/cli run test
pnpm run dead-code
```

CLI checks are required because PR 1 renames cross the CLI boundary
(`packages/cli/src/mcp-server-factory.ts`, `packages/cli/src/text-ingest.ts`,
the `MemoryCapture*` re-exports, plus their vitest specs).
`pnpm --filter @ktx/cli run test:slow` should also be added if PR 1 ends up
touching any of the slow-test files enumerated in `packages/cli/package.json`
(`scan.test.ts`, `setup*.test.ts`, etc.); the rename diff today does not, but
the implementation plan must re-check before merging.

When `docs-site/content/docs/integrations/agent-clients.mdx` is touched, also
run the docs-site scripts declared in `docs-site/package.json` — there is no
`lint` script:

```bash
pnpm --filter ktx-docs run build
pnpm --filter ktx-docs run test
```

### Red-green regression

For the union-drift fixes (§2.5): revert the preprocess in `local-query.ts` or
`context-tools.ts`, run the alt-shape test → expect failure, restore →
expect pass. Same pattern as the `order_by` and `usage`-leak fixes in this
session.

## Risks

- **Removed tools surprise a user who depended on them via MCP.** Mitigated
  by the no-back-compat rule (KTX is pre-public) and by the SKILL update
  landing atomically with the surface change. Users on `ktx setup --agents`
  flow get the updated SKILL the next time they re-run setup.
- **`outputSchema` validation breaks a client that doesn't tolerate
  unrecognized JSON Schema keywords.** Mitigated by emitting `outputSchema`
  via the same `server.registerTool` path that already produces `inputSchema`,
  so both schemas are serialized by the MCP SDK as JSON Schema 2020-12 (the
  dialect the SDK's tool-list types declare —
  `@modelcontextprotocol/sdk/.../types.js` `inputSchema` / `outputSchema`
  fields, and Appendix B). The spec uses SHOULD-validate semantics, not MUST.
  The snapshot test catches drift; the multi-client smoke confirms
  compatibility.
- **Progress notifications increase notification volume for clients that
  poll.** Mitigated by stage-based emission (3-4 events per call max). Clients
  that don't support progress simply ignore the events.
- **Renaming `MemoryCapturePort`/`MemoryCaptureService` cascades through
  internal callers.** Cascade is bounded to `packages/context/src/memory/`,
  `packages/context/src/mcp/`, and their tests; type-checker catches missed
  call sites.

## Open Questions

None at design time. Open items for the implementation plan:

- Final wording for the rewritten tool descriptions on `discover_data`,
  `entity_details`, `dictionary_search`, `sl_read_source`, `sl_query`,
  `sql_execution`. (Drafts can be authored during PR 2.)
- Whether `formatToolError` should redact path elements for security
  (probably not — these are local-only MCP servers, and the existing error
  shape doesn't redact).
- Whether to split PR 2 into per-family sub-PRs or keep it monolithic. Default
  is monolithic since the polish-kit changes touch the same files and tests.

## Appendix A — File map

| Change | File |
|---|---|
| Tool registration removed (14 tools) | `packages/context/src/mcp/context-tools.ts` |
| Memory rename + route memory_ingest tools through the shared polish path (§2.0) | `packages/context/src/mcp/server.ts`, `packages/context/src/mcp/context-tools.ts`, `packages/context/src/memory/*` |
| Local ports update | `packages/context/src/mcp/local-project-ports.ts` |
| Port types update | `packages/context/src/mcp/types.ts` |
| Annotations, outputSchema, describe, error wrapping, union preprocess | `packages/context/src/mcp/context-tools.ts` |
| `jsonToolResult` type narrowing | `packages/context/src/mcp/context-tools.ts` |
| `toResolvedWire` invariant comment | `packages/context/src/daemon/semantic-layer-compute.ts` |
| Progress callback plumbing | `packages/context/src/daemon/semantic-layer-compute.ts`, `packages/context/src/sl/local-query.ts`, `packages/context/src/mcp/local-project-ports.ts` (`executeValidatedReadOnlySql`) |
| Tests | `packages/context/src/mcp/server.test.ts`, `packages/context/src/mcp/local-project-ports.test.ts`, `packages/context/src/sl/local-query.test.ts` |
| Skill | `packages/cli/src/skills/analytics/SKILL.md` |
| Docs | `docs-site/content/docs/integrations/agent-clients.mdx` |

## Appendix B — MCP-spec cross-reference

- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`, `title`): MCP 2025-11-25 spec `/schema` "ToolAnnotations".
- `outputSchema` with `structuredContent` SHOULD-validate: spec
  `/server/tools` "Tool Result > Structured Content".
- In-band error contract (`isError: true` + text content, not JSON-RPC
  error): spec `/server/tools` "Tool Execution Error Example".
- Progress notifications via `params._meta.progressToken` →
  `notifications/progress`: spec `/basic/utilities/progress`.
- `inputSchema.type: "object"` requirement and JSON Schema 2020-12 default
  dialect: spec `/server/tools` "Tool > inputSchema" and SEP 1613.
