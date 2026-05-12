import { describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolSession } from '../../tools/index.js';
import { createTouchedSlSources } from '../../tools/index.js';
import type { SemanticLayerSource } from '../types.js';
import { SlDiscoverTool } from './sl-discover.tool.js';

function makeTool() {
  const semanticLayerService = {
    listConnectionIdsWithNames: vi.fn(async () => [] as Array<{ id: string; name: string; connectionType: string }>),
    loadAllSources: vi.fn(async () => [] as SemanticLayerSource[]),
  };
  const slSearchService = {
    search: vi.fn(async () => []),
  };
  const tool = new SlDiscoverTool(
    {
      semanticLayerService: semanticLayerService as never,
      slSearchService: slSearchService as never,
      authorResolver: { resolve: vi.fn() },
    },
    { maxSources: 25, minRrfScore: 0, maxDetailedSources: 5 },
  );
  return { tool, semanticLayerService, slSearchService };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sourceId: 'src',
    messageId: 'msg',
    userId: 'user',
    ...overrides,
  };
}

function makeSession(semanticLayerService: Record<string, unknown>): ToolSession {
  return {
    connectionId: 'dbt-main',
    isWorktreeScoped: true,
    preHead: 'base',
    touchedSlSources: createTouchedSlSources(),
    actions: [],
    semanticLayerService: semanticLayerService as never,
    wikiService: {} as never,
    configService: {} as never,
    gitService: {} as never,
  };
}

describe('SlDiscoverTool - session-scoped reads', () => {
  it('discovers sources through context.session.semanticLayerService when a session is present', async () => {
    const { tool, semanticLayerService } = makeTool();
    const sessionSemanticLayerService = {
      listConnectionIdsWithNames: vi.fn().mockResolvedValue([
        { id: 'warehouse', name: 'warehouse', connectionType: 'postgres' },
      ]),
      loadAllSources: vi.fn().mockResolvedValue([
        {
          name: 'orders',
          table: 'public.orders',
          grain: ['order_id'],
          columns: [{ name: 'order_id', type: 'string' }],
          measures: [],
          joins: [],
        },
      ]),
    };

    const result = await tool.call({}, makeContext({ session: makeSession(sessionSemanticLayerService) }));

    expect(result.structured.totalSources).toBe(1);
    expect(result.structured.sources[0]).toMatchObject({
      connectionId: 'warehouse',
      name: 'orders',
      columnCount: 1,
    });
    expect(sessionSemanticLayerService.listConnectionIdsWithNames).toHaveBeenCalled();
    expect(sessionSemanticLayerService.loadAllSources).toHaveBeenCalledWith('warehouse');
    expect(semanticLayerService.listConnectionIdsWithNames).not.toHaveBeenCalled();
  });
});
