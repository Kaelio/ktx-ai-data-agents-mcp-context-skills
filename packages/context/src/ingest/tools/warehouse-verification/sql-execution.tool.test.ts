import { describe, expect, it, vi } from 'vitest';
import type { SlConnectionCatalogPort } from '../../../sl/index.js';
import type { ToolContext } from '../../../tools/index.js';
import { SqlExecutionTool } from './sql-execution.tool.js';

describe('SqlExecutionTool', () => {
  const connections = {
    executeQuery: vi.fn(),
  } as unknown as SlConnectionCatalogPort & { executeQuery: ReturnType<typeof vi.fn> };
  const tool = new SqlExecutionTool(connections);
  const context: ToolContext = {
    sourceId: 'ingest',
    messageId: 'm1',
    userId: 'system',
    session: { allowedConnectionNames: new Set(['warehouse']) } as any,
  };

  it('wraps read-only SQL with a capped row limit', async () => {
    connections.executeQuery.mockResolvedValue({ headers: ['status'], rows: [['paid']], totalRows: 1 });

    const result = await tool.call(
      { connectionName: 'warehouse', sql: 'select status from public.orders', rowLimit: 5 },
      context,
    );

    expect(connections.executeQuery).toHaveBeenCalledWith(
      'warehouse',
      'select * from (select status from public.orders) as ktx_query_result limit 5',
    );
    expect(result.markdown).toContain('| status |');
    expect(result.structured.wrappedSql).toContain('limit 5');
  });

  it.each(['insert into x values (1)', 'drop table x', 'vacuum'])('rejects mutating SQL: %s', async (sql) => {
    connections.executeQuery.mockClear();

    const result = await tool.call({ connectionName: 'warehouse', sql }, context);

    expect(result.markdown).toContain('Only read-only SELECT/WITH queries can be executed locally.');
    expect(connections.executeQuery).not.toHaveBeenCalled();
  });

  it('surfaces connector errors verbatim', async () => {
    connections.executeQuery.mockRejectedValue(new Error('relation "orbit_analytics.customer" does not exist'));

    const result = await tool.call(
      { connectionName: 'warehouse', sql: 'select 1 from orbit_analytics.customer', rowLimit: 1 },
      context,
    );

    expect(result.markdown).toContain('relation "orbit_analytics.customer" does not exist');
    expect(result.structured.error).toContain('relation "orbit_analytics.customer" does not exist');
  });
});
