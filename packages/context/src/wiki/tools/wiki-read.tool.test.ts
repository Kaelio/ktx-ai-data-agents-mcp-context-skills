import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../tools/index.js';
import { createTouchedSlSources, type ToolContext } from '../../tools/index.js';
import { WikiReadTool } from './wiki-read.tool.js';

describe('WikiReadTool', () => {
  const baseContext: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u' };

  it('reads from the session wiki service when a worktree-scoped ingest session is present', async () => {
    const rootWikiService = { readPageForUser: vi.fn().mockResolvedValue(null) };
    const sessionWikiService = {
      readPageForUser: vi.fn().mockResolvedValue({
        pageKey: 'staged-page',
        scope: 'GLOBAL',
        frontmatter: { summary: 'Staged', tags: ['notion'], refs: ['related'] },
        content: 'A page written earlier in the same ingest worktree.',
      }),
    };
    const pagesRepository = { findPageByKey: vi.fn().mockResolvedValue({ id: 'page-1' }), incrementUsageCount: vi.fn() };
    const tool = new WikiReadTool(rootWikiService as any, pagesRepository as any);
    const session: ToolSession = {
      connectionId: 'c',
      isWorktreeScoped: true,
      preHead: null,
      touchedSlSources: createTouchedSlSources(),
      actions: [],
      semanticLayerService: {} as any,
      wikiService: sessionWikiService as any,
      configService: {} as any,
      gitService: {} as any,
    };

    const result = await tool.call({ key: 'staged-page' }, { ...baseContext, session });

    expect(rootWikiService.readPageForUser).not.toHaveBeenCalled();
    expect(sessionWikiService.readPageForUser).toHaveBeenCalledWith('u', 'staged-page');
    expect(result.structured).toMatchObject({ found: true, blockKey: 'staged-page', scope: 'GLOBAL' });
    expect(result.markdown).toContain('A page written earlier in the same ingest worktree.');
  });
});
