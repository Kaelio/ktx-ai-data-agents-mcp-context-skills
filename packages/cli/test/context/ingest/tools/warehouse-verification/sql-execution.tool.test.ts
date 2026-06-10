import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlConnectionCatalogPort } from '../../../../../src/context/sl/ports.js';
import type { SqlAnalysisPort } from '../../../../../src/context/sql-analysis/ports.js';
import type { ToolContext } from '../../../../../src/context/tools/base-tool.js';
import { SqlExecutionTool } from '../../../../../src/context/ingest/tools/warehouse-verification/sql-execution.tool.js';

describe('SqlExecutionTool', () => {
  const connections = {
    executeQuery: vi.fn(),
    getConnectionById: vi.fn(async () => ({ id: 'warehouse', name: 'warehouse', connectionType: 'POSTGRESQL' })),
  } as unknown as SlConnectionCatalogPort & {
    executeQuery: ReturnType<typeof vi.fn>;
    getConnectionById: ReturnType<typeof vi.fn>;
  };
  const sqlAnalysis = {
    validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
  } as unknown as SqlAnalysisPort & { validateReadOnly: ReturnType<typeof vi.fn> };
  const tool = new SqlExecutionTool(connections, sqlAnalysis);
  const context: ToolContext = {
    sourceId: 'ingest',
    messageId: 'm1',
    userId: 'system',
    session: { allowedConnectionNames: new Set(['warehouse']) } as any,
  };

  beforeEach(() => {
    connections.executeQuery.mockReset();
    connections.getConnectionById.mockReset();
    connections.getConnectionById.mockResolvedValue({ id: 'warehouse', name: 'warehouse', connectionType: 'POSTGRESQL' });
    sqlAnalysis.validateReadOnly.mockReset();
    sqlAnalysis.validateReadOnly.mockResolvedValue({ ok: true, error: null });
  });

  it('validates with the parser-backed validator in the connection dialect, then wraps with a capped row limit', async () => {
    connections.executeQuery.mockResolvedValue({ headers: ['status'], rows: [['paid']], totalRows: 1 });

    const result = await tool.call(
      { connectionId: 'warehouse', sql: 'select status from public.orders', rowLimit: 5 },
      context,
    );

    expect(sqlAnalysis.validateReadOnly).toHaveBeenCalledWith('select status from public.orders', 'postgres');
    expect(connections.executeQuery).toHaveBeenCalledWith(
      'warehouse',
      'select * from (select status from public.orders) as ktx_query_result limit 5',
    );
    expect(result.markdown).toContain('| status |');
    expect(result.structured.wrappedSql).toContain('limit 5');
  });

  it('maps connection types to sqlglot dialects', async () => {
    connections.getConnectionById.mockResolvedValue({ id: 'warehouse', name: 'warehouse', connectionType: 'SNOWFLAKE' });
    connections.executeQuery.mockResolvedValue({ headers: [], rows: [], totalRows: 0 });

    await tool.call({ connectionId: 'warehouse', sql: 'select 1' }, context);

    expect(sqlAnalysis.validateReadOnly).toHaveBeenCalledWith('select 1', 'snowflake');
  });

  it('returns the validator error without executing when validation fails', async () => {
    sqlAnalysis.validateReadOnly.mockResolvedValue({ ok: false, error: 'SQL contains read/write operation: Insert' });

    const result = await tool.call(
      { connectionId: 'warehouse', sql: 'with x as (insert into t values (1) returning *) select * from x' },
      context,
    );

    expect(result.markdown).toContain('SQL contains read/write operation: Insert');
    expect(result.structured.error).toContain('SQL contains read/write operation: Insert');
    expect(connections.executeQuery).not.toHaveBeenCalled();
  });

  it('throws when no parser-backed validator is configured', async () => {
    const unvalidated = new SqlExecutionTool(connections);

    await expect(unvalidated.call({ connectionId: 'warehouse', sql: 'select 1' }, context)).rejects.toThrow(
      'sql_execution requires parser-backed SQL validation.',
    );
    expect(connections.executeQuery).not.toHaveBeenCalled();
  });

  it.each(['insert into x values (1)', 'drop table x', 'vacuum'])(
    'keeps the local backstop even when the validator approves: %s',
    async (sql) => {
      const result = await tool.call({ connectionId: 'warehouse', sql }, context);

      expect(result.markdown).toContain('Only read-only SELECT/WITH queries can be executed locally.');
      expect(connections.executeQuery).not.toHaveBeenCalled();
    },
  );

  it('surfaces connector errors verbatim', async () => {
    connections.executeQuery.mockRejectedValue(new Error('relation "orbit_analytics.customer" does not exist'));

    const result = await tool.call(
      { connectionId: 'warehouse', sql: 'select 1 from orbit_analytics.customer', rowLimit: 1 },
      context,
    );

    expect(result.markdown).toContain('relation "orbit_analytics.customer" does not exist');
    expect(result.structured.error).toContain('relation "orbit_analytics.customer" does not exist');
  });

  it('uses connectionId as the public input field', () => {
    const legacyConnectionField = ['connection', 'Name'].join('');

    expect(
      tool.parseInput({
        connectionId: 'warehouse',
        sql: 'select 1',
        rowLimit: 5,
      }),
    ).toEqual({
      connectionId: 'warehouse',
      sql: 'select 1',
      rowLimit: 5,
    });

    expect(() =>
      tool.parseInput({
        [legacyConnectionField]: 'warehouse',
        sql: 'select 1',
        rowLimit: 5,
      }),
    ).toThrow();
  });
});
