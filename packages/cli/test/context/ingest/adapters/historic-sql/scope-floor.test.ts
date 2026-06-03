import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveQueryHistoryScopeFloor } from '../../../../../src/context/ingest/adapters/historic-sql/scope-floor.js';

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ktx-qh-scope-'));
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

    const scope = await resolveQueryHistoryScopeFloor({
      projectDir,
      connectionId: 'warehouse',
      driver: 'postgres',
      connection: { driver: 'postgres', schemas: ['orbit_raw'] },
      storedQueryHistory: {},
    });

    expect(scope.enabledSchemas).toEqual(['orbit_analytics', 'orbit_raw']);
    expect(scope.modeledTableCatalog).toEqual([{ catalog: null, db: 'orbit_analytics', name: 'mart_revenue' }]);
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
});
