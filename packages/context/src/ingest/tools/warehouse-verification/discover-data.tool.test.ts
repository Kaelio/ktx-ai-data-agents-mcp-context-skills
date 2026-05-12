import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseTool, ToolContext } from '../../../tools/index.js';
import { DiscoverDataTool } from './discover-data.tool.js';
import type { WarehouseCatalogService } from './warehouse-catalog.service.js';

describe('DiscoverDataTool', () => {
  const wikiSearchTool = { call: vi.fn() } as unknown as BaseTool & { call: ReturnType<typeof vi.fn> };
  const slDiscoverTool = { call: vi.fn() } as unknown as BaseTool & { call: ReturnType<typeof vi.fn> };
  const catalog = { searchByName: vi.fn() } as unknown as WarehouseCatalogService & {
    searchByName: ReturnType<typeof vi.fn>;
  };
  const context: ToolContext = {
    sourceId: 'ingest',
    messageId: 'm1',
    userId: 'system',
    session: { allowedConnectionNames: new Set(['warehouse']) } as any,
  };
  const tool = new DiscoverDataTool({
    wikiSearchTool,
    slDiscoverTool,
    catalogFactory: () => catalog,
  });

  beforeEach(() => {
    wikiSearchTool.call.mockReset();
    slDiscoverTool.call.mockReset();
    catalog.searchByName.mockReset();
    wikiSearchTool.call.mockResolvedValue({
      markdown: '- orders wiki',
      structured: { totalFound: 1, results: [{ key: 'orders' }] },
    });
    slDiscoverTool.call.mockResolvedValue({
      markdown: '- orders source',
      structured: { totalSources: 1, sources: [{ sourceName: 'orders' }] },
    });
    catalog.searchByName.mockResolvedValue([
      {
        kind: 'table',
        ref: { catalog: null, db: 'public', name: 'orders' },
        display: 'public.orders',
        matchedOn: 'name',
      },
    ]);
  });

  it('groups wiki, semantic layer, and raw schema hits with routing hints', async () => {
    const result = await tool.call({ query: 'orders', connectionName: 'warehouse', limit: 5 }, context);

    expect(result.markdown).toContain('## Wiki Pages');
    expect(result.markdown).toContain('use `wiki_read(blockKey)` for full content');
    expect(result.markdown).toContain('## Semantic Layer Sources');
    expect(result.markdown).toContain('use `sl_read_source(sourceName)` for the YAML');
    expect(result.markdown).toContain('## Raw Warehouse Schema');
    expect(result.markdown).toContain('use `entity_details({connectionName, targets: [{display}]})`');
    expect(result.structured.raw?.hits).toHaveLength(1);
  });

  it('refuses explicit out-of-scope connection names', async () => {
    const result = await tool.call({ query: 'orders', connectionName: 'billing' }, context);

    expect(result.markdown).toContain('Connection "billing" is not available to this ingest stage.');
    expect(result.structured).toEqual({ wiki: null, sl: null, raw: null });
    expect(wikiSearchTool.call).not.toHaveBeenCalled();
    expect(slDiscoverTool.call).not.toHaveBeenCalled();
    expect(catalog.searchByName).not.toHaveBeenCalled();
  });

  it('delegates sourceName inspect mode to sl_discover only', async () => {
    slDiscoverTool.call.mockResolvedValueOnce({
      markdown: 'source detail',
      structured: { sourceName: 'orders' },
    });

    const result = await tool.call({ sourceName: 'orders', connectionName: 'warehouse' }, context);

    expect(slDiscoverTool.call).toHaveBeenCalledWith({ sourceName: 'orders', connectionId: 'warehouse' }, context);
    expect(wikiSearchTool.call).not.toHaveBeenCalled();
    expect(catalog.searchByName).not.toHaveBeenCalled();
    expect(result.markdown).toContain('source detail');
  });

  it('returns the empty-state message when all sections are empty', async () => {
    wikiSearchTool.call.mockResolvedValueOnce({ markdown: '', structured: { totalFound: 0, results: [] } });
    slDiscoverTool.call.mockResolvedValueOnce({ markdown: '', structured: { totalSources: 0, sources: [] } });
    catalog.searchByName.mockResolvedValueOnce([]);

    const result = await tool.call({ query: 'customer source', connectionName: 'warehouse' }, context);

    expect(result.markdown).toContain('No matches for "customer source" across wiki, semantic layer, or raw warehouse schema.');
  });
});
