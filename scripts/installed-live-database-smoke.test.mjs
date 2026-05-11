import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDockerRunArgs,
  buildKtxYaml,
  buildLiveDatabaseIngestArgs,
  buildLiveDatabaseStatusArgs,
  buildPostgresUrl,
  buildPostgresReadyArgs,
  buildSeedSql,
  buildSetupNewProjectArgs,
  smokeContainerName,
} from './installed-live-database-smoke.mjs';

describe('installed live-database artifact smoke helpers', () => {
  it('builds a deterministic disposable Postgres container command', () => {
    assert.deepEqual(
      buildDockerRunArgs({
        containerName: 'ktx-live-db-smoke-test',
        hostPort: 15432,
        image: 'postgres:16-alpine',
      }),
      [
        'run',
        '--rm',
        '-d',
        '--name',
        'ktx-live-db-smoke-test',
        '-e',
        'POSTGRES_PASSWORD=postgres', // pragma: allowlist secret
        '-e',
        'POSTGRES_USER=ktx',
        '-e',
        'POSTGRES_DB=warehouse',
        '-p',
        '127.0.0.1:15432:5432',
        'postgres:16-alpine',
      ],
    );
  });

  it('uses a collision-resistant Docker container name prefix', () => {
    assert.match(smokeContainerName(1234, 5678), /^ktx-live-db-smoke-1234-5678$/);
  });

  it('builds the Postgres URL used by ktx.yaml and daemon introspection', () => {
    assert.equal(
      buildPostgresUrl(15432),
      'postgresql://ktx:postgres@127.0.0.1:15432/warehouse', // pragma: allowlist secret
    );
  });

  it('writes a live-database-only KTX project config with SQLite local state', () => {
    assert.equal(
      buildKtxYaml('postgresql://ktx:postgres@127.0.0.1:15432/warehouse'), // pragma: allowlist secret
      [
        'project: artifact-live-database',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: "postgresql://ktx:postgres@127.0.0.1:15432/warehouse"', // pragma: allowlist secret
        '    readonly: true',
        'storage:',
        '  state: sqlite',
        '  search: sqlite-fts5',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '',
      ].join('\n'),
    );
  });

  it('seeds comments and a foreign key for daemon catalog introspection', () => {
    const sql = buildSeedSql();

    assert.match(sql, /CREATE TABLE customers/);
    assert.match(sql, /CREATE TABLE orders/);
    assert.match(sql, /REFERENCES customers\(id\)/);
    assert.match(sql, /COMMENT ON TABLE orders IS 'Orders captured by the artifact smoke'/);
    assert.match(sql, /COMMENT ON COLUMN orders.amount IS 'Order amount in cents'/);
    assert.match(sql, /INSERT INTO orders/);
  });

  it('waits for a real SQL connection to the target Postgres database', () => {
    assert.deepEqual(buildPostgresReadyArgs('ktx-live-db-smoke-test'), [
      'exec',
      'ktx-live-db-smoke-test',
      'psql',
      '-U',
      'ktx',
      '-d',
      'warehouse',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'SELECT 1;',
    ]);
  });

  it('builds installed CLI live-database ingest and status commands', () => {
    assert.deepEqual(buildSetupNewProjectArgs('/tmp/project'), [
      'exec',
      'ktx',
      'setup',
      '--new',
      '--project-dir',
      '/tmp/project',
      '--skip-llm',
      '--skip-embeddings',
      '--skip-databases',
      '--skip-sources',
      '--no-input',
    ]);

    assert.deepEqual(buildLiveDatabaseIngestArgs('/tmp/project', 'http://127.0.0.1:8765'), [
      'exec',
      'ktx',
      'dev',
      'ingest',
      'run',
      '--project-dir',
      '/tmp/project',
      '--connection-id',
      'warehouse',
      '--adapter',
      'live-database',
      '--database-introspection-url',
      'http://127.0.0.1:8765',
    ]);

    assert.deepEqual(buildLiveDatabaseStatusArgs('/tmp/project', 'local-run-1'), [
      'exec',
      'ktx',
      'ingest',
      'status',
      '--project-dir',
      '/tmp/project',
      'local-run-1',
    ]);
  });
});
