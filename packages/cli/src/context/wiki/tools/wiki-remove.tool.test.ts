import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../../context/tools/tool-session.js';
import { createTouchedSlSources } from '../../../context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../../context/tools/base-tool.js';
import { WikiRemoveTool } from './wiki-remove.tool.js';

describe('WikiRemoveTool', () => {
  const baseContext: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u' };

  it('removes an existing page when no session is present', async () => {
    const wikiService = {
      deletePage: vi.fn().mockResolvedValue(undefined),
      deleteFromIndex: vi.fn().mockResolvedValue(undefined),
    };
    const pagesRepository = {
      findPageByKey: vi.fn().mockResolvedValue({ page_key: 'old' }),
    };
    const knowledgeRepository = { createEvent: vi.fn().mockResolvedValue(undefined) };
    const tool = new WikiRemoveTool(wikiService as any, pagesRepository as any, knowledgeRepository as any);
    const result = await tool.call({ key: 'old' } as any, baseContext);
    expect(wikiService.deletePage).toHaveBeenCalledTimes(1);
    expect(wikiService.deleteFromIndex).toHaveBeenCalledTimes(1);
    expect(result.markdown).toMatch(/removed/i);
  });

  it('rejects slash-delimited page keys with a flat-key suggestion', async () => {
    const wikiService = {
      deletePage: vi.fn().mockResolvedValue(undefined),
      deleteFromIndex: vi.fn().mockResolvedValue(undefined),
    };
    const pagesRepository = { findPageByKey: vi.fn().mockResolvedValue({ page_key: 'old' }) };
    const knowledgeRepository = { createEvent: vi.fn().mockResolvedValue(undefined) };
    const tool = new WikiRemoveTool(wikiService as any, pagesRepository as any, knowledgeRepository as any);

    const result = await tool.call({ key: 'orbit/company-overview' } as any, baseContext);

    expect(result.structured).toEqual({ success: false, key: 'orbit/company-overview' });
    expect(result.markdown).toContain(
      'Invalid wiki key "orbit/company-overview". Wiki keys must be flat; use "orbit-company-overview".',
    );
    expect(pagesRepository.findPageByKey).not.toHaveBeenCalled();
    expect(wikiService.deletePage).not.toHaveBeenCalled();
  });

  it('skips deleteFromIndex when session is worktree-scoped', async () => {
    const wikiService = {
      readPage: vi.fn().mockResolvedValue({ pageKey: 'old', frontmatter: { summary: 'Old' }, content: 'body' }),
      deletePage: vi.fn().mockResolvedValue(undefined),
      deleteFromIndex: vi.fn().mockResolvedValue(undefined),
    };
    const pagesRepository = { findPageByKey: vi.fn().mockResolvedValue({ page_key: 'old' }) };
    const knowledgeRepository = { createEvent: vi.fn().mockResolvedValue(undefined) };
    const tool = new WikiRemoveTool(wikiService as any, pagesRepository as any, knowledgeRepository as any);
    const session: ToolSession = {
      connectionId: 'c',
      isWorktreeScoped: true,
      preHead: null,
      touchedSlSources: createTouchedSlSources(),
      actions: [],
      semanticLayerService: {} as any,
      wikiService: wikiService as any,
      configService: {} as any,
      gitService: {} as any,
    };
    await tool.call({ key: 'old' } as any, { ...baseContext, session });
    expect(wikiService.deletePage).toHaveBeenCalledTimes(1);
    expect(wikiService.deleteFromIndex).not.toHaveBeenCalled();
    expect(session.actions).toContainEqual(expect.objectContaining({ target: 'wiki', type: 'removed', key: 'old' }));
  });

  it('finds pages through the session wiki service even when the shared index has not seen the worktree write', async () => {
    const wikiService = {
      readPage: vi.fn().mockResolvedValue({ pageKey: 'staged', frontmatter: { summary: 'Staged' }, content: 'body' }),
      deletePage: vi.fn().mockResolvedValue(undefined),
      deleteFromIndex: vi.fn().mockResolvedValue(undefined),
    };
    const pagesRepository = { findPageByKey: vi.fn().mockResolvedValue(null) };
    const knowledgeRepository = { createEvent: vi.fn().mockResolvedValue(undefined) };
    const tool = new WikiRemoveTool(wikiService as any, pagesRepository as any, knowledgeRepository as any);
    const session: ToolSession = {
      connectionId: 'c',
      isWorktreeScoped: true,
      preHead: null,
      touchedSlSources: createTouchedSlSources(),
      actions: [],
      semanticLayerService: {} as any,
      wikiService: wikiService as any,
      configService: {} as any,
      gitService: {} as any,
    };

    const result = await tool.call({ key: 'staged' } as any, { ...baseContext, session });

    expect(pagesRepository.findPageByKey).not.toHaveBeenCalled();
    expect(wikiService.readPage).toHaveBeenCalledWith('GLOBAL', null, 'staged');
    expect(wikiService.deletePage).toHaveBeenCalledTimes(1);
    expect(result.structured).toEqual({ success: true, key: 'staged' });
  });

  it('returns a friendly message when the page does not exist', async () => {
    const wikiService = { deletePage: vi.fn(), deleteFromIndex: vi.fn() };
    const pagesRepository = { findPageByKey: vi.fn().mockResolvedValue(null) };
    const knowledgeRepository = { createEvent: vi.fn() };
    const tool = new WikiRemoveTool(wikiService as any, pagesRepository as any, knowledgeRepository as any);
    const result = await tool.call({ key: 'missing' } as any, baseContext);
    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/not found/i);
  });
});
