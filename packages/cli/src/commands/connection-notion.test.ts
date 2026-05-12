import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initKtxProject,
  loadKtxProject,
  serializeKtxProjectConfig,
  type KtxProjectConfig,
} from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyNotionPickerWriteback,
  discoverNotionPickerPages,
  notionPickerPageFromSearchResult,
  normalizeNotionPageId,
  resolveNotionWorkspaceLabel,
  runKtxConnectionNotion,
  type NotionPickerApi,
  type PickerRenderInput,
  type PickerRenderResult,
} from './connection-notion.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
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

describe('runKtxConnectionNotion', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-notion-pick-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeProjectConfig(projectDir: string, config: KtxProjectConfig): Promise<void> {
    const project = await loadKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'ktx.yaml',
      serializeKtxProjectConfig(config),
      'ktx',
      'ktx@example.com',
      'seed test config',
    );
  }

  it('rejects unsafe connection ids before loading a project', async () => {
    const io = makeIo();
    const loadProject = vi.fn(async () => {
      throw new Error('loadProject should not be called');
    });

    await expect(
      runKtxConnectionNotion(
        {
          command: 'pick',
          projectDir: '/tmp/project',
          connectionId: '../evil',
          mode: 'interactive',
        },
        io.io,
        { loadProject },
      ),
    ).resolves.toBe(1);

    expect(loadProject).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('Unsafe connection id: ../evil');
  });

  it('writes selected root_page_ids while preserving every other Notion connection field', async () => {
    const projectDir = join(tempDir, 'project');
    const initialized = await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeProjectConfig(projectDir, {
      ...initialized.config,
      connections: {
        'notion-main': {
          driver: 'notion',
          auth_token_ref: 'env:NOTION_TOKEN',
          crawl_mode: 'all_accessible',
          root_page_ids: ['99999999-9999-9999-9999-999999999999'],
          root_database_ids: ['database-1'],
          root_data_source_ids: ['data-source-1'],
          max_pages_per_run: 12,
          max_knowledge_creates_per_run: 2,
          max_knowledge_updates_per_run: 7,
          last_successful_cursor: '{"phase":"all_accessible_pages","cursor":"cursor-1"}',
          unknown_future_field: 'keep-me',
        },
      },
    });
    const io = makeIo();

    await expect(
      runKtxConnectionNotion(
        {
          command: 'pick',
          projectDir,
          connectionId: 'notion-main',
          mode: 'non-interactive',
          rootPageIds: [
            '11111111-2222-3333-4444-555555555555',
            '66666666-7777-8888-9999-aaaaaaaaaaaa',
          ],
        },
        io.io,
      ),
    ).resolves.toBe(0);

    const yaml = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(yaml).toContain('crawl_mode: selected_roots');
    expect(yaml).toContain('root_page_ids:');
    expect(yaml).toContain('11111111-2222-3333-4444-555555555555');
    expect(yaml).toContain('66666666-7777-8888-9999-aaaaaaaaaaaa');
    expect(yaml).toContain('root_database_ids:');
    expect(yaml).toContain('database-1');
    expect(yaml).toContain('root_data_source_ids:');
    expect(yaml).toContain('data-source-1');
    expect(yaml).toContain('last_successful_cursor: \'{"phase":"all_accessible_pages","cursor":"cursor-1"}\'');
    expect(yaml).toContain('unknown_future_field: keep-me');
    expect(io.stdout()).toContain('Connection: notion-main');
    expect(io.stdout()).toContain('rootPageIds: 2');
    expect(io.stdout()).toContain('crawlMode: selected_roots');
  });

  it('rejects empty writeback, missing connections, and non-Notion connections', async () => {
    const projectDir = join(tempDir, 'project');
    const initialized = await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeProjectConfig(projectDir, {
      ...initialized.config,
      connections: {
        warehouse: {
          driver: 'postgres',
          url: 'env:DATABASE_URL',
          readonly: true,
        },
      },
    });
    const project = await loadKtxProject({ projectDir });

    await expect(applyNotionPickerWriteback(project, 'warehouse', [])).rejects.toThrow(
      'connection notion pick requires at least one root page id',
    );
    await expect(
      applyNotionPickerWriteback(project, 'missing', ['11111111-2222-3333-4444-555555555555']),
    ).rejects.toThrow('Connection "missing" not found');
    await expect(
      applyNotionPickerWriteback(project, 'warehouse', ['11111111-2222-3333-4444-555555555555']),
    ).rejects.toThrow('Connection "warehouse" is not a Notion connection');
  });

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

  it('runs interactive discovery, warns about stale roots, renders the TUI, and saves selected roots', async () => {
    const projectDir = join(tempDir, 'project');
    const initialized = await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeProjectConfig(projectDir, {
      ...initialized.config,
      connections: {
        'notion-main': {
          driver: 'notion',
          auth_token_ref: 'env:NOTION_TOKEN',
          crawl_mode: 'all_accessible',
          root_page_ids: [PAGE_IDS.stale],
          root_database_ids: ['database-1'],
          root_data_source_ids: ['data-source-1'],
          max_pages_per_run: 12,
          max_knowledge_creates_per_run: 2,
          max_knowledge_updates_per_run: 7,
          last_successful_cursor: null,
        },
      },
    });
    const api = fakeNotionApi([
      notionPage(PAGE_IDS.engineering, 'Engineering'),
      notionPage(PAGE_IDS.architecture, 'Architecture', PAGE_IDS.engineering),
    ]);
    const renderPicker = vi.fn(async (input): Promise<PickerRenderResult> => {
      expect(input.connectionId).toBe('notion-main');
      expect(input.workspaceLabel).toBe('Design Workspace');
      expect(input.currentCrawlMode).toBe('all_accessible');
      expect(input.cappedAtCount).toBeNull();
      expect(input.initialState.preLoadWarnings).toEqual(['1 stored root_page_ids no longer visible']);
      return { kind: 'save', rootPageIds: [PAGE_IDS.engineering] };
    });
    const io = makeIo();

    await expect(
      runKtxConnectionNotion(
        {
          command: 'pick',
          projectDir,
          connectionId: 'notion-main',
          mode: 'interactive',
        },
        io.io,
        {
          env: { NOTION_TOKEN: 'ntn_test_token' },
          createNotionApi: vi.fn(() => api),
          renderPicker,
        },
      ),
    ).resolves.toBe(0);

    const yaml = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(yaml).toContain('crawl_mode: selected_roots');
    expect(yaml).toContain(PAGE_IDS.engineering);
    expect(yaml).not.toContain(PAGE_IDS.stale);
    expect(io.stderr()).toContain('1 stored root_page_ids no longer visible');
    expect(io.stdout()).toContain('Connection: notion-main');
    expect(io.stdout()).toContain('rootPageIds: 1');
  });

  it('uses inline Notion auth_token for interactive discovery', async () => {
    const projectDir = join(tempDir, 'project');
    const initialized = await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeProjectConfig(projectDir, {
      ...initialized.config,
      connections: {
        'notion-main': {
          driver: 'notion',
          auth_token: 'ntn_inline_token',
          crawl_mode: 'selected_roots',
          root_page_ids: [PAGE_IDS.engineering],
          root_database_ids: [],
          root_data_source_ids: [],
          max_pages_per_run: 12,
          max_knowledge_creates_per_run: 2,
          max_knowledge_updates_per_run: 7,
          last_successful_cursor: null,
        },
      },
    });
    const api = fakeNotionApi([notionPage(PAGE_IDS.engineering, 'Engineering')]);
    const createNotionApi = vi.fn((authToken: string) => {
      expect(authToken).toBe('ntn_inline_token');
      return api;
    });
    const io = makeIo();

    await expect(
      runKtxConnectionNotion(
        {
          command: 'pick',
          projectDir,
          connectionId: 'notion-main',
          mode: 'interactive',
        },
        io.io,
        {
          createNotionApi,
          renderPicker: vi.fn(async (): Promise<PickerRenderResult> => ({ kind: 'quit' })),
        },
      ),
    ).resolves.toBe(0);

    expect(createNotionApi).toHaveBeenCalledOnce();
    expect(io.stdout()).toContain('No changes saved.');
  });

  it('passes partial-discovery warnings into the TUI banner state', async () => {
    const projectDir = join(tempDir, 'project');
    const initialized = await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeProjectConfig(projectDir, {
      ...initialized.config,
      connections: {
        'notion-main': {
          driver: 'notion',
          auth_token_ref: 'env:NOTION_TOKEN',
          crawl_mode: 'selected_roots',
          root_page_ids: [PAGE_IDS.engineering],
          root_database_ids: [],
          root_data_source_ids: [],
          max_pages_per_run: 12,
          max_knowledge_creates_per_run: 2,
          max_knowledge_updates_per_run: 7,
          last_successful_cursor: null,
        },
      },
    });
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
    let renderInput: PickerRenderInput | undefined;
    const renderPicker = vi.fn(async (input: PickerRenderInput): Promise<PickerRenderResult> => {
      renderInput = input;
      return { kind: 'quit' };
    });
    const io = makeIo();

    await expect(
      runKtxConnectionNotion(
        {
          command: 'pick',
          projectDir,
          connectionId: 'notion-main',
          mode: 'interactive',
        },
        io.io,
        {
          env: { NOTION_TOKEN: 'ntn_test_token' },
          createNotionApi: vi.fn(() => api),
          renderPicker,
        },
      ),
    ).resolves.toBe(0);

    expect(renderPicker).toHaveBeenCalledOnce();
    if (!renderInput) {
      throw new Error('renderPicker was not called');
    }
    expect(renderInput.initialState.preLoadWarnings).toEqual(['Notion search stopped early: rate limit after first page']);
    expect(renderInput.initialState.tree.map((node) => node.title)).toEqual(['Engineering']);
    expect(io.stderr()).toContain('Notion search stopped early: rate limit after first page');
    expect(io.stdout()).toContain('No changes saved.');
  });

  it('quits interactive mode without writing when the TUI returns quit', async () => {
    const projectDir = join(tempDir, 'project');
    const initialized = await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeProjectConfig(projectDir, {
      ...initialized.config,
      connections: {
        'notion-main': {
          driver: 'notion',
          auth_token_ref: 'env:NOTION_TOKEN',
          crawl_mode: 'selected_roots',
          root_page_ids: [PAGE_IDS.engineering],
          root_database_ids: [],
          root_data_source_ids: [],
          max_pages_per_run: 12,
          max_knowledge_creates_per_run: 2,
          max_knowledge_updates_per_run: 7,
          last_successful_cursor: null,
        },
      },
    });
    const before = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    const io = makeIo();

    await expect(
      runKtxConnectionNotion(
        {
          command: 'pick',
          projectDir,
          connectionId: 'notion-main',
          mode: 'interactive',
        },
        io.io,
        {
          env: { NOTION_TOKEN: 'ntn_test_token' },
          createNotionApi: vi.fn(() => fakeNotionApi([notionPage(PAGE_IDS.engineering, 'Engineering')])),
          renderPicker: vi.fn(async (): Promise<PickerRenderResult> => ({ kind: 'quit' })),
        },
      ),
    ).resolves.toBe(0);

    await expect(readFile(join(projectDir, 'ktx.yaml'), 'utf-8')).resolves.toBe(before);
    expect(io.stdout()).toContain('No changes saved.');
  });
});
