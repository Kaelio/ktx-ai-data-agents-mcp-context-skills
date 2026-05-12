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

  it('rejects slash-delimited page keys with a flat-key suggestion', async () => {
    const rootWikiService = { readPageForUser: vi.fn().mockResolvedValue(null) };
    const pagesRepository = { findPageByKey: vi.fn(), incrementUsageCount: vi.fn() };
    const tool = new WikiReadTool(rootWikiService as any, pagesRepository as any);

    const result = await tool.call({ key: 'orbit/company-overview' }, baseContext);

    expect(result.structured).toEqual({
      blockKey: 'orbit/company-overview',
      content: '',
      scope: '',
      found: false,
    });
    expect(result.markdown).toContain(
      'Invalid wiki key "orbit/company-overview". Wiki keys must be flat; use "orbit-company-overview".',
    );
    expect(rootWikiService.readPageForUser).not.toHaveBeenCalled();
  });

  it('does not append derived refs to the editable markdown body', async () => {
    const rootWikiService = {
      readPageForUser: vi.fn().mockResolvedValue({
        pageKey: 'orbit-how-we-work',
        scope: 'GLOBAL',
        frontmatter: { summary: 'How we work', tags: ['policy'], refs: ['orbit-company-overview'] },
        content: '## How We Work\n\nUse written-first operating norms.',
      }),
    };
    const pagesRepository = { findPageByKey: vi.fn().mockResolvedValue(null), incrementUsageCount: vi.fn() };
    const tool = new WikiReadTool(rootWikiService as any, pagesRepository as any);

    const result = await tool.call({ key: 'orbit-how-we-work' }, baseContext);

    expect(result.markdown).toBe('## How We Work\n\nUse written-first operating norms.');
    expect(result.markdown).not.toContain('See also');
    expect(result.markdown).not.toContain('[[orbit-company-overview]]');
    expect(result.structured.refs).toEqual(['orbit-company-overview']);
  });
});
