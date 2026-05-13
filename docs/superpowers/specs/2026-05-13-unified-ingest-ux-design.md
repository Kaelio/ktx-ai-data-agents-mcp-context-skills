# Unified Ingest UX Design

**Date:** 2026-05-13
**Author:** Andrey Avtomonov
**Status:** Design — pending implementation plan

## Background

KTX currently exposes multiple user-facing ideas for one product action:
building context from configured connections. Database connections use
`ktx scan <connectionId>`, source connections use
`ktx ingest run --connection-id <id> --adapter <adapter>`, and setup uses a
context-build wrapper that plans database scans before source ingestion.

The implementation already points toward one concept. `ktx scan` runs a
stage-only ingest with the `live-database` adapter, then writes scan-specific
reports, schema manifests, and enrichment artifacts. `ktx setup` already
builds context from all configured connections by routing database connections
to scan internals and source connections to source-ingest internals.

The user-facing model must become simpler:

- Setup configures KTX.
- Ingest builds or refreshes context.
- Status explains readiness.

`scan`, `live-database`, and adapter selection are implementation details.

## Goals

The redesign makes `ktx ingest` the single public context-building command and
keeps the foreground experience rich, clear, and robust.

- Remove `ktx scan` as a normal external verb.
- Remove `live-database` from user-facing CLI help, output, docs, and
  `ktx.yaml`.
- Treat database schema ingest as mandatory baseline behavior for database
  connections.
- Keep slow AI-heavy database behavior explicit with `--deep`; keep fast,
  deterministic behavior explicit with `--fast`.
- Fold query-history ingestion into database connection ingest as an optional
  facet.
- Keep `ktx setup` guided. It stores defaults in `ktx.yaml` and uses the same
  foreground context-build engine as `ktx ingest`.
- Remove detach, attach, watch, resume, stop, and background context-build
  flows.
- Preserve a polished foreground progress view for TTY users and scriptable
  output for non-TTY and JSON users.

## Non-goals

This spec does not redesign the semantic-layer YAML format, the ingest bundle
agent loop, or warehouse verification tools.

- Do not remove the internal scan implementation if it remains the cleanest
  module boundary.
- Do not remove internal adapter/source keys in one large rename. User-facing
  terminology changes first; internal cleanup can follow where it reduces
  complexity.
- Do not make query-history ingestion mandatory.
- Do not make AI enrichment mandatory for database connections.
- Do not add `--fast` or `--deep` to top-level `ktx setup`.
- Do not preserve compatibility shims for old public `scan` or
  `ingest run --adapter live-database` usage unless an implementation plan
  explicitly chooses a short deprecation window.

## Public command model

`ktx ingest` becomes the direct command for building context from one
connection or all configured connections.

```bash
ktx ingest warehouse
ktx ingest warehouse --fast
ktx ingest warehouse --deep
ktx ingest warehouse --deep --query-history
ktx ingest warehouse --no-query-history
ktx ingest notion
ktx ingest --all
ktx ingest --all --deep
```

The command dispatches by connection driver:

- Database drivers run database ingest.
- Source drivers run source ingest.
- `--all` runs database ingest targets first, then source ingest targets.

The old `ktx ingest run --connection-id <id> --adapter <adapter>` command is
not the primary public interface. The implementation plan can either remove it
or move it under an advanced/debug namespace. Normal users configure and ingest
connections, not adapters.

`ktx scan` is no longer a documented public command. Database schema scanning
continues as an internal phase of database ingest.

## Database ingest depth

Database ingest always includes a schema baseline. The depth controls how much
extra work KTX may perform.

### Fast

`--fast` means KTX builds deterministic schema context quickly.

- No LLM calls.
- No embeddings.
- No AI-generated descriptions.
- No expensive relationship discovery that depends on sampling, read-only SQL,
  or model calls.
- Introspect tables, columns, native types, comments, declared primary keys,
  and declared foreign keys when the connector can read them.
