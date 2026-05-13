import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../tools/index.js';
import { createTouchedSlSources, hasTouchedSlSource, type ToolContext } from '../../tools/index.js';
import { SlWriteSourceTool } from './sl-write-source.tool.js';

function makeTool(overrides: Partial<Record<string, any>> = {}) {
  const semanticLayerService = {
    listManifestSourceNames: vi.fn().mockResolvedValue(['ACCOUNTS', 'ORDERS']),
    isManifestBacked: vi.fn().mockResolvedValue(false),
    loadSource: vi.fn().mockResolvedValue(null),
    loadAllSources: vi.fn().mockResolvedValue([]),
    validateWithProposedSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
    writeSource: vi.fn().mockResolvedValue({ commitHash: 'c1' }),
    deleteSource: vi.fn().mockResolvedValue(undefined),
    readSourceFile: vi.fn().mockRejectedValue(new Error('not found')),
    ...overrides.semanticLayerService,
  };
  const slSearchService = {
    indexSources: vi.fn().mockResolvedValue(undefined),
    ...overrides.slSearchService,
  };
  const tool = new SlWriteSourceTool({
    semanticLayerService: semanticLayerService as never,
    slSearchService: slSearchService as never,
    authorResolver: { resolve: vi.fn().mockResolvedValue({ name: 'T U', email: 't@u.com' }) },
  });
  return { tool, semanticLayerService, slSearchService };
}

const baseContext: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u' };

describe('SlWriteSourceTool — orphan overlay guard', () => {
  it('rejects overlay YAMLs targeting a name absent from the manifest', async () => {
    const { tool } = makeTool();
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'does_not_exist',
        source: {
          name: 'does_not_exist',
          measures: [{ name: 'count_rows', expr: 'count(*)' }],
        } as any,
      } as any,
      baseContext,
    );
    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/no manifest entry with that name exists/i);
    expect(result.markdown).toMatch(/ACCOUNTS|ORDERS/);
  });
});

