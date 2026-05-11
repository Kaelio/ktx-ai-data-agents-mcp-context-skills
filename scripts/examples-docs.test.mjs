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

function runtimeWheelPackagePattern(text) {
  return new RegExp(text.replaceAll('{package}', escapeRegExp(runtimeWheelPackageName())));
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
    assert.match(config, /project: orbit-relationship-verification/);
    assert.match(config, /orbit:/);
    assert.match(config, /driver: sqlite/);
    assert.match(
      config,
      /path: \.\.\/\.\.\/packages\/context\/test\/fixtures\/relationship-benchmarks\/orbit_style_product_no_declared_constraints\/data\.sqlite/,
    );
    assert.match(config, /readonly: true/);
    assert.match(config, /llm_proposals: false/);
    assert.match(config, /validation_required_for_manifest: true/);
  });

  it('documents the Postgres historic SQL smoke example', async () => {
    const examples = await readText('examples/README.md');
    const readme = await readText('examples/postgres-historic/README.md');
    const compose = await readText('examples/postgres-historic/docker-compose.yml');
    const initSql = await readText('examples/postgres-historic/init/001-schema.sql');
    const workload = await readText('examples/postgres-historic/scripts/generate-workload.sh');
    const smoke = await readText('examples/postgres-historic/scripts/smoke.sh');

    assert.match(examples, /postgres-historic/);
    assert.match(examples, /unified Historic SQL artifacts/);
    assert.match(readme, /--enable-historic-sql/);
    assert.match(readme, /--historic-sql-min-executions 2/);
    assert.match(readme, /ktx dev doctor --project-dir/);
    assert.match(readme, /Postgres Historic SQL/);
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
    assert.match(smoke, /--historic-sql-min-executions 2/);
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
    assert.doesNotMatch(readme, /--historic-sql-min-calls/);
  });

  it('lists every published TypeScript package in the package root README', async () => {
    const rootReadme = await readText('README.md');

    assert.match(rootReadme, /`packages\/context`/);
    assert.match(rootReadme, /`packages\/cli`/);
    assert.match(rootReadme, /`packages\/connector-bigquery`/);
    assert.match(rootReadme, /`packages\/connector-clickhouse`/);
    assert.match(rootReadme, /`packages\/connector-mysql`/);
    assert.match(rootReadme, /`packages\/connector-postgres`/);
    assert.match(rootReadme, /`packages\/connector-snowflake`/);
    assert.match(rootReadme, /`packages\/connector-sqlite`/);
    assert.match(rootReadme, /`packages\/connector-sqlserver`/);
    assert.match(rootReadme, /`python\/ktx-sl`/);
    assert.match(rootReadme, /`python\/ktx-daemon`/);
  });

  it('documents every standalone MCP tool that the CLI server exposes', async () => {
    const rootReadme = await readText('README.md');

    assert.match(rootReadme, /`connection_list`/);
    assert.match(rootReadme, /`knowledge_search`/);
    assert.match(rootReadme, /`knowledge_read`/);
    assert.match(rootReadme, /`knowledge_write`/);
    assert.match(rootReadme, /`sl_list_sources`/);
    assert.match(rootReadme, /`sl_read_source`/);
    assert.match(rootReadme, /`sl_write_source`/);
    assert.match(rootReadme, /`sl_validate`/);
    assert.match(rootReadme, /`sl_query`/);
    assert.match(rootReadme, /`ingest_trigger`/);
    assert.match(rootReadme, /`ingest_status`/);
    assert.match(rootReadme, /`ingest_report`/);
    assert.match(rootReadme, /`ingest_replay`/);
  });

  it('walks through ktx connection list and ktx connection test in the README quickstart', async () => {
    const rootReadme = await readText('README.md');

    assert.match(rootReadme, /connection list --project-dir/);
    assert.match(rootReadme, /connection test warehouse --project-dir/);
    assert.match(rootReadme, /Driver: sqlite/);
    assert.match(rootReadme, /Tables: 1/);
  });

  it('documents public npm and managed runtime usage in the README', async () => {
    const rootReadme = await readText('README.md');

    assert.match(rootReadme, publicPackagePattern('npx {package} setup demo --no-input'));
    assert.match(rootReadme, publicPackagePattern('npx {package} sl query'));
    assert.match(rootReadme, publicPackagePattern('npm install {package}'));
    assert.match(rootReadme, publicPackagePattern('npm install -g {package}'));
    assert.match(rootReadme, /ktx runtime install/);
    assert.match(rootReadme, /ktx runtime status/);
    assert.match(rootReadme, /ktx runtime doctor/);
    assert.match(rootReadme, /ktx runtime start/);
    assert.match(rootReadme, /ktx runtime stop/);
    assert.match(rootReadme, /ktx runtime prune --dry-run/);
    assert.match(rootReadme, /ktx runtime prune --yes/);
    assert.match(rootReadme, /KTX requires `uv` on `PATH`/);
    assert.match(rootReadme, /KTX doesn't download `uv` automatically/);
    assert.match(
      rootReadme,
      runtimeWheelPackagePattern(
        'release\\s+artifact manifest contains the public npm tarball and the\\s+bundled `{package}`\\s+runtime wheel',
      ),
    );
    assert.match(rootReadme, /source packages for\s+development, not public release artifacts/);
    assert.match(rootReadme, /ktx serve --mcp stdio/);
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
    assert.match(readme, /ktx runtime status/);
    assert.match(readme, /ktx runtime doctor/);
    assert.match(readme, /ktx runtime prune --dry-run/);
    assert.match(readme, /ktx runtime prune --yes/);
    assert.doesNotMatch(readme, /@ktx\/context/);
    assert.doesNotMatch(readme, /@ktx\/cli/);
    assert.doesNotMatch(readme, /python -m ktx_daemon semantic-validate/);
  });

  it('replaces the fake-ingest smoke with a ktx scan walkthrough in the README', async () => {
    const rootReadme = await readText('README.md');

    assert.match(rootReadme, /### Scan the demo warehouse/);
    assert.match(rootReadme, /scan warehouse --project-dir/);
    assert.match(rootReadme, /scan status --project-dir/);
    assert.match(rootReadme, /scan report --project-dir/);
    assert.match(rootReadme, /raw-sources\/warehouse\/live-database/);
    assert.doesNotMatch(rootReadme, /Run a local ingest smoke test/);
    assert.doesNotMatch(rootReadme, /ktx dev ingest run --project-dir/);
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