- Write or update database schema context that agents can use as grounding.
- Do not run query-history synthesis, because the current query-history path
  uses ingest work units and model-backed synthesis.

This is the safe default for new database connections, CI, smoke tests, and
large unknown warehouses.

### Deep

`--deep` means KTX builds richer database context and may use slower
capabilities.

- May use LLMs and embeddings when configured.
- May sample or query data through read-only connector capabilities.
- May generate table and column descriptions.
- May discover and validate relationships.
- May process query history into usage patterns when query history is enabled.

Deep mode is the best agent-readiness mode, but it can take longer and can
require model, embedding, and database permissions.

### Flag rules

`--fast` and `--deep` are mutually exclusive. Passing both is an error.

When neither flag is passed, `ktx ingest` uses the stored connection default.
If no default exists, database connections use `fast`.

If a depth flag is passed for a non-database source, KTX prints a warning and
continues:

```text
--deep affects database ingest only; ignoring it for notion.
```

For `--all`, KTX aggregates warnings instead of repeating noisy lines:

```text
--deep ignored for 2 non-database sources.
```

## Query history

Historic SQL becomes the database connection's query-history facet. The term
`historic-sql` remains an internal source key unless a later cleanup renames
it.

Query history is optional because it can require extra grants and can expose
sensitive SQL text. Setup asks about it only for database drivers that support
it.

```bash
ktx ingest warehouse --query-history
ktx ingest warehouse --no-query-history
ktx ingest warehouse --query-history-window-days 30
```

Query-history flags apply only to database connections that support the
feature. Non-applicable flags produce warnings and continue when the target
can otherwise be ingested.

Query history uses schema context as grounding. KTX must run the database
schema facet before query-history processing in the same ingest run. If a user
explicitly enables query history for a run, the output states that schema
ingest runs first.

Because query-history synthesis is model-backed in the current architecture,
`--query-history` upgrades the effective database depth to deep for that run.
KTX prints a warning when a user combines `--fast` with `--query-history`:

```text
--query-history requires deep ingest; running warehouse with --deep.
```

## Configuration model

User-authored `ktx.yaml` becomes connection-centric. Database schema ingest is
implied by the database connection and no longer appears as an ingest adapter.

```yaml
connections:
  warehouse:
    driver: postgres
    readonly: true
    context:
      depth: fast
      queryHistory:
        enabled: false

  notion:
    driver: notion
    context:
      enabled: true
```

Deep database defaults and query history use the same connection-local shape:

```yaml
connections:
  warehouse:
    driver: postgres
    readonly: true
    context:
      depth: deep
      queryHistory:
        enabled: true
        windowDays: 90
        minExecutions: 5
        serviceAccountPatterns:
          - "^svc_"
        redactionPatterns: []
```

`ingest.adapters` is no longer normal user config. The implementation plan can
remove it from generated config or keep it as an internal advanced override.
KTX must not require users to list `live-database` to ingest a database
connection.

## Setup flow

`ktx setup` remains a guided configuration flow. It does not expose
`ktx setup --fast` or `ktx setup --deep`.

During interactive setup, KTX asks for database context depth when a database
connection is configured or when setup reaches the context-build step:

```text
How much database context should KTX build?

Fast: schema only, no AI, quickest
Deep: richer context, may use AI and take longer
```

The recommended selection depends on readiness:

- Recommend Fast when model or embedding configuration is missing.
- Recommend Deep when model and embedding configuration are ready.

Setup stores the chosen default in `connections.<id>.context.depth`. The
foreground context build uses that stored default. Setup can still expose a
non-prominent automation flag later, such as `--context-depth fast`, if
headless setup needs it, but the main product surface is guided.

## Foreground progress UX

KTX keeps a rich foreground progress view. It removes detach and background
execution.

The shared build view groups work by user-facing source type:

```text
Building KTX context  (2/4 · 1m 12s)
───────────────────────────────────

Databases
  ✓ warehouse      42 tables · 6 changed · relationships found
  ⠹ billing        reading schema · 18/64 tables

Context sources
  ✓ dbt            18 models · 42 metrics
  ○ notion         queued

Warnings
  --deep ignored for notion; it only applies to database connections.
```

The view must not show `scan` or `live-database` in normal mode. It uses:

- `Databases` instead of `Primary sources`.
- `Context sources` for docs, BI, metrics, and modeling sources.
- `reading schema` or `building schema context` instead of `scanning`.
- `query history` or `usage patterns` instead of `historic-sql`.

Non-TTY output remains append-only and scriptable. `--json` returns structured
results. Routine artifact paths and internal adapter names appear only in
`--debug` or JSON output.

## Removing detach and watch

The context build is foreground only.

- `Ctrl+C` stops the current run.
- KTX records interrupted or failed state where useful for status reporting.
- Rerunning `ktx setup` or `ktx ingest` starts a fresh foreground build or
  reuses existing completed artifacts when safe.

Remove these user-facing concepts from context build:

- detach
- attach
- watch
- resume
- stop
- background context-build subprocesses
- prompts that offer "Watch progress"
- hints such as `d to detach`

Existing `running` or `detached` state from older versions must be treated as
stale or interrupted with a clear rerun instruction.

## Internal naming and migration

User-facing surfaces must stop saying `live-database`.

This includes:

- CLI help.
- Normal command output.
- Setup prompts.
- Generated `ktx.yaml`.
- README quickstart and examples.
- Friendly errors and warnings.

Internal paths and source keys can keep `live-database` during the first
implementation if renaming them would add risk. Debug output and JSON may
include internal names when they are necessary for troubleshooting.

The implementation plan must also update stale command suggestions. For
example, setup source recovery must no longer tell users to run
`ktx ingest run --connection-id ... --adapter <adapter>`. It must suggest the
new connection-centric command:

```bash
ktx ingest <connectionId>
```

## Error handling and warnings

Warnings are non-fatal when KTX can still perform the requested ingest.

- Ignored depth flag on a non-database source: warn and continue.
- Ignored query-history flag on an unsupported database: warn and continue if
  schema ingest can run.
- Both `--fast` and `--deep`: error before any work starts.
- Query-history requested without required grants: fail that query-history
  facet and keep schema results when schema ingest succeeded.
- Database schema ingest failure: fail that database target.

Failure messages focus on the connection and user action:

```text
warehouse failed: connection refused.
Retry: ktx ingest warehouse --deep
```

They do not mention internal adapter names unless debug output is enabled.

## Acceptance criteria

The implementation is complete when these conditions hold:

- `ktx ingest <connectionId>` works for database and source connections.
- `ktx ingest --all` runs database targets before source targets.
- `--fast` and `--deep` control database depth and are mutually exclusive.
- `ktx setup` stores a database context depth without exposing top-level
  `--fast` or `--deep`.
- Generated `ktx.yaml` does not include `live-database` for normal projects.
- Normal CLI help and output do not mention `live-database`.
- Normal CLI help and output do not present `scan` as a public verb.
- Query history is optional, connection-local, and overridable per ingest run.
- Context build has no detach, attach, watch, resume, stop, or background
  execution path.
- Existing setup context progress UX is consolidated with `ktx ingest` rather
  than duplicated.
- Non-TTY and JSON output remain suitable for scripts.

## Open implementation questions

The implementation plan must decide these lower-level details:

- Whether old `ktx scan` exits with an error, is hidden, or remains as a
  temporary undocumented debug command.
- Whether old `ktx ingest run --connection-id ... --adapter ...` is removed,
  hidden, or moved to `ktx dev ingest run`.
- Whether `ingest.adapters` is removed from config parsing or retained as an
  advanced override.
- Whether internal artifact paths keep `raw-sources/<connection>/live-database`
  for the first implementation.
- Whether setup needs a headless `--context-depth fast|deep` flag for CI.
