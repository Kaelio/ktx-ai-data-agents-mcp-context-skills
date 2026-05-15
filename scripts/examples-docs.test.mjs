import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function publicNpmPackageName() {
  return `@${['kae', 'lio'].join('')}/ktx`;
}

function runtimeWheelPackageName() {
  return `${['kae', 'lio'].join('')}-ktx`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publicPackagePattern(text) {
  return new RegExp(text.replaceAll('{package}', escapeRegExp(publicNpmPackageName())));
}

describe('standalone example docs', () => {
  it('documents the local warehouse example from the examples index', async () => {
    const examples = await readText('examples/README.md');

    assert.match(examples, /local-warehouse/);
    assert.match(examples, /fake ingest adapter/);
    assert.doesNotMatch(examples, /will contain standalone examples/);
  });

  it('documents the Orbit relationship verification example project', async () => {
    const examples = await readText('examples/README.md');
    const readme = await readText('examples/orbit-relationship-verification/README.md');
    const config = await readText('examples/orbit-relationship-verification/ktx.yaml');

    assert.match(examples, /orbit-relationship-verification/);
    assert.match(examples, /relationships:verify-orbit/);
    assert.match(readme, /Orbit-style relationship discovery verification/);
    assert.match(readme, /pnpm run relationships:verify-orbit/);
    assert.match(readme, /Accepted: 9/);
    assert.match(readme, /Review: 0/);
    assert.match(readme, /Rejected: 0/);
    assert.doesNotMatch(config, /^project:/m);
    assert.match(config, /orbit:/);
    assert.match(config, /driver: sqlite/);
    assert.match(
      config,
      /path: \.\.\/\.\.\/packages\/context\/test\/fixtures\/relationship-benchmarks\/orbit_style_product_no_declared_constraints\/data\.sqlite/,
    );
    assert.match(config, /llmProposals: false/);
    assert.match(config, /validationRequiredForManifest: true/);
  });

  it('documents the Postgres historic SQL smoke example', async () => {
    const examples = await readText('examples/README.md');
    const readme = await readText('examples/postgres-historic/README.md');
    const compose = await readText('examples/postgres-historic/docker-compose.yml');
    const initSql = await readText('examples/postgres-historic/init/001-schema.sql');
    const workload = await readText('examples/postgres-historic/scripts/generate-workload.sh');
    const smoke = await readText('examples/postgres-historic/scripts/smoke.sh');

    assert.match(examples, /postgres-historic/);
    assert.doesNotMatch(examples, /Historic SQL/);
    assert.doesNotMatch(examples, /historic-SQL/);
    assert.match(examples, /query-history ingest via `pg_stat_statements`/);
    assert.doesNotMatch(readme, new RegExp(['--enable-historic', 'sql'].join('-')));
    assert.doesNotMatch(readme, new RegExp(['--historic', 'sql-min-executions'].join('-')));
    assert.doesNotMatch(readme, /ktx ingest run --project-dir/);
    assert.doesNotMatch(readme, /--adapter historic-sql/);
    assert.match(readme, /--enable-query-history/);
    assert.match(readme, /--query-history-min-executions 2/);
    assert.match(readme, /ktx status --project-dir/);
    assert.match(readme, /Postgres query history/);
    assert.match(readme, /manifest\.json/);
    assert.match(readme, /tables\/\*\.json/);
    assert.match(readme, /patterns-input\.json/);
    assert.match(readme, /patterns-input\/part-\*\.json/);
    assert.match(readme, /full audit input/);
    assert.match(readme, /bounded pattern WorkUnit shards/);
    assert.match(readme, /workUnitCount: 0/);
    assert.match(compose, /postgres:14/);
    assert.match(compose, /shared_preload_libraries=pg_stat_statements/);
    assert.match(compose, /pg_stat_statements.track=top/);
    assert.match(initSql, /CREATE EXTENSION IF NOT EXISTS pg_stat_statements/);
    assert.match(initSql, /GRANT pg_read_all_stats TO ktx_reader/);
    assert.match(workload, /JOIN customers/);
    assert.match(workload, /app_user/);
    assert.match(workload, /etl_user/);
    assert.match(smoke, /assert_unified_snapshot/);
    assert.match(smoke, /assert_stage_record "\$UNCHANGED_RECORD" unchanged zero/);
    assert.match(smoke, /assertPatternShards/);
    assert.match(smoke, /historic-sql-patterns-part-/);
    assert.match(smoke, /patterns-input\/part-/);
    assert.doesNotMatch(smoke, new RegExp(["unitKey === 'historic", 'sql', "patterns'"].join('-')));
    assert.match(smoke, /--query-history-min-executions 2/);
    assert.match(smoke, /KTX_RUNTIME_ROOT/);
    assert.match(smoke, /managedDaemon/);
    assert.match(smoke, /installPolicy: 'auto'/);
    assert.match(smoke, /getKtxCliPackageInfo/);
    assert.doesNotMatch(smoke, /python-service/);
    assert.doesNotMatch(smoke, /PYTHON_SERVICE/);
    assert.doesNotMatch(smoke, /uvicorn app\.main:app/);
    assert.doesNotMatch(smoke, /export KTX_SQL_ANALYSIS_URL/);
    assert.doesNotMatch(
      smoke,
      new RegExp(
        [
          ['baseline', 'FirstRun'],
          ['de', 'graded'],
          ['stats', 'ResetAt'],
          ['assert', '_manifest'],
        ]
          .map((parts) => parts.join(''))
          .join('|'),
      ),
    );
    assert.doesNotMatch(readme, /python-service/);
    assert.doesNotMatch(readme, /KTX_SQL_ANALYSIS_URL/);
    assert.doesNotMatch(
      readme,
      new RegExp(
        [
          ['baseline', 'FirstRun'],
          ['de', 'graded: true'],
          ['stats', 'ResetAt'],
          ['fresh PGSS', ' baseline'],
          ['delta', '-only'],
        ]
          .map((parts) => parts.join(''))
          .join('|'),
      ),
    );
  });

  it('checked-in example configs do not include public database adapters', async () => {
    const localWarehouseConfig = await readFile('examples/local-warehouse/ktx.yaml', 'utf8');
    const orbitConfig = await readFile('examples/orbit-relationship-verification/ktx.yaml', 'utf8');
    const legacyPublicAdapter = new RegExp(['live', 'database'].join('-'));

    assert.doesNotMatch(localWarehouseConfig, legacyPublicAdapter);
    assert.doesNotMatch(orbitConfig, legacyPublicAdapter);
  });

  it('lists every workspace package in the contributor docs', async () => {
    const contributing = await readText('docs-site/content/docs/community/contributing.mdx');

    assert.match(contributing, /cli\/\s+# CLI entry point/);
    assert.match(contributing, /context\/\s+# Core context engine/);
    assert.match(contributing, /llm\/\s+# LLM client abstraction/);
    assert.match(contributing, /connector-bigquery\/\s+# BigQuery connector/);
    assert.match(contributing, /connector-clickhouse\/\s+# ClickHouse connector/);
    assert.match(contributing, /connector-mysql\/\s+# MySQL connector/);
    assert.match(contributing, /connector-postgres\/\s+# PostgreSQL connector/);
    assert.match(contributing, /connector-snowflake\/\s+# Snowflake connector/);
    assert.match(contributing, /connector-sqlite\/\s+# SQLite connector/);
    assert.match(contributing, /connector-sqlserver\/\s+# SQL Server connector/);
    assert.match(contributing, /ktx-sl\/\s+# Semantic layer/);
    assert.match(contributing, /ktx-daemon\/\s+# Daemon/);
  });

  it('documents agent-facing CLI commands', async () => {
    const servingAgents = await readText('docs-site/content/docs/guides/serving-agents.mdx');

    for (const command of [
      'ktx status --json',
      'ktx sl list --json',
      'ktx sl search "revenue" --json',
      'ktx sl query',
      'ktx wiki search "revenue recognition" --json',
    ]) {
      assert.match(servingAgents, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('walks through connection testing in the quickstart and CLI reference', async () => {
    const quickstart = await readText('docs-site/content/docs/getting-started/quickstart.mdx');
    const connectionReference = await readText('docs-site/content/docs/cli-reference/ktx-connection.mdx');

    assert.match(connectionReference, /ktx connection list/);
    assert.match(connectionReference, /ktx connection test my-warehouse/);
    assert.match(connectionReference, /ktx connection test --all/);
    assert.match(quickstart, /Connection test passed/);
    assert.match(connectionReference, /Driver: postgres/);
    assert.match(connectionReference, /Status: ok/);
  });

  it('documents public npm and managed runtime usage', async () => {
    const rootReadme = await readText('README.md');
    const quickstart = await readText('docs-site/content/docs/getting-started/quickstart.mdx');
    const packageArtifacts = await readText('examples/package-artifacts/README.md');

    assert.match(rootReadme, publicPackagePattern('npm install -g {package}'));
    assert.match(quickstart, publicPackagePattern('npm install -g {package}'));
    assert.match(quickstart, /ktx dev runtime install --feature local-embeddings --yes/);
    assert.match(quickstart, /ktx dev runtime start --feature local-embeddings/);
    assert.match(packageArtifacts, /requires `uv` on `PATH`/);
    assert.match(packageArtifacts, /ktx dev runtime status/);
    assert.match(packageArtifacts, /ktx dev runtime status/);
    assert.doesNotMatch(packageArtifacts, /ktx dev runtime prune/);
    assert.match(
      packageArtifacts,
      new RegExp(
        `artifact manifest contains the public \`${escapeRegExp(publicNpmPackageName())}\` npm tarball and the\\s+bundled \`${escapeRegExp(
          runtimeWheelPackageName(),
        )}\` runtime wheel`,
      ),
    );
    assert.doesNotMatch(rootReadme, /ktx serve --mcp stdio/);
    assert.doesNotMatch(rootReadme, /uv run ktx-daemon serve-http/);
    assert.doesNotMatch(rootReadme, /--semantic-compute-url http:\/\/127\.0\.0\.1:8765/);
  });

  it('documents the public package artifact smoke shape', async () => {
    const readme = await readText('examples/package-artifacts/README.md');

    assert.match(readme, publicPackagePattern('{package}'));
    assert.match(readme, /managed Python runtime/);
    assert.match(
      readme,
      new RegExp(
        `public \`${escapeRegExp(publicNpmPackageName())}\` npm tarball and the\\s+bundled \`${escapeRegExp(
          runtimeWheelPackageName(),
        )}\`\\s+runtime wheel`,
      ),
    );
    assert.match(readme, /does not install standalone\s+Python packages directly/);
    assert.doesNotMatch(readme, /standalone Python distributions/);
    assert.doesNotMatch(readme, /installs the Python artifacts directly/);
    assert.match(readme, /requires `uv` on `PATH`/);
    assert.match(readme, /ktx dev runtime status/);
    assert.match(readme, /ktx dev runtime status/);
    assert.doesNotMatch(readme, /ktx dev runtime prune/);
    assert.doesNotMatch(readme, /@ktx\/context/);
    assert.doesNotMatch(readme, /@ktx\/cli/);
    assert.doesNotMatch(readme, /python -m ktx_daemon semantic-validate/);
  });

  it('documents unified public ingest workflows in the docs site', async () => {
    const rootReadme = await readText('README.md');
    const cliMeta = await readText('docs-site/content/docs/cli-reference/meta.json');
    const ingestReference = await readText('docs-site/content/docs/cli-reference/ktx-ingest.mdx');
    const devReference = await readText('docs-site/content/docs/cli-reference/ktx-dev.mdx');
    const setupReference = await readText('docs-site/content/docs/cli-reference/ktx-setup.mdx');
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
    assert.match(buildingContext, /ktx ingest <connectionId>/);
    assert.match(buildingContext, /ktx ingest --all/);
    assert.match(contextSources, /ktx ingest <connectionId>/);
    assert.match(contextAsCode, /ktx ingest --all --no-input/);
    assert.match(quickstart, /schema context/);
    assert.match(primarySources, /context:\n      queryHistory:/);
    assert.match(rootReadme, /Databases configured: yes \(postgres-warehouse\)/);
    assert.match(quickstart, /Databases:\n  warehouse: deep context complete/);
    assert.match(quickstart, /Databases configured: yes \(warehouse\)/);
    assert.match(setupReference, /Databases configured: yes \(postgres-warehouse\)/);
    assert.doesNotMatch(rootReadme, new RegExp(['Primary sources', 'configured'].join(' ')));
    assert.doesNotMatch(quickstart, new RegExp(['Primary', 'sources'].join(' ')));
    assert.doesNotMatch(setupReference, new RegExp(['Primary sources', 'configured'].join(' ')));

    assert.doesNotMatch(cliMeta, /ktx-scan/);
    assert.doesNotMatch(ingestReference, /ktx ingest run/);
    assert.doesNotMatch(ingestReference, /ktx ingest status/);
    assert.doesNotMatch(ingestReference, /ktx ingest replay/);
    assert.doesNotMatch(ingestReference, /--adapter/);
    assert.doesNotMatch(ingestReference, /ktx ingest watch/);
    assert.doesNotMatch(ingestReference, /live-database/);
    assert.doesNotMatch(devReference, /ktx scan/);
    assert.doesNotMatch(buildingContext, /ktx ingest watch/);
    assert.doesNotMatch(buildingContext, /ktx ingest status/);
    assert.doesNotMatch(buildingContext, /ktx ingest replay/);
    assert.doesNotMatch(buildingContext, /historic-sql/);
    assert.doesNotMatch(buildingContext, /live-database/);
    assert.doesNotMatch(contextSources, /ktx ingest run --connection-id/);
    assert.doesNotMatch(contextSources, /--adapter <adapter>/);
    assert.doesNotMatch(contextAsCode, /ktx ingest run --connection-id/);
    assert.doesNotMatch(quickstart, /Historic SQL/);
    assert.doesNotMatch(quickstart, /--enable-historic-sql/);
    assert.doesNotMatch(quickstart, /press <kbd>d<\/kbd> to detach/);
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

  it('documents pnpm setup as a prerequisite when optional dev linking fails', async () => {
    const rootReadme = await readText('README.md');

    assert.match(rootReadme, /pnpm run link:dev/);
    assert.match(rootReadme, /ktx-dev --help/);
    assert.doesNotMatch(
      rootReadme,
      /If the setup command reports that pnpm's global bin directory is not on your\n`PATH`, add the printed directory to your shell profile/,
    );
  });

  it('runs the example smoke in the cli smoke script', async () => {
    const packageJson = JSON.parse(await readText('packages/cli/package.json'));

    assert.match(packageJson.scripts.smoke, /src\/standalone-smoke\.test\.ts/);
    assert.match(packageJson.scripts.smoke, /src\/example-smoke\.test\.ts/);
    assert.match(packageJson.scripts.test, /--exclude src\/standalone-smoke\.test\.ts/);
    assert.match(packageJson.scripts.test, /--exclude src\/example-smoke\.test\.ts/);
  });

  it('documents daemon HTTP database, source generation, LookML, embedding, and code execution support', async () => {
    const readme = await readText('python/ktx-daemon/README.md');

    assert.match(readme, /semantic-generate-sources/);
    assert.match(readme, /database-introspect/);
    assert.match(readme, /POST \/database\/introspect/);
    assert.match(readme, /Introspect a Postgres database schema/);
    assert.match(readme, /lookml-parse/);
    assert.match(readme, /embedding-compute/);
    assert.match(readme, /embedding-compute-bulk/);
    assert.match(readme, /code-execute/);
    assert.match(readme, /--enable-code-execution/);
    assert.match(readme, /POST \/semantic-layer\/generate-sources/);
    assert.match(readme, /POST \/lookml\/parse/);
    assert.match(readme, /POST \/embeddings\/compute/);
    assert.match(readme, /POST \/embeddings\/compute-bulk/);
    assert.match(readme, /POST \/code\/execute/);
    assert.match(readme, /Generate semantic-layer sources from schema scan data/);
    assert.match(readme, /Parse LookML projects into resolved, KSL-ready structures/);
    assert.match(readme, /Compute text embeddings locally/);
    assert.match(readme, /Execute Python code with the current in-process boundary/);
    assert.match(readme, /Code execution is off by default/);
    assert.match(readme, /does not provide OS-level sandboxing/);
    assert.doesNotMatch(readme, /source generation are not exposed through this/);
    assert.doesNotMatch(readme, /LookML parsing are not exposed through this/);
    assert.doesNotMatch(readme, /embeddings are not exposed through this server mode/);
    assert.doesNotMatch(readme, /Code execution is not exposed through this server mode/);
  });
});
