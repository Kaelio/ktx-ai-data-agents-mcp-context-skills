import { describe, expect, it, vi } from 'vitest';
import type { PickerState } from '../src/tree-picker-state.js';
import type { TreePickerChrome, TreePickerResult, TreePickerTuiIo } from '../src/tree-picker-tui.js';
import {
  discoverNotionPickerPages,
  notionPickerPageFromSearchResult,
  normalizeNotionPageId,
  pickNotionRootPages,
  resolveNotionWorkspaceLabel,
  type NotionPickerApi,
} from '../src/notion-page-picker.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

type FakeNotionSearchPage = Record<string, unknown> & { id: string; object: 'page' };

const PAGE_IDS = {
  engineering: '11111111-1111-1111-1111-111111111111',
  architecture: '22222222-2222-2222-2222-222222222222',
  stale: '99999999-9999-9999-9999-999999999999',
};

function notionPage(id: string, title: string, parentId: string | null = null): FakeNotionSearchPage {
  return {
    object: 'page',
    id,
    archived: false,
    parent: parentId ? { type: 'page_id', page_id: parentId } : { type: 'workspace', workspace: true },
    properties: {
      title: {
        type: 'title',
        title: [{ plain_text: title }],
      },
    },
  };
}

function fakeNotionApi(pages: FakeNotionSearchPage[]): NotionPickerApi {
  return {
    search: vi.fn(async (_filterValue, startCursor) => {
      if (startCursor === 'page-2') {
        return { results: pages.slice(2), hasMore: false, nextCursor: null };
      }
      return {
        results: pages.slice(0, 2),
        hasMore: pages.length > 2,
        nextCursor: pages.length > 2 ? 'page-2' : null,
      };
    }),
    retrieveBotUser: vi.fn(async () => ({ name: 'Notion bot', bot: { workspace_name: 'Design Workspace' } })),
  };
}

