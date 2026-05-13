# Unified Ingest V1 Docs Site Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining public documentation surfaces that still present
`ktx scan`, adapter-backed `ktx ingest run`, `ktx ingest watch`,
`live-database`, or `Historic SQL` as normal v1 user workflows.

**Architecture:** Keep the implemented CLI behavior unchanged. Update the
Fumadocs content, example READMEs, and documentation regression tests so public
guidance uses connection-centric `ktx ingest <connectionId>`, `ktx ingest
--all`, `--fast`, `--deep`, `--query-history`, `ktx ingest status`, and
`ktx ingest replay`.

**Tech Stack:** Markdown, MDX frontmatter, Fumadocs page metadata, Node test
runner, pnpm workspace scripts.

---

## Current audit

The four implemented unified-ingest plans cover the CLI and setup v1 surface:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`,
  `--query-history`, `--no-query-history`, and
  `--query-history-window-days` route through `public-ingest.ts`.
- Database targets run before source targets, public source ingest bypasses
  adapter allow-lists, and public database ingest captures internal scan output.
- `ktx scan`, `ktx ingest run`, and `ktx ingest watch` are hidden from normal
  help.
- Setup stores `connections.<id>.context.depth`, writes
  `connections.<id>.context.queryHistory`, rejects reserved ingest ids, and
  uses foreground-only context-build state.

### V1-blocking gaps

- `docs-site/content/docs/cli-reference/ktx-ingest.mdx` still documents
  adapter-level `ktx ingest run`, `--adapter`, `ktx ingest watch`, and
  `live-database`.
- `docs-site/content/docs/cli-reference/ktx-scan.mdx` still presents
  `ktx scan` as a public command, and
  `docs-site/content/docs/cli-reference/meta.json` still publishes it in the
  CLI reference.
- `docs-site/content/docs/cli-reference/ktx-dev.mdx` still links to root
  `ktx scan` as a normal command.
- `docs-site/content/docs/guides/building-context.mdx` still has an adapter
  table that lists `historic-sql` and `live-database`, and it still documents
  `ktx ingest watch` as the visual progress path.
- `docs-site/content/docs/integrations/context-sources.mdx` still instructs
  users to run
  `ktx ingest run --connection-id <connectionId> --adapter <adapter>`.
- `docs-site/content/docs/concepts/context-as-code.mdx` still recommends
  scheduled
  `ktx ingest run --connection-id <id> --adapter <adapter> --no-input`.
- `docs-site/content/docs/getting-started/quickstart.mdx` still says setup
  runs structural/enriched scans, exposes Historic SQL flags, and describes
  detach/background context-build behavior.
- `docs-site/content/docs/integrations/primary-sources.mdx` still uses the
  legacy `historicSql` config shape and Historic SQL wording for supported
  query-history drivers.
- `examples/README.md` and `examples/local-warehouse/README.md` still present
  `ktx ingest run --adapter fake` as the example command.

### Non-blocking gaps

- Hidden debug commands can continue to call `ktx scan`,
  `ktx ingest run`, and `ktx ingest watch`.
- Internal source keys, raw artifact paths, tests, scripts, and developer-only
  package taxonomy can continue to use `scan`, `live-database`, and
  `historic-sql`.
- Contributor docs can continue to mention scan internals when describing
  package ownership or connector implementation details.
- The `examples/local-warehouse/ktx.yaml` fake adapter fixture can remain for
  CLI smoke tests if the public example docs stop recommending it as a normal
  user workflow.

## File structure

- Modify `scripts/examples-docs.test.mjs`: add regression assertions for
  docs-site and example README unified-ingest wording.
- Modify `docs-site/content/docs/cli-reference/ktx-ingest.mdx`: rewrite the
  page around the connection-centric public command.
- Delete `docs-site/content/docs/cli-reference/ktx-scan.mdx`: remove the
  public scan reference page.
- Modify `docs-site/content/docs/cli-reference/meta.json`: remove
  `ktx-scan` from published CLI reference pages.
- Modify `docs-site/content/docs/cli-reference/ktx-dev.mdx`: remove the
  root-scan link and clarify that database context is built by `ktx ingest`.
- Modify `docs-site/content/docs/guides/building-context.mdx`: remove
  adapter tables and live watch guidance; describe status/replay only.
- Modify `docs-site/content/docs/integrations/context-sources.mdx`: replace
  adapter-backed ingest commands with `ktx ingest <connectionId>`.
- Modify `docs-site/content/docs/concepts/context-as-code.mdx`: replace
  scheduled adapter-backed ingest guidance with `ktx ingest --all`.
- Modify `docs-site/content/docs/getting-started/quickstart.mdx`: update setup
  language for schema context, depth, query history, and foreground-only
  progress.
- Modify `docs-site/content/docs/integrations/primary-sources.mdx`: replace
  `historicSql` with `context.queryHistory` and query-history wording.
- Modify `examples/README.md`: stop advertising the fake adapter command as a
  public example workflow.
- Modify `examples/local-warehouse/README.md`: mark the fake adapter fixture as
  contributor-only and point users to public ingest docs.

## Tasks

### Task 1: Add stale public-doc regression tests

**Files:**
- Modify: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Add failing docs-site unified-ingest assertions**

In `scripts/examples-docs.test.mjs`, replace the existing test named
`documents public context build workflows in the docs site` with:

```js
  it('documents unified public ingest workflows in the docs site', async () => {
    const rootReadme = await readText('README.md');
    const cliMeta = await readText('docs-site/content/docs/cli-reference/meta.json');
    const ingestReference = await readText('docs-site/content/docs/cli-reference/ktx-ingest.mdx');
    const devReference = await readText('docs-site/content/docs/cli-reference/ktx-dev.mdx');
    const buildingContext = await readText('docs-site/content/docs/guides/building-context.mdx');
    const contextSources = await readText('docs-site/content/docs/integrations/context-sources.mdx');
    const contextAsCode = await readText('docs-site/content/docs/concepts/context-as-code.mdx');
    const quickstart = await readText('docs-site/content/docs/getting-started/quickstart.mdx');
    const primarySources = await readText('docs-site/content/docs/integrations/primary-sources.mdx');
    const examplesIndex = await readText('examples/README.md');
    const localWarehouseReadme = await readText('examples/local-warehouse/README.md');

    assert.match(ingestReference, /ktx ingest <connectionId>/);
    assert.match(ingestReference, /ktx ingest --all --deep/);
    assert.match(ingestReference, /--query-history-window-days <days>/);
    assert.match(buildingContext, /ktx ingest <connection-id>/);
    assert.match(buildingContext, /ktx ingest --all/);
    assert.match(buildingContext, /ktx ingest replay <run-id>/);
    assert.match(contextSources, /ktx ingest <connectionId>/);
    assert.match(contextAsCode, /ktx ingest --all --no-input/);
    assert.match(quickstart, /schema context/);
    assert.match(primarySources, /context:\\n      queryHistory:/);

    assert.doesNotMatch(cliMeta, /ktx-scan/);
    assert.doesNotMatch(ingestReference, /ktx ingest run/);
    assert.doesNotMatch(ingestReference, /--adapter/);
    assert.doesNotMatch(ingestReference, /ktx ingest watch/);
    assert.doesNotMatch(ingestReference, /live-database/);
    assert.doesNotMatch(devReference, /ktx scan/);
    assert.doesNotMatch(buildingContext, /ktx ingest watch/);
    assert.doesNotMatch(buildingContext, /historic-sql/);
    assert.doesNotMatch(buildingContext, /live-database/);
    assert.doesNotMatch(contextSources, /ktx ingest run --connection-id/);
    assert.doesNotMatch(contextSources, /--adapter <adapter>/);
    assert.doesNotMatch(contextAsCode, /ktx ingest run --connection-id/);
    assert.doesNotMatch(quickstart, /Historic SQL/);
    assert.doesNotMatch(quickstart, /--enable-historic-sql/);
    assert.doesNotMatch(quickstart, /press <kbd>d<\\/kbd> to detach/);
    assert.doesNotMatch(primarySources, /historicSql/);
    assert.doesNotMatch(primarySources, /Historic SQL/);
    assert.doesNotMatch(examplesIndex, /ktx ingest run --project-dir/);
    assert.doesNotMatch(localWarehouseReadme, /ktx ingest run --project-dir/);

    assert.match(rootReadme, /raw-sources\//);
    assert.doesNotMatch(rootReadme, new RegExp(`${['live', 'database'].join('-')}/`));
    assert.doesNotMatch(rootReadme, /ktx scan/);
    assert.doesNotMatch(rootReadme, /Run a local ingest smoke test/);
    assert.doesNotMatch(rootReadme, /ktx ingest run --project-dir/);
    assert.doesNotMatch(rootReadme, /ktx ingest status --project-dir/);
  });
```

- [ ] **Step 2: Run the failing docs regression test**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL with assertions matching the stale docs-site and example README
content.

- [ ] **Step 3: Commit the failing test**

```bash
git add scripts/examples-docs.test.mjs
git commit -m "test(docs): cover unified ingest public docs"
```

### Task 2: Rewrite the CLI reference surface

**Files:**
- Modify: `docs-site/content/docs/cli-reference/ktx-ingest.mdx`
- Delete: `docs-site/content/docs/cli-reference/ktx-scan.mdx`
- Modify: `docs-site/content/docs/cli-reference/meta.json`
- Modify: `docs-site/content/docs/cli-reference/ktx-dev.mdx`

- [ ] **Step 1: Rewrite `ktx-ingest.mdx`**

Replace `docs-site/content/docs/cli-reference/ktx-ingest.mdx` with:

````mdx
---
title: "ktx ingest"
description: "Build, inspect, and replay KTX context ingest runs."
---

`ktx ingest` builds or refreshes KTX context from configured connections.
Database connections build schema context. Context-source connections ingest
metadata from tools such as dbt, Looker, Metabase, MetricFlow, LookML, and
Notion.

## Command signature

```bash
ktx ingest [options] [connectionId]
```

Use a connection id to build one configured connection. Use `--all` to build
every configured connection. Database connections run before context-source
connections when you use `--all`.

## Build options

| Flag | Description | Default |
|------|-------------|---------|
| `--all` | Build every configured connection | `false` |
| `--fast` | Use deterministic database schema ingest | Stored connection default, or `fast` |
| `--deep` | Use AI-enriched database ingest | Stored connection default, or `fast` |
| `--query-history` | Include database query-history usage patterns | Stored connection default |
| `--no-query-history` | Skip database query-history usage patterns for this run | Stored connection default |
| `--query-history-window-days <days>` | Query-history lookback window for this run | Stored connection default |
| `--plain` | Print plain text output | `true` |
| `--json` | Print JSON output | `false` |
| `--no-input` | Disable interactive terminal input | `false` |

`--fast` and `--deep` are mutually exclusive. Depth flags apply only to
database connections. Query-history flags apply only to database connections
that support query history.

## Status and replay

| Subcommand | Description |
|------------|-------------|
| `status [runId]` | Print status for the latest or selected stored ingest run or report file |
| `replay <runId>` | Replay a stored ingest run or bundle report through memory-flow output |

Both subcommands accept `--report-file <path>`, `--plain`, `--json`, `--viz`,
and `--no-input`.

## Examples

```bash
ktx ingest warehouse
ktx ingest warehouse --fast
ktx ingest warehouse --deep
ktx ingest warehouse --deep --query-history
ktx ingest warehouse --query-history-window-days 30
ktx ingest notion
ktx ingest --all
ktx ingest --all --deep

ktx ingest status
ktx ingest status run-abc123
ktx ingest status --json

ktx ingest replay run-abc123
ktx ingest replay run-abc123 --viz
ktx ingest replay run-abc123 --report-file /tmp/ingest-report.json
```

## Common errors

| Error | Cause | Recovery |
|-------|-------|----------|
| Connection not configured | The connection id is not present in `ktx.yaml` | Add the connection with `ktx setup` or update `ktx.yaml` |
| Deep readiness is missing | `--deep` or query history needs model, embedding, and scan-enrichment configuration | Run `ktx setup` or rerun with `--fast` |
| Query history is unsupported | The selected database driver does not support query history | Run schema ingest without query-history flags |
| Latest run not found | No stored ingest report exists in this project | Run `ktx ingest <connectionId>` first |
| Visual replay fails in a non-interactive shell | Visual report replay needs a terminal | Use `ktx ingest status --json` for agent and CI workflows |
````

- [ ] **Step 2: Remove the public scan page**

Delete `docs-site/content/docs/cli-reference/ktx-scan.mdx`.

- [ ] **Step 3: Remove `ktx-scan` from CLI metadata**

In `docs-site/content/docs/cli-reference/meta.json`, replace the full file
with:

```json
{
  "title": "CLI Reference",
  "defaultOpen": true,
  "pages": [
    "ktx-setup",
    "ktx-connection",
    "ktx-ingest",
    "ktx-sl",
    "ktx-wiki",
    "ktx-status",
    "ktx-dev"
  ]
}
```

- [ ] **Step 4: Update the dev command reference**

In `docs-site/content/docs/cli-reference/ktx-dev.mdx`, replace this paragraph:

```mdx
`ktx dev` contains development-only project initialization and managed runtime commands. Scan and ingest commands live at the root as [`ktx scan`](/docs/cli-reference/ktx-scan) and [`ktx ingest`](/docs/cli-reference/ktx-ingest).
```

with:

```mdx
`ktx dev` contains development-only project initialization and managed runtime commands. Context building lives at the root as [`ktx ingest`](/docs/cli-reference/ktx-ingest).
```

- [ ] **Step 5: Run the docs regression test**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL only on the remaining guide, integration, quickstart, primary
source, and example README stale wording.

- [ ] **Step 6: Commit CLI reference cleanup**

```bash
git add docs-site/content/docs/cli-reference/ktx-ingest.mdx docs-site/content/docs/cli-reference/meta.json docs-site/content/docs/cli-reference/ktx-dev.mdx
git rm docs-site/content/docs/cli-reference/ktx-scan.mdx
git commit -m "docs: align ingest CLI reference with unified UX"
```

### Task 3: Update context-build guides

**Files:**
- Modify: `docs-site/content/docs/guides/building-context.mdx`
- Modify: `docs-site/content/docs/integrations/context-sources.mdx`
- Modify: `docs-site/content/docs/concepts/context-as-code.mdx`

- [ ] **Step 1: Update stored report guidance in `building-context.mdx`**

In `docs-site/content/docs/guides/building-context.mdx`, replace the
`### Watching progress` section through the paragraph after it with:

````mdx
### Inspecting stored reports

```bash
# Check status of the latest ingest
ktx ingest status

# Check a specific run
ktx ingest status <run-id>

# Replay a past ingest run
ktx ingest replay <run-id>
```

`ktx ingest replay` opens the stored memory-flow output for a completed run.
Foreground context builds do not detach into background control sessions; if a
run is interrupted, rerun `ktx ingest <connection-id>` or `ktx ingest --all`.
````

- [ ] **Step 2: Replace the adapter table in `building-context.mdx`**

In the same file, replace the `### Available adapters` heading, table, and
following sentence with:

```mdx
### Supported context sources

| Driver | Source | What gets ingested |
|--------|--------|--------------------|
| `dbt` | dbt project | Model definitions, column descriptions, tests, tags |
| `metricflow` | MetricFlow semantic models | Metrics, dimensions, entities, semantic joins |
| `lookml` | LookML files | Views, explores, dimensions, measures, joins |
| `looker` | Looker API | Explores, looks, dashboard metadata |
| `metabase` | Metabase API | Questions, dashboards, table metadata |
| `notion` | Notion API | Database pages, knowledge articles |

Query history is a database connection facet. Enable it with
`connections.<id>.context.queryHistory` or pass `--query-history` for a current
run. See [Context Sources](/docs/integrations/context-sources) for
driver-specific setup and auth configuration.
```

- [ ] **Step 3: Update context-source workflow commands**

In `docs-site/content/docs/integrations/context-sources.mdx`, replace the
numbered workflow with:

```mdx
Agents must configure and ingest context sources in this order:

1. Add the context source connection in `ktx.yaml` or with `ktx setup`.
2. Store tokens as `env:NAME` or `file:/path/to/secret`.
3. Run `ktx ingest <connectionId>` for one source or `ktx ingest --all` for
   every configured source.
4. Check progress with `ktx ingest status --json`.
5. Review generated `semantic-layer/` YAML and `wiki/` Markdown files in git.
6. Validate changed semantic sources with `ktx sl validate`.
```

- [ ] **Step 4: Update scheduled ingest wording**

In `docs-site/content/docs/concepts/context-as-code.mdx`, replace this
paragraph:

```mdx
Teams usually run this on demand while setting up a source, then schedule it once the source is stable. A cron job or CI schedule can run `ktx ingest run --connection-id <id> --adapter <adapter> --no-input` overnight on an ingest branch so the latest dbt manifests, BI metadata, and documentation updates are ready for review each morning.
```

with:

```mdx
Teams usually run this on demand while setting up a source, then schedule it
once the source is stable. A cron job or CI schedule can run `ktx ingest --all
--no-input` overnight on an ingest branch so the latest schema context, dbt
manifests, BI metadata, and documentation updates are ready for review each
morning.
```

- [ ] **Step 5: Run the docs regression test**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL only on quickstart, primary source, and example README stale
wording.

- [ ] **Step 6: Commit guide cleanup**

```bash
git add docs-site/content/docs/guides/building-context.mdx docs-site/content/docs/integrations/context-sources.mdx docs-site/content/docs/concepts/context-as-code.mdx
git commit -m "docs: update context build guides for unified ingest"
```

### Task 4: Update setup and primary-source docs

**Files:**
- Modify: `docs-site/content/docs/getting-started/quickstart.mdx`
- Modify: `docs-site/content/docs/integrations/primary-sources.mdx`

- [ ] **Step 1: Update database setup copy in quickstart**

In `docs-site/content/docs/getting-started/quickstart.mdx`, replace the first
paragraph under `## Step 3: Connect a database` with:

```mdx
Select one or more databases for KTX to connect to. The wizard supports
SQLite, PostgreSQL, MySQL, ClickHouse, SQL Server, BigQuery, and Snowflake.
```

Replace this sentence:

```mdx
After connecting, KTX automatically runs a connection test and a structural scan:
```

with:

```mdx
After connecting, KTX automatically runs a connection test and builds fast
schema context:
```

Replace the example output block in Step 3 with:

````mdx
```
Testing postgres-warehouse
  Connection test passed
  Driver: PostgreSQL - Tables: 42

Building schema context for postgres-warehouse
  Running fast database ingest

Schema context complete for postgres-warehouse
  Changes: 42 new tables

Primary source ready
  postgres-warehouse - PostgreSQL - schema context complete
```
````

Replace this paragraph:

```mdx
For Snowflake and BigQuery, the wizard offers **Historic SQL** configuration for query history views. For PostgreSQL, enable Historic SQL with `--enable-historic-sql` when `pg_stat_statements` is configured.
```

with:

```mdx
For PostgreSQL, Snowflake, and BigQuery, the wizard can enable query-history
ingest when the warehouse history feature is available. Query history is stored
under `connections.<id>.context.queryHistory` in `ktx.yaml`.
```

- [ ] **Step 2: Update context-build copy in quickstart**

In the same file, replace the first two paragraphs under
`## Step 5: Build context` with:

```mdx
This is where KTX builds agent-ready context. It uses the database context
depth saved by setup and ingests metadata from any configured context sources.

Fast database context builds deterministic schema grounding. Deep database
context also generates AI descriptions, embeddings, and relationship evidence
when those capabilities are configured.
```

Replace the paragraph and background example that starts with `For a small
database` and ends with the fenced context-build block with:

````mdx
For a small database (under 50 tables), this can take a few minutes. Larger
warehouses can take longer. Context builds run in the foreground; press
<kbd>Ctrl+C</kbd> to stop the current run and rerun `ktx setup` or `ktx ingest`
when you are ready to try again.
````

Replace this output line in the completion example:

```text
  postgres-warehouse: enriched scan complete
```

with:

```text
  postgres-warehouse: deep context complete
```

Replace the next-steps bullet:

```mdx
- **Build more context** - learn about [scanning](/docs/guides/building-context), relationship detection, and ingestion workflows in the Building Context guide.
```

with:

```mdx
- **Build more context** - learn about [database ingest](/docs/guides/building-context), relationship detection, and source ingestion workflows in the Building Context guide.
```

- [ ] **Step 3: Update primary-source query-history config**

In `docs-site/content/docs/integrations/primary-sources.mdx`, replace the
introductory paragraph and shared conventions with:

```mdx
KTX connects to your data warehouse or database to build schema context,
discover relationships, and execute semantic layer queries. Each connection is
defined in `ktx.yaml` under the `connections` key.

All connectors share these conventions:

- Sensitive values support `env:VAR_NAME` (read from environment) and
  `file:/path/to/secret` (read from file) references
- Connections are read-only; KTX never writes to your database
- Database ingest discovers tables, columns, types, and constraints
  automatically
```

In the connection field reference table, replace the `historicSql` row with:

```mdx
| `context.queryHistory` | No | PostgreSQL, Snowflake, BigQuery | Enables query-history ingestion when the warehouse supports it |
```

Replace every feature row label `Historic SQL` with `Query history`.

Replace each `### Historic SQL` heading with `### Query history`.

Replace the PostgreSQL query-history config block with:

```yaml
context:
  queryHistory:
    enabled: true
    minExecutions: 5
    filters:
      dropTrivialProbes: true
```

Replace the Snowflake query-history config block with:

```yaml
context:
  queryHistory:
    enabled: true
    windowDays: 90
    minExecutions: 5
    filters:
      dropTrivialProbes: true
      serviceAccounts:
        patterns: ['^svc_']
        mode: exclude
    redactionPatterns: []
```

Replace the BigQuery query-history config block with:

```yaml
context:
  queryHistory:
    enabled: true
    windowDays: 90
    minExecutions: 5
    filters:
      dropTrivialProbes: true
      serviceAccounts:
        patterns: ['@bot\\.']
        mode: exclude
    redactionPatterns: []
```

Replace the common-errors row:

```mdx
| Historic SQL is empty | Query history extension or warehouse history view is unavailable | Enable the warehouse-specific history feature, then rerun scan or setup |
```

with:

```mdx
| Query history is empty | Query history extension or warehouse history view is unavailable | Enable the warehouse-specific history feature, then rerun `ktx ingest <connectionId> --query-history` or `ktx setup` |
```

Replace the common-errors row:

```mdx
| Scan returns no tables | Schema/database/project filter is wrong or the user lacks metadata permissions | Verify the schema list and grant metadata read permissions |
```

with:

```mdx
| Database ingest returns no tables | Schema, database, or project filter is wrong, or the user lacks metadata permissions | Verify the schema list and grant metadata read permissions |
```

Replace the common-errors row:

```mdx
| Column statistics are missing | Connector cannot access stats tables or the warehouse does not expose them | Grant stats permissions where supported; otherwise rely on structural scan output |
```

with:

```mdx
| Column statistics are missing | Connector cannot access stats tables or the warehouse does not expose them | Grant stats permissions where supported; otherwise rely on fast schema context |
```

- [ ] **Step 4: Run targeted stale-term search**

Run:

```bash
rg -n "Historic SQL|historicSql|--enable-historic-sql|--historic-sql|ktx scan|ktx ingest watch|ktx ingest run --connection-id|--adapter <adapter>|live-database" docs-site/content/docs/getting-started/quickstart.mdx docs-site/content/docs/integrations/primary-sources.mdx docs-site/content/docs/cli-reference docs-site/content/docs/guides/building-context.mdx docs-site/content/docs/integrations/context-sources.mdx docs-site/content/docs/concepts/context-as-code.mdx
```

Expected: no output.

- [ ] **Step 5: Run the docs regression test**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL only on example README stale adapter-command wording.

- [ ] **Step 6: Commit setup and primary-source docs cleanup**

```bash
git add docs-site/content/docs/getting-started/quickstart.mdx docs-site/content/docs/integrations/primary-sources.mdx
git commit -m "docs: update setup and primary source ingest wording"
```

### Task 5: Remove public fake-adapter example commands

**Files:**
- Modify: `examples/README.md`
- Modify: `examples/local-warehouse/README.md`

- [ ] **Step 1: Rewrite the local-warehouse section in `examples/README.md`**

In `examples/README.md`, replace the `## local-warehouse` section with:

````md
## local-warehouse

`local-warehouse/` is a contributor fixture for local CLI smoke tests. It uses
the internal fake ingest adapter so tests can exercise memory-flow behavior
without a live database or external service.

For normal context building, use the public connection-centric commands:

```bash
ktx ingest <connectionId>
ktx ingest --all
```

The copied project initializes its own Git repository on first use.
````

- [ ] **Step 2: Rewrite `examples/local-warehouse/README.md`**

Replace `examples/local-warehouse/README.md` with:

````md
# local-warehouse fixture

This directory is a contributor fixture for KTX CLI smoke tests. It uses the
internal fake ingest adapter so tests can run without a live database or
external service.

Normal users should build context with connection-centric ingest:

```bash
ktx ingest <connectionId>
ktx ingest --all
```

The public ingest workflow is documented in
`docs-site/content/docs/cli-reference/ktx-ingest.mdx` and
`docs-site/content/docs/guides/building-context.mdx`.
````

- [ ] **Step 3: Run the docs regression test**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit example docs cleanup**

```bash
git add examples/README.md examples/local-warehouse/README.md
git commit -m "docs: stop advertising adapter-backed example ingest"
```

### Task 6: Final verification

**Files:**
- Verify: `scripts/examples-docs.test.mjs`
- Verify: `docs-site/content/docs/**/*.mdx`
- Verify: `examples/**/*.md`

- [ ] **Step 1: Run docs regression tests**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run docs-site build**

Run:

```bash
pnpm --filter ktx-docs run build
```

Expected: PASS. If the build fails because this workspace lacks external build
prerequisites, capture the error and run `pnpm --filter ktx-docs run test` as
the closest available docs-site check.

- [ ] **Step 3: Run final stale public-surface search**

Run:

```bash
rg -n "ktx scan|ktx ingest run --connection-id|--adapter <adapter>|ktx ingest watch|live-database|Historic SQL|historicSql|--enable-historic-sql|--historic-sql" docs-site/content/docs examples/README.md examples/local-warehouse/README.md
```

Expected: no output.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: only the files intentionally changed by this plan appear.

- [ ] **Step 5: Commit verification updates if needed**

If verification required small documentation or test fixes, commit them:

```bash
git add scripts/examples-docs.test.mjs docs-site/content/docs examples/README.md examples/local-warehouse/README.md
git commit -m "docs: close unified ingest public docs gaps"
```

## Self-review

- Spec coverage: This plan covers the remaining public documentation surfaces
  that still contradicted the unified ingest UX spec. It intentionally does not
  rename internal scan packages, internal adapter keys, raw artifact paths, or
  developer-only test fixtures.
- Placeholder scan: No task contains open-ended placeholders. Each edit names
  exact files and exact replacement text or commands.
- Type consistency: This is a documentation-only plan. Command names and config
  keys match the implemented CLI and config code: `ktx ingest <connectionId>`,
  `ktx ingest --all`, `ktx ingest status`, `ktx ingest replay`, and
  `connections.<id>.context.queryHistory`.
