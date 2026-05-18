# DuckDB Support Design

**Date:** 2026-05-18
**Status:** Design - pending implementation plan

## Goal

Add first-class DuckDB support to standalone KTX for local, path-backed DuckDB
database files. The v1 experience must let users configure `driver: duckdb`,
test the connection, ingest database structure, run `ktx sql`, execute MCP SQL
tools, and execute semantic-layer queries with `ktx sl query --execute`.

DuckDB support should feel like the existing SQLite local-file path: no external
service is required, KTX must not create missing databases by accident, and all
agent-facing SQL execution stays read-only.

## Current State

- `packages/context/src/project/driver-schemas.ts` rejects `driver: duckdb`.
- `packages/cli/src/local-scan-connectors.ts` has no DuckDB connector factory.
- `packages/cli/src/local-adapters.ts` has no DuckDB live-introspection branch,
  so an unrecognized DuckDB connection would fall through to daemon-side
  database introspection, which remains Postgres-only.
- `packages/cli/src/connection.ts` and its tests currently treat DuckDB as an
  unsupported native driver.
- `packages/cli/src/sql.ts` validates unknown drivers as Postgres because
  `sqlAnalysisDialectForDriver()` has no DuckDB entry.
- `packages/context/src/scan/types.ts`,
  `packages/context/src/scan/local-scan.ts`, and
  `packages/context/src/connections/dialects.ts` all have closed driver sets
  that currently reject or throw for `duckdb`.
- `packages/context/src/connections/connection-type.ts` has no `DUCKDB` enum
  value, and `local-warehouse-descriptor.ts` has no `duckdb` driver mapping.
- `packages/context/src/connections/local-query-executor.ts` only dispatches
  local semantic-layer execution to Postgres and SQLite.
- Some semantic-layer and MCP maps already recognize `DUCKDB`, but the runtime
  path cannot work until config parsing, connector creation, and local query
  execution know how to open DuckDB files.
- Python semantic-layer generation already accepts sqlglot dialects, and local
  guidance explicitly lists `duckdb`; implementation should strengthen tests
  instead of introducing a separate SQL generation path.

## Scope

### In Scope

- Local DuckDB database files referenced by `connections.<id>.path` or
  `connections.<id>.url`.
- A new `@ktx/connector-duckdb` package under `packages/connector-duckdb`.
- Read-only connection tests, schema introspection, table sampling, column
  sampling, distinct-value helpers, row counts, and read-only SQL execution.
- Core config, connection-type, dialect, local-warehouse descriptor, scan, MCP,
  and semantic-layer query-executor wiring for `duckdb`.
- CLI setup, connection test, ingest, SQL, MCP, and `ktx sl query --execute`
  support.
- Package registry and release artifact updates so DuckDB ships with the public
  CLI package.
- Native dependency installation behavior for `@duckdb/node-api` across the KTX
  supported platform matrix, including user-facing missing-binary or
  unsupported-platform guidance before raw native-loader errors surface.
- Docs for setup, primary-source integrations, SQL execution, and connection
  behavior.
- Targeted sqlglot tests proving DuckDB dialect validation and semantic-layer
  SQL generation parse correctly as `duckdb`.

### Non-Goals

- In-memory DuckDB connections such as `:memory:`.
- Creating a DuckDB file when the configured file is missing.
- Treating DuckDB table functions such as `read_parquet()` or `read_csv()` as
  primary KTX warehouse tables.
- DuckDB query-history ingestion. V1 live-database ingest is schema and sample
  based only.
- Daemon-side DuckDB database introspection. The existing Python daemon
  introspection path remains Postgres-only.
- Looker warehouse mapping changes for DuckDB unless a later task explicitly
  asks for that surface.

## Architecture

Use the existing SQLite connector shape as the primary model because DuckDB v1 is
also a local file connector with no network credentials. The new connector owns
all DuckDB-specific file resolution, native driver use, metadata SQL, quoting,
sampling, and result normalization.

Use DuckDB's current Node client, `@duckdb/node-api`, rather than the older
`duckdb` package. The design should keep the native dependency isolated inside
`@ktx/connector-duckdb` so other packages only depend on KTX interfaces. In
particular, `@ktx/context` must not import `@duckdb/node-api` or add it as a
runtime dependency.

