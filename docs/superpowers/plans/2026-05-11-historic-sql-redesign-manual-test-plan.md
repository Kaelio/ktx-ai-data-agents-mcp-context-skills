# External Hosted Postgres Discovery Manual Test Plan

This plan tests KTX from the point of view of a new external user who discovers
the public CLI and connects the hosted Kaelio demo Postgres database as the
source. It starts with the credential-free seeded demo, then creates a real KTX
project that reads from `start.kaelio.com`.

The plan avoids writing the database password into this repository. Keep the
password in a local environment variable and configure KTX with
`env:KTX_DEMO_DATABASE_URL`.

## Scope

Use this plan when the goal is to test KTX as an external user with the hosted
demo database. The commands use the published package shape through
`npx @kaelio/ktx`. If you are testing from this repository, you can replace
`npx @kaelio/ktx` with the local `ktx` alias.

The required checks cover:

- Running the packaged seeded demo without credentials.
- Creating a new project that points to the hosted Postgres demo source.
- Verifying the connection through the public CLI.
- Running public ingest against the hosted database.
- Searching semantic-layer sources through `agent sl list --query`.
- Running the Postgres historic-SQL readiness doctor.
- Running the historic-SQL adapter when the demo database exposes query
  history and local LLM configuration is available.
- Searching generated historic-SQL usage and pattern pages when historic-SQL
  ingest runs.

## Prerequisites

Prepare a clean terminal before starting. The required path needs Node and
network access to `start.kaelio.com:5432`. The optional historic-SQL ingest path
also needs `uv` and an LLM provider configured for KTX.

1. Confirm Node 22 or newer is available:

   ```bash
   node --version
   ```

   Expected: the version is `v22` or newer.

2. Confirm the hosted Postgres endpoint is reachable from your network:

   ```bash
   nc -vz start.kaelio.com 5432
   ```

   Expected: the command reports that the TCP connection succeeds. If `nc` is
   unavailable, continue and let `ktx connection test` perform the real check.

3. Create an isolated test parent:

   ```bash
   export KTX_EXTERNAL_PARENT="$(mktemp -d)"
   export KTX_SEEDED_PROJECT="$KTX_EXTERNAL_PARENT/seeded-demo"
   export KTX_HOSTED_PROJECT="$KTX_EXTERNAL_PARENT/hosted-postgres"
   export KTX_RUNTIME_ROOT="$KTX_EXTERNAL_PARENT/managed-runtime"
   ```

   Expected: every file created by this test stays under
   `$KTX_EXTERNAL_PARENT`.

4. Set the hosted database URL without committing the password:

   ```bash
   read -rsp "Demo database password: " KTX_DEMO_DB_PASSWORD
   printf '\n'
   export KTX_DEMO_DATABASE_URL="postgresql://kaelio_demo:${KTX_DEMO_DB_PASSWORD}"
   export KTX_DEMO_DATABASE_URL="${KTX_DEMO_DATABASE_URL}@start.kaelio.com:5432/demo?sslmode=prefer"
   unset KTX_DEMO_DB_PASSWORD
   ```

   Expected: `KTX_DEMO_DATABASE_URL` is set only in your shell. The project
   config will store `env:KTX_DEMO_DATABASE_URL`, not the literal URL.

   The hosted demo endpoint uses libpq-style `sslmode=prefer`, which means
   "try SSL, then fall back to non-SSL." KTX handles this mode explicitly for
   the Node Postgres connector so the setup check can connect to the hosted
   demo database.

5. Verify the required shell variables before running any `ktx` commands:

   ```bash
   : "${KTX_EXTERNAL_PARENT:?Run prerequisite step 3 in this shell first}"
   : "${KTX_SEEDED_PROJECT:?Run prerequisite step 3 in this shell first}"
   : "${KTX_HOSTED_PROJECT:?Run prerequisite step 3 in this shell first}"
   : "${KTX_RUNTIME_ROOT:?Run prerequisite step 3 in this shell first}"
   : "${KTX_DEMO_DATABASE_URL:?Run prerequisite step 4 in this shell first}"
   ```

   Expected: the command prints nothing and exits zero. If it prints a shell
   error, rerun the referenced prerequisite in the same terminal before
   continuing.