describe('SlWriteSourceTool — session gating', () => {
  function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
    return {
      connectionId: '11111111-1111-1111-1111-111111111111',
      isWorktreeScoped: true,
      preHead: 'base',
      touchedSlSources: createTouchedSlSources(),
      actions: [],
      semanticLayerService: {
        loadSource: vi.fn().mockResolvedValue(null),
        loadAllSources: vi.fn().mockResolvedValue([]),
        validateWithProposedSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
        writeSource: vi.fn().mockResolvedValue({ commitHash: 'c1' }),
        deleteSource: vi.fn().mockResolvedValue(undefined),
        listManifestSourceNames: vi.fn().mockResolvedValue([]),
        isManifestBacked: vi.fn().mockResolvedValue(false),
        readSourceFile: vi.fn().mockRejectedValue(new Error('not found')),
        findManifestEntryByTableRef: vi.fn().mockResolvedValue(null),
      } as any,
      wikiService: {} as any,
      configService: {} as any,
      gitService: {} as any,
      ...overrides,
    };
  }

  it('skips slSearchService.indexSources when session is worktree-scoped', async () => {
    const { tool, slSearchService } = makeTool();
    const session = makeSession();
    const context: ToolContext = { ...baseContext, session };
    const result = await tool.call(
      {
        connectionId: session.connectionId,
        sourceName: 'my_source',
        source: {
          name: 'my_source',
          sql: 'select 1 as id',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string' }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      context,
    );
    expect(result.structured.success).toBe(true);
    expect(slSearchService.indexSources).not.toHaveBeenCalled();
    expect(hasTouchedSlSource(session.touchedSlSources, session.connectionId!, 'my_source')).toBe(true);
    expect(session.actions).toContainEqual(expect.objectContaining({ target: 'sl', key: 'my_source' }));
  });

  it('records cross-connection SL writes with targetConnectionId', async () => {
    const { tool } = makeTool();
    const session = makeSession({ connectionId: '11111111-1111-4111-8111-111111111111' });
    const warehouseConnectionId = '22222222-2222-4222-8222-222222222222';
    const context: ToolContext = { ...baseContext, session };

    const result = await tool.call(
      {
        connectionId: warehouseConnectionId,
        sourceName: 'mapped_orders',
        source: {
          name: 'mapped_orders',
          table: 'public.orders',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string' }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      context,
    );

    expect(result.structured.success).toBe(true);
    expect(hasTouchedSlSource(session.touchedSlSources, warehouseConnectionId, 'mapped_orders')).toBe(true);
    expect(session.actions).toContainEqual(
      expect.objectContaining({
        target: 'sl',
        key: 'mapped_orders',
        targetConnectionId: warehouseConnectionId,
      }),
    );
  });

  it('indexes normally when no session is present', async () => {
    const { tool, slSearchService } = makeTool();
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'my_source',
        source: {
          name: 'my_source',
          sql: 'select 1 as id',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string' }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      baseContext,
    );
    expect(result.structured.success).toBe(true);
    expect(slSearchService.indexSources).toHaveBeenCalledTimes(1);
  });

  it('uses session.semanticLayerService when session is present', async () => {
    const { tool } = makeTool();
    const session = makeSession();
    const context: ToolContext = { ...baseContext, session };
    await tool.call(
      {
        connectionId: session.connectionId,
        sourceName: 'my_source',
        source: {
          name: 'my_source',
          sql: 'select 1 as id',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string' }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      context,
    );
    expect((session.semanticLayerService as any).writeSource).toHaveBeenCalled();
  });

  it('writes source and column description maps', async () => {
    const { tool, semanticLayerService } = makeTool();
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'orders',
        source: {
          name: 'orders',
          descriptions: { user: 'Finance orders used for invoice reconciliation.' },
          table: 'public.orders',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string', descriptions: { user: 'Stable order identifier.' } }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      baseContext,
    );

    expect(result.structured.success).toBe(true);
    expect(semanticLayerService.writeSource).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        descriptions: { user: 'Finance orders used for invoice reconciliation.' },
        columns: [expect.objectContaining({ descriptions: { user: 'Stable order identifier.' } })],
      }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('fills missing descriptions for ingest-written overlays and columns', async () => {
    const session = makeSession({
      ingest: { runId: 'run-1', jobId: 'job-1', syncId: 'sync-1', sourceKey: 'metabase' },
      semanticLayerService: {
        loadSource: vi.fn().mockResolvedValue(null),
        loadAllSources: vi.fn().mockResolvedValue([]),
        validateWithProposedSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
        writeSource: vi.fn().mockResolvedValue({ commitHash: 'c1' }),
        deleteSource: vi.fn().mockResolvedValue(undefined),
        listManifestSourceNames: vi.fn().mockResolvedValue(['mart_account_segments']),
        isManifestBacked: vi.fn().mockResolvedValue(false),
        readSourceFile: vi.fn().mockRejectedValue(new Error('not found')),
        findManifestEntryByTableRef: vi.fn().mockResolvedValue(null),
      } as any,
    });
    const { tool } = makeTool();

    const result = await tool.call(
      {
        connectionId: session.connectionId,
        sourceName: 'mart_account_segments',
        source: {
          name: 'mart_account_segments',
          columns: [{ name: 'is_large_contract', type: 'boolean', expr: 'contract_arr_cents >= 20000000' }],
          measures: [{ name: 'account_count', expr: 'count(account_id)' }],
        } as any,
      } as any,
      { ...baseContext, session },
    );

    expect(result.structured.success).toBe(true);
    expect((session.semanticLayerService as any).writeSource).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        descriptions: {
          ktx: expect.stringContaining('mart_account_segments'),
        },
        columns: [
          expect.objectContaining({
            descriptions: {
              ktx: expect.stringContaining('is large contract'),
            },
          }),
        ],
      }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });
});

describe('SlWriteSourceTool — disconnected-components warning in markdown', () => {
  it('surfaces validation warnings (including disconnected-components) in the markdown body', async () => {
    const { tool } = makeTool({
      semanticLayerService: {
        validateWithProposedSource: vi.fn().mockResolvedValue({
          errors: [],
          warnings: ['orders: disconnected-components — no join path to ACCOUNTS'],
        }),
      },
    });
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'orders',
        source: {
          name: 'orders',
          sql: 'select 1 as id',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string' }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      baseContext,
    );
    expect(result.markdown).toMatch(/disconnected-components/i);
  });

  it('renders per-source warnings prominently when the just-written source becomes a singleton component', async () => {
    const { tool } = makeTool({
      semanticLayerService: {
        validateWithProposedSource: vi.fn().mockResolvedValue({
          errors: [],
          warnings: ['Model has 2 disconnected components.'],
          perSourceWarnings: {
            foo: ["Source 'foo' is now a singleton component (no joins to any other source)."],
          },
        }),
      },
    });

    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'foo',
        source: {
          name: 'foo',
          sql: 'select 1 as id',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string' }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      baseContext,
    );

    expect(result.markdown).toMatch(/Action required/i);
    expect(result.markdown).toContain("Source 'foo' is now a singleton component");
  });
});

describe('SlWriteSourceTool — standalone shadow guard', () => {
  it('rejects standalone YAMLs that shadow a manifest entry', async () => {
    const { tool } = makeTool({
      semanticLayerService: {
        isManifestBacked: vi.fn().mockResolvedValue(true),
      },
    });
    const result = await tool.call(
      {
        connectionId: '11111111-1111-1111-1111-111111111111',
        sourceName: 'ACCOUNTS',
        source: {
          name: 'ACCOUNTS',
          table: 'raw.accounts',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string' }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      baseContext,
    );
    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/shadows an existing manifest entry|already exists/i);
  });
});
