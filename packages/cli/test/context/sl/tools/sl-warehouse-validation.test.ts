import { describe, expect, it, vi } from 'vitest';
import { validateSingleSource } from '../../../../src/context/sl/tools/sl-warehouse-validation.js';

function makeDeps(opts: { sourceYaml: string; executeQuery: ReturnType<typeof vi.fn> }) {
  return {
    semanticLayerService: {
      readSourceFile: vi.fn().mockResolvedValue({ content: opts.sourceYaml, path: 'x' }),
      isManifestBacked: vi.fn().mockResolvedValue(false),
      listManifestSourceNames: vi.fn().mockResolvedValue([]),
      loadSource: vi.fn().mockResolvedValue(null),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      validatePhysicalTableReferences: vi.fn().mockResolvedValue([]),
    } as never,
    connections: {
      executeQuery: opts.executeQuery,
      getConnectionById: vi.fn().mockResolvedValue({ id: 'conn-1', name: 'conn-1', connectionType: 'bigquery' }),
      listEnabledConnections: vi.fn().mockResolvedValue([]),
    } as never,
    configService: {} as never,
    gitService: {} as never,
    slSourcesRepository: { deleteByConnectionAndName: vi.fn().mockResolvedValue(undefined) } as never,
    probeRowCount: 1,
  };
}

describe('validateSingleSource warehouse dry-run', () => {
  it('surfaces warehouse error when dry-run fails on unknown column', async () => {
    const yaml = `name: fct_arr_delta
source_type: sql
sql: |
  SELECT * FROM analytics.fct_arr_delta WHERE date_date < CURRENT_DATE()
grain: [date_date]
columns:
  - name: date_date
    type: time
measures:
  - name: count_delta_events
    expr: count(*)
joins: []
`;
    const executeQuery = vi.fn().mockRejectedValue(new Error('Unrecognized name: date_date at [1:42]'));
    const deps = makeDeps({ sourceYaml: yaml, executeQuery });
    const result = await validateSingleSource(deps, 'conn-1', 'fct_arr_delta');
    expect(result.errors.join('\n')).toMatch(/Unrecognized name: date_date/);
    expect(result.errors.join('\n')).toMatch(/embedded sql dry-run failed/);
  });

  it('flags declared columns missing from the dry-run result', async () => {
    const yaml = `name: fct_arr_delta
source_type: sql
sql: |
  SELECT date, customer_id FROM analytics.fct_arr_delta
columns:
  - name: date_date
    type: time
  - name: customer_id
    type: string
measures:
  - name: count_delta
    expr: count(*)
joins: []
grain: [customer_id]
`;
    const executeQuery = vi.fn().mockResolvedValue({
      headers: ['date', 'customer_id'],
      rows: [],
      totalRows: 0,
      error: null,
    });
    const deps = makeDeps({ sourceYaml: yaml, executeQuery });
    const result = await validateSingleSource(deps, 'conn-1', 'fct_arr_delta');
    expect(result.errors.join('\n')).toMatch(/declared columns absent from sql result — date_date/);
    expect(result.errors.join('\n')).toMatch(/warehouse returned:/);
  });

  it('passes cleanly when dry-run succeeds and declared columns match', async () => {
    const yaml = `name: lab_results
source_type: sql
sql: |
  SELECT lab_order_id, admin_user_id FROM analytics.raw_lab_results
grain: [lab_order_id]
columns:
  - name: lab_order_id
    type: string
  - name: admin_user_id
    type: string
measures:
  - name: count_lab_results
    expr: count(lab_order_id)
joins: []
`;
    const executeQuery = vi.fn().mockResolvedValue({
      headers: ['lab_order_id', 'admin_user_id'],
      rows: [],
      totalRows: 0,
      error: null,
    });
    const deps = makeDeps({ sourceYaml: yaml, executeQuery });
    const result = await validateSingleSource(deps, 'conn-1', 'lab_results');
    expect(result.errors).toEqual([]);
  });

  it('uses LIMIT 1 (not LIMIT 0) so runtime policies fire', async () => {
    const yaml = `name: foo
source_type: sql
sql: |
  SELECT a FROM analytics.bar
grain: [a]
columns:
  - {name: a, type: string}
measures: []
joins: []
`;
    const executeQuery = vi.fn().mockResolvedValue({ headers: ['a'], rows: [], totalRows: 0, error: null });
    const deps = makeDeps({ sourceYaml: yaml, executeQuery });
    await validateSingleSource(deps, 'conn-1', 'foo');
    const probeSql = executeQuery.mock.calls[0][1] as string;
    expect(probeSql).toMatch(/LIMIT 1\b/);
    expect(probeSql).not.toMatch(/LIMIT 0\b/);
  });

  it('adds physical manifest errors for table-backed sources', async () => {
    const yaml = `name: int_active_contract_arr
table: orbit_analytics.int_active_contract_arr
grain: [contract_id]
columns:
  - {name: contract_id, type: string}
  - {name: arr_cents, type: number}
measures:
  - {name: arr, expr: sum(arr_cents)}
joins: []
`;
    const executeQuery = vi.fn();
    const deps = makeDeps({ sourceYaml: yaml, executeQuery }) as any;
    deps.semanticLayerService.validatePhysicalTableReferences.mockResolvedValue([
      'int_active_contract_arr.yaml: declared column(s) absent from physical table: arr_cents',
    ]);

    const result = await validateSingleSource(deps, 'conn-1', 'int_active_contract_arr');

    expect(result.errors).toContain(
      'int_active_contract_arr.yaml: declared column(s) absent from physical table: arr_cents',
    );
    expect(executeQuery).not.toHaveBeenCalled();
  });
});