KTX core remains the product-level source of truth for driver recognition:
schemas, dialect aliases, connection type normalization, scan-driver
normalization, MCP dialect resolution, and the local semantic-layer query
executor port belong in `@ktx/context`. The CLI should wire commands to those
ports and load the connector dynamically, including supplying the DuckDB query
executor implementation from `@ktx/connector-duckdb` when execution is needed.

The Python semantic layer should continue to generate Postgres-shaped SQL
internally and transpile through sqlglot at the final dialect boundary. DuckDB
support here is a testing and dialect-plumbing task, not a new SQL generator.

## Components

### `@ktx/connector-duckdb`

Add package files matching other connector packages:

- `packages/connector-duckdb/package.json`
- `packages/connector-duckdb/tsconfig.json`
- `packages/connector-duckdb/src/index.ts`
- `packages/connector-duckdb/src/connector.ts`
- `packages/connector-duckdb/src/dialect.ts`
- `packages/connector-duckdb/src/live-database-introspection.ts`
- focused tests and fixtures for a small `.duckdb` database

Test fixtures should generate the `.duckdb` database at test setup time with the
same `@duckdb/node-api` version under test. Do not commit a binary `.duckdb`
fixture unless the DuckDB package version is pinned and the fixture regeneration
path is documented.

Public exports should mirror the SQLite naming pattern with DuckDB-specific
symbols:

- `KtxDuckDbScanConnector`
- `KtxDuckDbDialect`
- `isKtxDuckDbConnectionConfig`
- `duckDbDatabasePathFromConfig`
- `createDuckDbQueryExecutor`
- `createDuckDbLiveDatabaseIntrospection`

The connector config shape should be intentionally small:

```yaml
connections:
  warehouse:
    driver: duckdb
    path: data/warehouse.duckdb
```

`url` is supported for file-style paths to align with existing warehouse config,
but local `path` should be the recommended docs shape.

### Core Context

Update the shared driver and dialect surfaces:

- `packages/context/src/project/driver-schemas.ts`
- `packages/context/src/scan/types.ts`
- `packages/context/src/scan/local-scan.ts`
- `packages/context/src/connections/connection-type.ts`
- `packages/context/src/connections/dialects.ts`
- `packages/context/src/connections/local-warehouse-descriptor.ts`
- `packages/context/src/connections/local-query-executor.ts`
- `packages/context/src/mcp/local-project-ports.ts`
- `packages/context/src/sl/local-query.ts`
- `packages/context/src/sl/semantic-layer.service.ts`

The default local query executor must dispatch DuckDB separately from SQLite
through an explicit `duckdb?: KtxSqlQueryExecutorPort` option on
`DefaultLocalQueryExecutorOptions`. The DuckDB implementation for that slot
lives in `@ktx/connector-duckdb`; if no DuckDB executor is supplied, the context
default should fail with the same unsupported-driver style it uses today rather
than importing the native module directly. Any shared path-resolution behavior
must live in `@ktx/connector-duckdb` or in dependency-free context helpers that
do not depend on `@duckdb/node-api`.

The scan and dialect driver sets must be extended explicitly:

- `KtxConnectionDriver` includes `duckdb`.
- `normalizeDriver()` and supported-driver error text in
  `packages/context/src/scan/local-scan.ts` accept `duckdb`.
- `SupportedDriver`, `supportedDrivers`, and `getDialectForDriver()` in
  `packages/context/src/connections/dialects.ts` accept `duckdb`.

Connection-type normalization must be explicit:

- `connectionTypeSchema` gains `DUCKDB`.
- `DRIVER_TO_CONNECTION_TYPE` maps `duckdb` to `DUCKDB`.
- `localConnectionToWarehouseDescriptor()` returns a non-null descriptor for
  DuckDB, so MCP and semantic-layer paths receive `DUCKDB` instead of a lowercase
  fallback driver string.

### CLI

Update CLI command wiring and setup surfaces:

- `packages/cli/src/local-scan-connectors.ts`
- `packages/cli/src/local-adapters.ts`
- `packages/cli/src/connection.ts`
- `packages/cli/src/sql.ts`
- `packages/cli/src/ingest-query-executor.ts`
- `packages/cli/src/setup-databases.ts`
- `packages/cli/src/commands/setup-commands.ts`
- `packages/cli/src/ingest-depth.ts`
- `packages/cli/src/status-project.ts`
- CLI package dependencies in `packages/cli/package.json`