## Step 1: Run the packaged seeded demo

Start with the shortest public path. The seeded demo uses packaged data and
prebuilt context, so it must not ask for an LLM key.

1. Run the seeded demo:

   ```bash
   npx @kaelio/ktx setup demo \
     --project-dir "$KTX_SEEDED_PROJECT" \
     --plain \
     --no-input
   ```

   Expected: output includes `Mode: seeded`, `Source: packaged demo project`,
   and `LLM calls: none`.

2. Inspect the seeded demo:

   ```bash
   npx @kaelio/ktx setup demo inspect \
     --project-dir "$KTX_SEEDED_PROJECT" \
     --json > "$KTX_EXTERNAL_PARENT/seeded-inspect.json"
   ```

   Expected: the JSON reports seeded mode, semantic-layer sources, knowledge
   pages, and `reports/seeded-demo-report.json`.

3. Search seeded semantic-layer sources:

   ```bash
   npx @kaelio/ktx agent sl list \
     --project-dir "$KTX_SEEDED_PROJECT" \
     --json \
     --query "revenue" \
     > "$KTX_EXTERNAL_PARENT/seeded-sl-search.json"
   ```

   Expected: the command exits zero and returns at least one source with a
   numeric `score`.

## Step 2: Create a hosted Postgres project

Create a new KTX project that uses the hosted demo database as the warehouse
source. This step enables historic SQL in the config, but it does not require
LLM credentials yet.

If an earlier setup attempt failed after creating `$KTX_HOSTED_PROJECT/ktx.yaml`,
start a fresh test project before rerunning the `--new` command:

```bash
export KTX_HOSTED_PROJECT="$KTX_EXTERNAL_PARENT/hosted-postgres-retry"
```

1. Create the project and connection:

   ```bash
   npx @kaelio/ktx setup \
     --project-dir "${KTX_HOSTED_PROJECT:?Run prerequisite step 3 first}" \
     --new \
     --skip-llm \
     --skip-embeddings \
     --skip-sources \
     --skip-agents \
     --database postgres \
     --new-database-connection-id warehouse \
     --database-url env:KTX_DEMO_DATABASE_URL \
     --database-schema public \
     --enable-historic-sql \
     --historic-sql-min-executions 2 \
     --yes \
     --no-input
   ```

   Expected: `$KTX_HOSTED_PROJECT/ktx.yaml` exists and contains a `warehouse`
   Postgres connection whose URL is `env:KTX_DEMO_DATABASE_URL`.

2. Confirm the password was not written to disk:

   ```bash
   grep -R "start.kaelio.com:5432/demo" "$KTX_HOSTED_PROJECT" || true
   ```

   Expected: no matches are printed.

3. Inspect the generated connection config:

   ```bash
   sed -n '1,120p' "$KTX_HOSTED_PROJECT/ktx.yaml"
   ```

   Expected: the `warehouse` connection has `driver: postgres`,
   `url: env:KTX_DEMO_DATABASE_URL` or an equivalent URL reference, and
   `historicSql.enabled: true`.

## Step 3: Test the hosted connection

Run the public connection check before ingest. This verifies that the external
user can reach and introspect the hosted source.

1. Test the connection:

   ```bash
   npx @kaelio/ktx connection test warehouse \
     --project-dir "$KTX_HOSTED_PROJECT"
   ```

   Expected: output includes `Driver: postgres` and a positive table count.

2. List configured connections:

   ```bash
   npx @kaelio/ktx connection list \
     --project-dir "$KTX_HOSTED_PROJECT"
   ```

   Expected: output includes the `warehouse` connection.

