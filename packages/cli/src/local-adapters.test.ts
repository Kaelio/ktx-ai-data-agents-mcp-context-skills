import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKtxProject } from './context/project/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKtxCliLocalIngestAdapters } from './local-adapters.js';

function sqlAnalysisStub() {
  return {
    async analyzeForFingerprint(sql: string) {
      return {
        fingerprint: 'fp',
        normalizedSql: sql,
        tablesTouched: [],
        literalSlots: [],
      };
    },
    async analyzeBatch() {
      return new Map();
    },
    async validateReadOnly() {
      return { ok: true };
    },
  };
}

async function writeProject(projectDir: string, body: string): Promise<void> {
  await writeFile(join(projectDir, 'ktx.yaml'), body, 'utf-8');
}

describe('CLI local ingest adapters', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-local-adapters-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('registers Postgres historic SQL from the requested connection', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'warehouse',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('registers Postgres historic SQL from connection context query history', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    readonly: true',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'warehouse',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('registers BigQuery historic SQL from the requested connection', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  bq:',
        '    driver: bigquery',
        '    dataset_id: analytics',
        '    location: us',
        '    credentials_json: \'{"project_id":"demo-project"}\'',
        '    historicSql:',
        '      enabled: true',
        '      dialect: bigquery',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'bq',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('registers Snowflake historic SQL from the requested connection', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  sf:',
        '    driver: snowflake',
        '    account: acct',
        '    warehouse: wh',
        '    database: ANALYTICS',
        '    schema_name: PUBLIC',
        '    username: reader',
        '    password: env:SNOWFLAKE_PASSWORD',
        '    historicSql:',
        '      enabled: true',
        '      dialect: snowflake',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'sf',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('uses query-history wording for public BigQuery capability errors', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  bq:',
        '    driver: bigquery',
        '    readonly: true',
        '    dataset_id: analytics',
        '    credentials_json: "{}"',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    expect(() =>
      createKtxCliLocalIngestAdapters(project, {
        historicSqlConnectionId: 'bq',
        sqlAnalysis: sqlAnalysisStub(),
      }),
    ).toThrow('Query history BigQuery connection requires credentials_json.project_id');
  });
});