describe('normalizeNotionPageId', () => {
  it('accepts dashed and compact UUIDs', () => {
    expect(normalizeNotionPageId('11111111222233334444555555555555')).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
    expect(normalizeNotionPageId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
  });
});

describe('Notion page picker helpers', () => {
  it('extracts picker page inputs from Notion search results', () => {
    expect(notionPickerPageFromSearchResult(notionPage(PAGE_IDS.architecture, 'Architecture', PAGE_IDS.engineering)))
      .toEqual({
        id: PAGE_IDS.architecture,
        title: 'Architecture',
        archived: false,
        parentId: PAGE_IDS.engineering,
      });

    expect(
      notionPickerPageFromSearchResult({
        object: 'page',
        id: PAGE_IDS.engineering.replaceAll('-', ''),
        archived: true,
        parent: { type: 'workspace', workspace: true },
        properties: {},
      }),
    ).toEqual({
      id: PAGE_IDS.engineering,
      title: 'Untitled',
      archived: true,
      parentId: null,
    });
  });

  it('discovers visible pages up to the cap and reports cap state', async () => {
    const api = fakeNotionApi([
      notionPage(PAGE_IDS.engineering, 'Engineering'),
      notionPage(PAGE_IDS.architecture, 'Architecture', PAGE_IDS.engineering),
      notionPage('33333333-3333-3333-3333-333333333333', 'Onboarding', PAGE_IDS.engineering),
    ]);

    await expect(discoverNotionPickerPages(api, { cap: 2 })).resolves.toEqual({
      pages: [
        { id: PAGE_IDS.engineering, title: 'Engineering', archived: false, parentId: null },
        { id: PAGE_IDS.architecture, title: 'Architecture', archived: false, parentId: PAGE_IDS.engineering },
      ],
      cappedAtCount: 2,
      warnings: [],
    });
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  it('keeps partial discovery results when Notion search fails after at least one page', async () => {
    const api: NotionPickerApi = {
      search: vi
        .fn()
        .mockResolvedValueOnce({
          results: [notionPage(PAGE_IDS.engineering, 'Engineering')],
          hasMore: true,
          nextCursor: 'cursor-2',
        })
        .mockRejectedValueOnce(new Error('rate limit after first page')),
      retrieveBotUser: vi.fn(async () => ({ name: 'Notion bot' })),
    };

    await expect(discoverNotionPickerPages(api)).resolves.toEqual({
      pages: [{ id: PAGE_IDS.engineering, title: 'Engineering', archived: false, parentId: null }],
      cappedAtCount: null,
      warnings: ['Notion search stopped early: rate limit after first page'],
    });
  });

  it('uses the Notion workspace name when available and falls back to the connection id', async () => {
    await expect(resolveNotionWorkspaceLabel(fakeNotionApi([]), 'notion-main')).resolves.toBe('Design Workspace');
    await expect(
      resolveNotionWorkspaceLabel(
        {
          search: vi.fn(),
          retrieveBotUser: vi.fn(async () => {
            throw new Error('users.me unavailable');
          }),
        },
        'notion-main',
      ),
    ).resolves.toBe('notion-main');
  });
});

type RenderPickerArgs = [TreePickerChrome, PickerState, TreePickerTuiIo];

describe('pickNotionRootPages', () => {
  it('discovers visible pages, warns about stale roots, renders the TUI, and returns selected roots', async () => {
    const api = fakeNotionApi([
      notionPage(PAGE_IDS.engineering, 'Engineering'),
      notionPage(PAGE_IDS.architecture, 'Architecture', PAGE_IDS.engineering),
    ]);
    const renderPicker = vi.fn(
      async (chrome: TreePickerChrome, state: PickerState): Promise<TreePickerResult> => {
        expect(chrome.title).toBe('Select Notion pages to ingest');
        expect(chrome.subtitleLines).toEqual(['Workspace: Design Workspace']);
        expect(chrome.warningLines ?? []).toEqual([]);
        expect(chrome.confirmSaveMessage).toBeTypeOf('function');
        expect(state.requireConfirmOnSave).toBe(true);
        expect(state.preLoadWarnings).toEqual([
          '1 stored root_page_ids no longer visible - they will be removed if you save',
        ]);
        return { kind: 'save', selectedIds: [PAGE_IDS.engineering] };
      },
    );
    const io = makeIo();

    await expect(
      pickNotionRootPages(
        {
          connectionId: 'notion-main',
          connection: {
            driver: 'notion',
            auth_token_ref: 'env:NOTION_TOKEN',
            crawl_mode: 'all_accessible',
            root_page_ids: [PAGE_IDS.stale],
          },
        },
        io.io,
        {
          env: { NOTION_TOKEN: 'ntn_test_token' },
          createNotionApi: vi.fn(() => api),
          renderPicker,
        },
      ),
    ).resolves.toEqual({ kind: 'selected', rootPageIds: [PAGE_IDS.engineering] });

    expect(io.stderr()).toContain('1 stored root_page_ids no longer visible');
    expect(io.stdout()).toBe('');
  });

  it('uses inline Notion auth_token for discovery', async () => {
    const api = fakeNotionApi([notionPage(PAGE_IDS.engineering, 'Engineering')]);
    const createNotionApi = vi.fn((authToken: string) => {
      expect(authToken).toBe('ntn_inline_token');
      return api;
    });

    await expect(
      pickNotionRootPages(
        {
          connectionId: 'notion-main',
          connection: {
            driver: 'notion',
            auth_token: 'ntn_inline_token',
            crawl_mode: 'selected_roots',
            root_page_ids: [PAGE_IDS.engineering],
          },
        },
        makeIo().io,
        {
          createNotionApi,
          renderPicker: vi.fn(async (): Promise<TreePickerResult> => ({ kind: 'quit' })),
        },
      ),
    ).resolves.toEqual({ kind: 'back' });

    expect(createNotionApi).toHaveBeenCalledOnce();
  });

  it('passes partial-discovery warnings into the TUI banner state', async () => {
    const api: NotionPickerApi = {
      search: vi
        .fn()
        .mockResolvedValueOnce({
          results: [notionPage(PAGE_IDS.engineering, 'Engineering')],
          hasMore: true,
          nextCursor: 'cursor-2',
        })
        .mockRejectedValueOnce(new Error('rate limit after first page')),
      retrieveBotUser: vi.fn(async () => ({ name: 'Notion bot', bot: { workspace_name: 'Design Workspace' } })),
    };
    let captured: RenderPickerArgs | undefined;
    const renderPicker = vi.fn(
      async (chrome: TreePickerChrome, state: PickerState, io: TreePickerTuiIo): Promise<TreePickerResult> => {
        captured = [chrome, state, io];
        return { kind: 'quit' };
      },
    );
    const io = makeIo();

    await expect(
      pickNotionRootPages(
        {
          connectionId: 'notion-main',
          connection: {
            driver: 'notion',
            auth_token_ref: 'env:NOTION_TOKEN',
            crawl_mode: 'selected_roots',
            root_page_ids: [PAGE_IDS.engineering],
          },
        },
        io.io,
        {
          env: { NOTION_TOKEN: 'ntn_test_token' },
          createNotionApi: vi.fn(() => api),
          renderPicker,
        },
      ),
    ).resolves.toEqual({ kind: 'back' });

    expect(renderPicker).toHaveBeenCalledOnce();
    if (!captured) {
      throw new Error('renderPicker was not called');
    }
    const [, state] = captured;
    expect(state.preLoadWarnings).toEqual(['Notion search stopped early: rate limit after first page']);
    expect(state.tree.map((node) => node.title)).toEqual(['Engineering']);
    expect(io.stderr()).toContain('Notion search stopped early: rate limit after first page');
  });

  it('returns unavailable when discovery cannot load any pages', async () => {
    await expect(
      pickNotionRootPages(
        {
          connectionId: 'notion-main',
          connection: {
            driver: 'notion',
            auth_token_ref: 'env:NOTION_TOKEN',
            crawl_mode: 'selected_roots',
            root_page_ids: [],
          },
        },
        makeIo().io,
        {
          env: { NOTION_TOKEN: 'ntn_test_token' },
          createNotionApi: vi.fn(() => ({
            search: vi.fn(async () => {
              throw new Error('Notion API unavailable');
            }),
            retrieveBotUser: vi.fn(async () => ({ name: 'Notion bot' })),
          })),
          renderPicker: vi.fn(async (): Promise<TreePickerResult> => ({ kind: 'quit' })),
        },
      ),
    ).resolves.toEqual({ kind: 'unavailable', message: 'Notion API unavailable' });
  });
});