## Step 4: Run public ingest

Run the public ingest command. For warehouse connections, this performs the
database scan path and writes local context files that agent search can use.

1. Run ingest:

   ```bash
   npx @kaelio/ktx ingest warehouse \
     --project-dir "$KTX_HOSTED_PROJECT" \
     --no-input
   ```

   Expected: output reports that ingest finished and that the `scan` step is
   `done`.

2. Inspect the latest public ingest status:

   ```bash
   npx @kaelio/ktx ingest status \
     --project-dir "$KTX_HOSTED_PROJECT" \
     --no-input
   ```

   Expected: the status references the hosted `warehouse` source and a
   completed scan.

3. Confirm semantic-layer files exist:

   ```bash
   find "$KTX_HOSTED_PROJECT/semantic-layer/warehouse" \
     -name '*.yaml' -print | head
   ```

   Expected: at least one semantic-layer YAML file is printed.

## Step 5: Search the hosted database context

Use the agent-facing semantic-layer search command after ingest. This validates
the discovery path that agents use for database analysis.

1. Run semantic-layer search:

   ```bash
   npx @kaelio/ktx agent sl list \
     --project-dir "$KTX_HOSTED_PROJECT" \
     --connection-id warehouse \
     --json \
     --query "orders revenue customers" \
     > "$KTX_EXTERNAL_PARENT/hosted-sl-search.json"
   ```

   Expected: the command exits zero.

2. Validate search metadata:

   ```bash
   node - "$KTX_EXTERNAL_PARENT/hosted-sl-search.json" <<'NODE'
   const { readFileSync } = require('node:fs');
   const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
   const assert = (ok, message) => {
     if (!ok) throw new Error(message);
   };
   assert(Array.isArray(result.sources), 'sources missing');
   assert(result.sources.length > 0, 'no semantic-layer hits');
   assert(Number.isFinite(result.sources[0].score), 'score missing');
   console.log('hosted semantic-layer search ok');
   NODE
   ```

   Expected: the script prints `hosted semantic-layer search ok`.

3. Read the top source:

   ```bash
   node - "$KTX_EXTERNAL_PARENT/hosted-sl-search.json" \
     > "$KTX_EXTERNAL_PARENT/hosted-top-source-name.txt" <<'NODE'
   const { readFileSync } = require('node:fs');
   const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
   process.stdout.write(result.sources[0].name);
   NODE

   npx @kaelio/ktx agent sl read \
     "$(cat "$KTX_EXTERNAL_PARENT/hosted-top-source-name.txt")" \
     --project-dir "$KTX_HOSTED_PROJECT" \
     --connection-id warehouse \
     --json \
     > "$KTX_EXTERNAL_PARENT/hosted-sl-read.json"
   ```

   Expected: the JSON includes the full semantic-layer source.

## Step 6: Check historic-SQL readiness

Run the Postgres historic-SQL doctor. This determines whether the hosted demo
database exposes the query-history prerequisites needed for the redesign's
historic-SQL adapter.

1. Run doctor:

   ```bash
   npx @kaelio/ktx dev doctor \
     --project-dir "$KTX_HOSTED_PROJECT" \
     --no-input
   ```

   Expected: output includes a `Postgres Historic SQL (warehouse)` check.

2. Interpret the result:

   - `PASS` means the hosted source is ready for the optional historic-SQL
     ingest path.
   - `WARN` or `FAIL` means the external discovery test still covers scan and
     semantic-layer search, but historic-SQL query-history ingestion is blocked
     by database permissions or configuration.

## Step 7: Optional historic-SQL ingest

Run this section only when the doctor passes and the KTX project has an LLM
provider configured. Historic-SQL table and pattern curation uses LLM-backed
skills, so this path is not credential-free.

1. Configure LLM and embeddings if you skipped them during setup:

   ```bash
   npx @kaelio/ktx setup \
     --project-dir "$KTX_HOSTED_PROJECT"
   ```

   Expected: `npx @kaelio/ktx setup status --project-dir "$KTX_HOSTED_PROJECT"`
   reports that LLM and embedding setup are ready.

