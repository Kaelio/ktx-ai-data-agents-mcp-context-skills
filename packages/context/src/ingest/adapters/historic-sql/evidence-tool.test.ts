import { describe, expect, it, vi } from 'vitest';
import { asSchema } from 'ai';
import { createEmitHistoricSqlEvidenceTool } from './evidence-tool.js';

describe('emit_historic_sql_evidence tool', () => {
  it('exposes an AI SDK v6 tool input schema with top-level object type', async () => {
    const tool = createEmitHistoricSqlEvidenceTool();

    expect(await asSchema(tool.inputSchema).jsonSchema).toMatchObject({
      type: 'object',
    });
  });

  it('writes table usage evidence to the ignored run evidence directory', async () => {
    const writeFile = vi.fn(async () => ({ success: true, commitHash: null }));
    const tool = createEmitHistoricSqlEvidenceTool();

    const result = await tool.execute!(
      {
        kind: 'table_usage',
        table: 'public.orders',
        rawPath: 'tables/public.orders.json',
        usage: {
          narrative: 'Orders are repeatedly queried by paid status.',
          frequencyTier: 'high',
          commonFilters: ['status'],
          commonJoins: [],
          staleSince: null,
        },
      },
      {
        toolCallId: 'call-1',
        messages: [],
        abortSignal: new AbortController().signal,
        experimental_context: {
          connectionId: 'warehouse',
          session: {
            ingest: { runId: 'run-1', jobId: 'job-1', syncId: 'sync-1', sourceKey: 'historic-sql' },
            configService: { writeFile },
          },
        },
      } as never,
    );

    expect(result).toBe('Recorded historic-SQL table_usage evidence for public.orders.');
    expect(writeFile).toHaveBeenCalledWith(
      '.ktx/ingest-evidence/historic-sql/run-1/historic-sql-table-public-orders.json',
      expect.stringContaining('"kind": "table_usage"'),
      'System User',
      'system@example.com',
      'Record historic-SQL evidence: historic-sql-table-public-orders',
      { skipLock: true },
    );
  });

  it('rejects non-historic ingest sessions', async () => {
    const tool = createEmitHistoricSqlEvidenceTool();

    await expect(
      tool.execute!(
        {
          kind: 'pattern',
          rawPath: 'patterns-input.json',
          pattern: {
            slug: 'orders',
            title: 'Orders',
            narrative: 'Orders pattern.',
            definitionSql: 'select * from public.orders',
            tablesInvolved: ['public.orders'],
            slRefs: ['orders'],
            constituentTemplateIds: ['pg:1'],
          },
        },
        {
          toolCallId: 'call-1',
          messages: [],
          abortSignal: new AbortController().signal,
          experimental_context: {
            connectionId: 'warehouse',
            session: {
              ingest: { runId: 'run-1', jobId: 'job-1', syncId: 'sync-1', sourceKey: 'notion' },
              configService: { writeFile: vi.fn() },
            },
          },
        } as never,
      ),
    ).resolves.toContain('Error: emit_historic_sql_evidence is only available during historic-sql ingest');
  });
});
