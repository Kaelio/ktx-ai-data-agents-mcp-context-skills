import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/context/tools/base-tool.js';
import { WikiListTagsTool } from '../../../../src/context/wiki/tools/wiki-list-tags.tool.js';

describe('WikiListTagsTool', () => {
  const baseContext: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u' };

  it("returns distinct sorted tags across the user's visible pages", async () => {
    const pagesRepository = {
      listPagesForUser: vi.fn().mockResolvedValue([
        { scope: 'GLOBAL', scope_id: null, page_key: 'k1', tags: ['metrics', 'finance'] },
        { scope: 'USER', scope_id: 'u', page_key: 'k2', tags: ['metrics'] },
      ]),
    };
    const tool = new WikiListTagsTool(pagesRepository as any);

    const result = await tool.call({}, baseContext);
    expect(result.markdown).toContain('finance');
    expect(result.markdown).toContain('metrics');
    expect(result.structured.tags).toEqual(['finance', 'metrics']);
  });

  it('lists tags from historic-SQL indexed pages with flat wiki keys', async () => {
    const pagesRepository = {
      listPagesForUser: vi.fn().mockResolvedValue([
        { scope: 'GLOBAL', scope_id: null, page_key: 'company-overview', tags: ['notion'] },
        { scope: 'GLOBAL', scope_id: null, page_key: 'historic-sql-revenue-pattern', tags: ['historic-sql', 'pattern'] },
      ]),
    };
    const tool = new WikiListTagsTool(pagesRepository as any);

    const result = await tool.call({}, baseContext);

    expect(result.structured.tags).toEqual(['historic-sql', 'notion', 'pattern']);
  });

  it('returns a friendly message when no pages have tags', async () => {
    const pagesRepository = { listPagesForUser: vi.fn().mockResolvedValue([]) };
    const tool = new WikiListTagsTool(pagesRepository as any);

    const result = await tool.call({}, baseContext);
    expect(result.markdown).toMatch(/no tags/i);
  });
});