`ktx sql` must pass `duckdb` to the SQL analysis daemon instead of falling back
to Postgres. `ktx connection test`, scan, ingest, MCP startup, and semantic-layer
execution should all use the same configured connection shape.

`ktx sl query --execute` must supply a DuckDB-capable query executor from the
CLI layer, either by reusing the connector-backed ingest query executor or by
injecting `createDuckDbQueryExecutor()` into the context default executor's
DuckDB slot. Do not satisfy semantic-layer DuckDB execution by adding
`@duckdb/node-api` to `@ktx/context`.

`packages/cli/src/local-adapters.ts` must create a DuckDB live-database
introspection adapter and dispatch DuckDB connections to it before the daemon
fallback. No DuckDB live-database ingest path may invoke
`createDaemonLiveDatabaseIntrospection()`, because daemon-side database
introspection remains outside v1 scope.

### Packaging And Docs

Update public package and artifact scripts:

- `scripts/build-public-npm-package.mjs`
- `scripts/package-artifacts.mjs`
- script tests that assert connector package lists

Update user-facing docs where DuckDB changes behavior:

- root `README.md`
- `docs-site/content/docs/integrations/primary-sources.mdx`
- `docs-site/content/docs/cli-reference/ktx-setup.mdx`
- CLI reference docs for connection and SQL commands if present
- contributor/package-layout docs that enumerate connector packages

`@duckdb/node-api` distributes platform-specific prebuilt binaries as optional
dependencies for Linux glibc/musl, macOS Apple Silicon/Intel, and Windows
arm64/x64. DuckDB native install handling should therefore be platform and
optional-binary based, not a `NODE_MODULE_VERSION` ABI or `pnpm rebuild` flow
like the existing `better-sqlite3` path.

Record the supported platform matrix in docs or tests. At `ktx setup`,
`ktx connection test`, `ktx ingest`, and other first-use entry points, verify
that the host platform is covered and that the optional DuckDB binary can be
loaded. Unsupported platforms or missing optional dependency packages should
produce a friendly `@duckdb/node-api` platform-not-supported or missing-binary
message with the current OS/arch/libc where available. Raw native-loader errors
should not be the first user-facing failure mode.

## DuckDB Connector Behavior

The connector must resolve database files before opening DuckDB:

- Accept `path` or `url`.
- Resolve relative paths against the KTX project directory.
- Resolve `env:` references consistently with existing local connectors.
- Treat non-URL `file:` references in `path` as a file containing the referenced
  path, matching the SQLite convention.
- Treat `file:` values in `url` as database file URLs.
- Reject empty, in-memory, missing, directory, and non-file targets before
  opening the native DuckDB connection.

The pre-open filesystem check is unconditional and primary. Before every native
DuckDB open, KTX must resolve the configured database path, verify that it
already exists, and verify that it is a regular file. `access_mode=READ_ONLY` or
an equivalent native option is defense-in-depth on top of that check, not a
substitute for it. Every agent-facing SQL call must also run
`assertReadOnlySql()` before execution.

Schema introspection should use DuckDB metadata tables rather than parsing SQL:

- tables and views from `information_schema.tables`
- columns from `information_schema.columns`
- primary keys and foreign keys from DuckDB's native constraint catalog, such as
  `duckdb_constraints()` or an equivalent pragma exposed by the client, so
  foreign-key source and referenced column pairs are populated reliably
- estimated row counts from `COUNT(*)` for regular tables, matching SQLite's
  current local behavior

Do not rely solely on `information_schema.referential_constraints` for foreign
keys. It can identify constraints without enough per-column mapping data for the
KTX `KtxSchemaForeignKey` shape. The connector should only advertise
`formalForeignKeys: true` when it populates those column pairs.

The resulting `KtxSchemaSnapshot` should preserve catalog/schema fields when
DuckDB exposes them and keep table names stable for downstream KTX YAML and
semantic-layer generation.

## SQLGlot And Semantic Layer

Do not add a DuckDB-specific SQL generator. Keep the existing semantic-layer
rule: generate Postgres-shaped SQL internally, then transpile with sqlglot at the
final dialect boundary.

Implementation should explicitly cover these dialect paths:

- `packages/cli/src/sql.ts` maps `duckdb` to the SQL analysis dialect `duckdb`.
- MCP SQL execution maps configured DuckDB connections to `duckdb`.
- `ktx sl query --execute` compiles with the semantic-layer DuckDB dialect and
  executes through the DuckDB local query executor.
- Python tests parse or validate generated semantic-layer SQL with
  `read="duckdb"` where appropriate.
- Python SQL analysis tests validate read-only detection for DuckDB SQL.

Table-identifier parsing for external tools should not be broadened as part of
v1 unless the implementation also handles DuckDB table functions safely. A
future Looker-to-DuckDB task can decide how to handle functions such as
`read_parquet()`.

## Error Handling

DuckDB errors should be direct and actionable:

- missing config: `connections.<id>.path or url is required`
- missing file: `File not found: <path>`
- directory target: `Expected a DuckDB database file, got directory: <path>`
- unsupported in-memory target: `DuckDB in-memory connections are not supported`
- unsupported driver factory: supported-driver lists include DuckDB after this
  change
- non-read-only SQL: preserve the existing read-only validation error style

No command should silently create a DuckDB database. This is the main safety
property for v1.

## Testing

Add or update focused tests before broad verification:

- `packages/connector-duckdb` tests for connection config recognition, path/url
  resolution, missing-file rejection, schema introspection, table sampling,
  column sampling, distinct values, row counts, read-only SQL execution, and
  non-read-only SQL rejection. Include a missing-path test that proves no
  `.duckdb` file is created. Include native-loader tests or dependency-injected
  loader tests covering unsupported-platform and missing optional-binary errors.
- `packages/context` tests for driver schema parsing, dialect maps, connection
  type normalization, local warehouse descriptors, MCP dialect mapping, and
  local semantic-layer query execution dispatch. Include assertions that DuckDB
  maps to `DUCKDB` for local warehouse descriptors and to `duckdb` for MCP and
  semantic-layer dialect resolution, and that DuckDB execution is dispatched
  only when a `duckdb` query executor slot is supplied.
- `packages/cli` tests for local scan connector creation, setup database
  choices, connection testing, `ktx sql` dialect validation, ingest query
  executor wiring, and MCP SQL execution against a generated DuckDB fixture.
  Include a `ktx ingest <id>` path test proving DuckDB uses the native
  local-adapters introspection branch without invoking the daemon introspection
  client.
- Release/script tests that assert the connector package list.
- Python semantic-layer tests for DuckDB sqlglot generation and parseability.
- Python daemon SQL-analysis tests for DuckDB read-only validation.

Expected verification after implementation:

```bash
pnpm --filter @ktx/connector-duckdb run test
pnpm --filter @ktx/context run test
pnpm --filter @ktx/cli run test
pnpm --filter './packages/*' run type-check
pnpm run dead-code
node --test scripts/build-public-npm-package.test.mjs scripts/package-artifacts.test.mjs scripts/examples-docs.test.mjs
uv run pytest python/ktx-sl/tests python/ktx-daemon/tests/test_sql_analysis.py -q
uv run pre-commit run --files <changed-python-files>
```

If no Python files change, the Python pre-commit command is not required.

## Acceptance Criteria

- A project with `driver: duckdb` and a valid local file path loads without
  config validation errors.
- `ktx setup` can create or preserve a DuckDB connection config.
- `ktx connection test <id>` succeeds for a valid fixture and fails cleanly for a
  missing path.
- `ktx ingest <id>` produces live-database context for DuckDB tables and views,
  with internal scan connector tests covering the schema snapshot, and does so
  through native DuckDB introspection instead of daemon-side database
  introspection.
- `ktx sql --connection <id> "select ..."` validates as DuckDB, executes
  read-only SQL, and returns rows.
- `ktx mcp` starts with a DuckDB connection configured, and MCP SQL execution
  can run read-only DuckDB queries.
- `ktx sl query --execute` compiles a semantic-layer query for DuckDB and
  executes it through the local DuckDB file.
- Non-read-only SQL is rejected before execution.
- Missing, directory, and in-memory DuckDB targets never create a database file.
- Missing `@duckdb/node-api` optional binaries and unsupported platforms fail
  with friendly DuckDB-specific guidance before raw native-loader output.
- DuckDB foreign keys are populated from native constraint metadata with source
  and referenced column pairs when formal foreign keys exist.
- Public docs and package/artifact lists include DuckDB support.
