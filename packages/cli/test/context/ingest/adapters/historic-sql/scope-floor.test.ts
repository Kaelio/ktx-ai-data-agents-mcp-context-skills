import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveQueryHistoryScopeFloor } from '../../../../../src/context/ingest/adapters/historic-sql/scope-floor.js';

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ktx-qh-scope-'));
}

async function seedLiveScanTable(
  projectDir: string,
  connectionId: string,
  syncId: string,
  table: { catalog: string | null; db: string | null; name: string },
): Promise<void> {
  const root = join(projectDir, 'raw-sources', connectionId, 'live-database', syncId);
  await mkdir(join(root, 'tables'), { recursive: true });
  await writeFile(
    join(root, 'connection.json'),
    `${JSON.stringify({ connectionId, driver: 'postgres' }, null, 2)}\n`,
    'utf-8',
  );
  await writeFile(
    join(root, 'tables', `${table.db ?? 'default'}-${table.name}.json`),
    `${JSON.stringify(
      {
        ...table,
        kind: 'table',
        comment: null,
        estimatedRows: null,
        columns: [],
        foreignKeys: [],
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  await writeFile(
    join(root, 'scan-report.json'),
    `${JSON.stringify(
      {
        connectionId,
        driver: 'postgres',
        syncId,
        runId: `scan-${syncId}`,
        trigger: 'cli',
        mode: 'enriched',
        dryRun: false,
        artifactPaths: {
          rawSourcesDir: `raw-sources/${connectionId}/live-database/${syncId}`,
          reportPath: `raw-sources/${connectionId}/live-database/${syncId}/scan-report.json`,
          manifestShards: [],
          enrichmentArtifacts: [],
        },
        counts: {},
        warnings: [],
        enrichment: {},
        enrichmentState: {},
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

describe('resolveQueryHistoryScopeFloor', () => {
  it('computes modeled schemas from connection schemas plus semantic source tables', async () => {
    const projectDir = await tempProject();
    await mkdir(join(projectDir, 'semantic-layer/warehouse'), { recursive: true });
    await writeFile(
      join(projectDir, 'semantic-layer/warehouse/revenue.yaml'),
      [
        'name: revenue',
        'table: orbit_analytics.mart_revenue',
        'grain: [id]',
        'columns:',
        '  - name: id',
        '    type: string',
        '',
      ].join('\n'),
      'utf-8',
    );
    await seedLiveScanTable(projectDir, 'warehouse', 'sync-1', {
      catalog: null,
      db: 'orbit_raw',
      name: 'accounts',
    });

    const scope = await resolveQueryHistoryScopeFloor({
      projectDir,
      connectionId: 'warehouse',
      driver: 'postgres',
      connection: { driver: 'postgres', schemas: ['orbit_raw'] },
      storedQueryHistory: {},
    });

    expect(scope.enabledSchemas).toEqual(['orbit_analytics', 'orbit_raw']);
    expect(scope.modeledTableCatalog).toEqual([
      { catalog: null, db: 'orbit_analytics', name: 'mart_revenue' },
      { catalog: null, db: 'orbit_raw', name: 'accounts' },
    ]);
    expect(scope.enabledTables).toEqual([]);
    expect(scope.floorDisabled).toBe(false);
  });

  it('uses explicit enabledTables before explicit enabledSchemas and computed scope', async () => {
    const scope = await resolveQueryHistoryScopeFloor({
      projectDir: await tempProject(),
      connectionId: 'warehouse',
      driver: 'postgres',
      connection: { driver: 'postgres', schemas: ['orbit_raw'] },
      storedQueryHistory: {
        enabledTables: ['orbit_analytics.mart_revenue'],
        enabledSchemas: ['orbit_raw'],
      },
    });

    expect(scope.enabledTables).toEqual([{ catalog: null, db: 'orbit_analytics', name: 'mart_revenue' }]);
    expect(scope.enabledSchemas).toEqual([]);
    expect(scope.floorDisabled).toBe(false);
  });

  it('disables the floor for enabledSchemas star', async () => {
    const scope = await resolveQueryHistoryScopeFloor({
      projectDir: await tempProject(),
      connectionId: 'warehouse',
      driver: 'postgres',
      connection: { driver: 'postgres', schemas: ['orbit_raw'] },
      storedQueryHistory: { enabledSchemas: ['*'] },
    });

    expect(scope.enabledTables).toEqual([]);
    expect(scope.enabledSchemas).toEqual(['*']);
    expect(scope.floorDisabled).toBe(true);
  });

  it('adds latest live-database scan tables to the modeled table catalog', async () => {
    const projectDir = await tempProject();
    await mkdir(join(projectDir, 'semantic-layer/warehouse'), { recursive: true });
    await writeFile(
      join(projectDir, 'semantic-layer/warehouse/revenue.yaml'),
      [
        'name: revenue',
        'table: orbit_analytics.mart_revenue',
        'grain: [id]',
        'columns:',
        '  - name: id',
        '    type: string',
        '',
      ].join('\n'),
      'utf-8',
    );
    await seedLiveScanTable(projectDir, 'warehouse', 'sync-1', {
      catalog: null,
      db: 'orbit_raw',
      name: 'accounts',
    });

    const scope = await resolveQueryHistoryScopeFloor({
      projectDir,
      connectionId: 'warehouse',
      driver: 'postgres',
      connection: { driver: 'postgres', schemas: ['orbit_raw'] },
      storedQueryHistory: {},
    });

    expect(scope.enabledSchemas).toEqual(['orbit_analytics', 'orbit_raw']);
    expect(scope.modeledTableCatalog).toEqual([
      { catalog: null, db: 'orbit_analytics', name: 'mart_revenue' },
      { catalog: null, db: 'orbit_raw', name: 'accounts' },
    ]);
    expect(scope.warnings).toEqual([]);
    expect(scope.floorDisabled).toBe(false);
  });

  it('fails open when schema scope exists but the scan catalog is unavailable', async () => {
    const scope = await resolveQueryHistoryScopeFloor({
      projectDir: await tempProject(),
      connectionId: 'warehouse',
      driver: 'postgres',
      connection: { driver: 'postgres', schemas: ['orbit_raw'] },
      storedQueryHistory: {},
    });

    expect(scope.enabledTables).toEqual([]);
    expect(scope.enabledSchemas).toEqual(['*']);
    expect(scope.modeledTableCatalog).toEqual([]);
    expect(scope.floorDisabled).toBe(true);
    expect(scope.warnings).toContain('query_history_scope_floor_disabled:catalog_unavailable');
  });
});
