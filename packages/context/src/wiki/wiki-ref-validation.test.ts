import { describe, expect, it, vi } from 'vitest';
import { findDanglingWikiRefsForActions } from './wiki-ref-validation.js';

function makeWikiService(pages: Record<string, { refs?: string[]; content?: string }>) {
  return {
    listPageKeys: vi.fn().mockResolvedValue(Object.keys(pages)),
    readPage: vi.fn().mockImplementation((_scope: string, _scopeId: string | null, pageKey: string) => {
      const page = pages[pageKey];
      if (!page) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        pageKey,
        frontmatter: { summary: pageKey, usage_mode: 'auto', refs: page.refs },
        content: page.content ?? '',
      });
    }),
  };
}

describe('wiki ref validation', () => {
  it('allows circular refs once both touched pages exist', async () => {
    const wikiService = makeWikiService({
      'page-a': { refs: ['page-b'], content: 'See [[page-b]].' },
      'page-b': { refs: ['page-a'], content: 'See [[page-a]].' },
    });

    const dangling = await findDanglingWikiRefsForActions({
      wikiService: wikiService as any,
      scope: 'GLOBAL',
      scopeId: null,
      actions: [
        { target: 'wiki', type: 'created', key: 'page-a', detail: 'Page A' },
        { target: 'wiki', type: 'created', key: 'page-b', detail: 'Page B' },
      ],
    });

    expect(dangling).toEqual([]);
  });

  it('treats removed pages as unavailable ref targets', async () => {
    const wikiService = makeWikiService({
      'page-a': { refs: ['page-b'], content: 'See [[page-b]].' },
    });

    const dangling = await findDanglingWikiRefsForActions({
      wikiService: wikiService as any,
      scope: 'GLOBAL',
      scopeId: null,
      actions: [
        { target: 'wiki', type: 'updated', key: 'page-a', detail: 'Page A' },
        { target: 'wiki', type: 'removed', key: 'page-b', detail: 'Page B' },
      ],
    });

    expect(dangling).toEqual(['page-a -> page-b']);
  });

  it('does not validate existing dangling refs on untouched pages', async () => {
    const wikiService = makeWikiService({
      'page-a': { refs: [], content: '' },
      'old-page': { refs: ['missing-page'], content: 'See [[missing-page]].' },
    });

    const dangling = await findDanglingWikiRefsForActions({
      wikiService: wikiService as any,
      scope: 'GLOBAL',
      scopeId: null,
      actions: [{ target: 'wiki', type: 'updated', key: 'page-a', detail: 'Page A' }],
    });

    expect(dangling).toEqual([]);
  });
});
