import { describe, expect, it, vi } from 'vitest';
import { WikiSearchTool } from '../../../../src/context/wiki/tools/wiki-search.tool.js';

describe('WikiSearchTool', () => {
  it('searches through the injected wiki adapter port', async () => {
    const search = vi.fn(async () => ({
      results: [
        {
          key: 'metrics-revenue',
          path: 'wiki/global/metrics-revenue.md',
          scope: 'GLOBAL' as const,
          summary: 'Revenue metric definition',
          score: 0.02459016393442623,
          matchReasons: ['lexical' as const, 'token' as const],
        },
      ],
      totalFound: 1,
    }));
    const tool = new WikiSearchTool({ search });

    const result = await tool.call(
      { query: 'paid order', limit: 5 },
      { sourceId: 'test', messageId: 'message-1', userId: 'agent' },
    );

    expect(search).toHaveBeenCalledWith({ userId: 'agent', query: 'paid order', limit: 5 });
    expect(result.structured).toEqual({
      results: [
        {
          blockKey: 'metrics-revenue',
          path: 'wiki/global/metrics-revenue.md',
          summary: 'Revenue metric definition',
          score: 0.02459016393442623,
          matchReasons: ['lexical', 'token'],
        },
      ],
      totalFound: 1,
    });
    expect(result.markdown).toContain('**metrics-revenue**');
  });
});