2. Run historic-SQL ingest:

   ```bash
   npx @kaelio/ktx dev ingest run \
     --project-dir "$KTX_HOSTED_PROJECT" \
     --connection-id warehouse \
     --adapter historic-sql \
     --plain \
     --yes \
     --no-input
   ```

   Expected: the command exits zero and schedules `historic-sql-table-` and
   `historic-sql-patterns-` WorkUnits when the database has qualifying query
   history.

3. Locate the latest historic-SQL manifest:

   ```bash
   find "$KTX_HOSTED_PROJECT/raw-sources/warehouse/historic-sql" \
     -name manifest.json -print | sort | tail -n 1
   ```

   Expected: a manifest path is printed.

4. Search for generated usage:

   ```bash
   npx @kaelio/ktx agent sl list \
     --project-dir "$KTX_HOSTED_PROJECT" \
     --connection-id warehouse \
     --json \
     --query "common filters joins usage" \
     > "$KTX_EXTERNAL_PARENT/historic-sl-search.json"
   ```

   Expected: hits produced from historic-SQL usage include `score`, and hits
   with projected usage include `frequencyTier` and `snippet`.

5. Search for generated pattern pages:

   ```bash
   npx @kaelio/ktx agent wiki search "historic sql pattern" \
     --project-dir "$KTX_HOSTED_PROJECT" \
     --json \
     --limit 10 \
     > "$KTX_EXTERNAL_PARENT/historic-wiki-search.json"
   ```

   Expected: results include pages whose keys start with `historic-sql/` when
   the run produced cross-table patterns.

## Step 8: Record results

Capture the result in a way that separates the external discovery path from the
optional historic-SQL path.

1. Save useful outputs:

   ```bash
   mkdir -p "$KTX_EXTERNAL_PARENT/results"
   cp "$KTX_EXTERNAL_PARENT/seeded-inspect.json" \
     "$KTX_EXTERNAL_PARENT/results/" 2>/dev/null || true
   cp "$KTX_EXTERNAL_PARENT/hosted-sl-search.json" \
     "$KTX_EXTERNAL_PARENT/results/" 2>/dev/null || true
   cp "$KTX_EXTERNAL_PARENT/hosted-sl-read.json" \
     "$KTX_EXTERNAL_PARENT/results/" 2>/dev/null || true
   cp "$KTX_EXTERNAL_PARENT/historic-sl-search.json" \
     "$KTX_EXTERNAL_PARENT/results/" 2>/dev/null || true
   cp "$KTX_EXTERNAL_PARENT/historic-wiki-search.json" \
     "$KTX_EXTERNAL_PARENT/results/" 2>/dev/null || true
   ```

   Expected: the results directory contains the JSON outputs created during the
   run.

2. Mark these areas as pass, fail, or blocked:

   - Public package discovery through `npx @kaelio/ktx`.
   - Seeded demo without credentials.
   - Hosted Postgres project setup.
   - Hosted Postgres connection test.
   - Public ingest scan.
   - Semantic-layer search and read.
   - Historic-SQL doctor.
   - Historic-SQL ingest, if doctor and LLM setup allow it.
   - Historic-SQL usage search, if ingest ran.
   - Historic-SQL wiki pattern search, if ingest ran.

   Expected: every required external discovery area passes. Historic-SQL ingest
   is pass, fail, or blocked based on the doctor result and local LLM
   configuration.

## Cleanup

Remove the disposable project after collecting results. Keep it only when you
need the files for debugging.

1. Stop the managed runtime:

   ```bash
   npx @kaelio/ktx runtime stop || true
   ```

2. Remove the test parent:

   ```bash
   rm -rf "$KTX_EXTERNAL_PARENT"
   ```

   Expected: temporary projects and runtime files are removed.
