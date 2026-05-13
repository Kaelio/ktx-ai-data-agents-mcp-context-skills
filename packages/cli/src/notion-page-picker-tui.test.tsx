/* @jsxImportSource react */
import { render as renderInkTest } from 'ink-testing-library';
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInitialState, buildPickerTree, type NotionPickerPageInput } from './notion-page-picker-tree.js';
import {
  NotionPickerApp,
  notionPickerCommandForInkInput,
  renderNotionPickerTui,
  resolveNotionPickerWidth,
  sanitizeNotionPickerTuiError,
  windowItems,
  windowOffset,
  type NotionPickerInkInstance,
  type NotionPickerInkRenderOptions,
} from './notion-page-picker-tui.js';

const IDS = {
  engineering: '11111111-1111-1111-1111-111111111111',
  architecture: '22222222-2222-2222-2222-222222222222',
  marketing: '33333333-3333-3333-3333-333333333333',
  finance: '44444444-4444-4444-4444-444444444444',
  ops: '55555555-5555-5555-5555-555555555555',
  sales: '66666666-6666-6666-6666-666666666666',
  support: '77777777-7777-7777-7777-777777777777',
  product: '88888888-8888-8888-8888-888888888888',
  design: '99999999-9999-9999-9999-999999999999',
};

function pages(): NotionPickerPageInput[] {
  return [
    { id: IDS.engineering, title: 'Engineering Docs', archived: false, parentId: null },
    { id: IDS.architecture, title: 'Architecture', archived: false, parentId: IDS.engineering },
    { id: IDS.marketing, title: 'Marketing', archived: false, parentId: null },
  ];
}

function manyPages(): NotionPickerPageInput[] {
  return [
    { id: IDS.engineering, title: 'Engineering Docs', archived: false, parentId: null },
    { id: IDS.architecture, title: 'Architecture', archived: false, parentId: IDS.engineering },
    { id: IDS.marketing, title: 'Marketing', archived: false, parentId: null },
    { id: IDS.finance, title: 'Finance', archived: false, parentId: null },
    { id: IDS.ops, title: 'Operations', archived: false, parentId: null },
    { id: IDS.sales, title: 'Sales', archived: false, parentId: null },
    { id: IDS.support, title: 'Support', archived: false, parentId: null },
    { id: IDS.product, title: 'Product', archived: false, parentId: null },
    { id: IDS.design, title: 'Design', archived: false, parentId: null },
  ];
}

function state(mode: 'all_accessible' | 'selected_roots' = 'selected_roots') {
  return buildInitialState({
    tree: buildPickerTree(pages()),
    existingRootPageIds: [],
    currentCrawlMode: mode,
  });
}

async function waitForInkInput(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function fakeInkInstance(): NotionPickerInkInstance {
  return {
    rerender: vi.fn(),
    unmount: vi.fn(),
    waitUntilExit: vi.fn(async () => undefined),
  };
}

function normalizeFrameWrap(frame: string | undefined): string {
  return frame?.replace(/\n/g, ' ') ?? '';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('notionPickerCommandForInkInput', () => {
  it('maps browse, search, and confirm input to reducer commands', () => {
    expect(notionPickerCommandForInkInput('', { downArrow: true }, state().search, null)).toBe('cursor-down');
    expect(notionPickerCommandForInkInput('', { upArrow: true }, state().search, null)).toBe('cursor-up');
    expect(notionPickerCommandForInkInput('', { rightArrow: true }, state().search, null)).toBe('cursor-right');
    expect(notionPickerCommandForInkInput('', { leftArrow: true }, state().search, null)).toBe('cursor-left');
    expect(notionPickerCommandForInkInput(' ', {}, state().search, null)).toBe('toggle-check');
    expect(notionPickerCommandForInkInput('/', {}, state().search, null)).toBe('search-start');
    expect(notionPickerCommandForInkInput('a', {}, state().search, null)).toBe('select-all-visible');
    expect(notionPickerCommandForInkInput('n', {}, state().search, null)).toBe('select-none');
    expect(notionPickerCommandForInkInput('s', {}, state().search, null)).toBe('save-request');
    expect(notionPickerCommandForInkInput('q', {}, state().search, null)).toBe('quit');
    expect(notionPickerCommandForInkInput('c', { ctrl: true }, state().search, null)).toBe('quit');

    expect(notionPickerCommandForInkInput('x', {}, { editing: true, query: '' }, null)).toEqual({
      type: 'search-input',
      value: 'x',
    });
    expect(notionPickerCommandForInkInput('', { backspace: true }, { editing: true, query: 'x' }, null)).toBe(
      'search-backspace',
    );
    expect(notionPickerCommandForInkInput('', { return: true }, { editing: true, query: 'x' }, null)).toBe(
      'search-submit',
    );
    expect(notionPickerCommandForInkInput('', { escape: true }, { editing: true, query: 'x' }, null)).toBe(
      'search-cancel',
    );

    expect(notionPickerCommandForInkInput('y', {}, state().search, 'mode-switch')).toBe('save-confirm');
    expect(notionPickerCommandForInkInput('', { return: true }, state().search, 'mode-switch')).toBe('save-confirm');
    expect(notionPickerCommandForInkInput('n', {}, state().search, 'mode-switch')).toBe('save-cancel');
  });
});

describe('window helpers', () => {
  it('centers the selected row and returns the visible slice', () => {
    expect(windowOffset(20, 10, 5)).toBe(8);
    expect(windowItems(['a', 'b', 'c', 'd', 'e'], 3, 3)).toEqual({ items: ['c', 'd', 'e'], offset: 2 });
  });

  it('clamps picker width to the design rule', () => {
    expect(resolveNotionPickerWidth(200)).toBe(120);
    expect(resolveNotionPickerWidth(100)).toBe(96);
    expect(resolveNotionPickerWidth(50)).toBe(60);
    expect(resolveNotionPickerWidth(undefined)).toBe(96);
  });
});

describe('NotionPickerApp', () => {
  it('renders spec banners, row glyphs, search visibility, and hint text', () => {
    const initialState = {
      ...state('all_accessible'),
      preLoadWarnings: ['1 stored root_page_ids no longer visible'],
    };
    const { lastFrame } = renderInkTest(
      <NotionPickerApp
        initialState={initialState}
        connectionId="notion-main"
        workspaceLabel="Design Workspace"
        cappedAtCount={5000}
        currentCrawlMode="all_accessible"
        terminalRows={24}
        terminalWidth={100}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Notion pages visible to integration "Design Workspace"');
    expect(frame).toContain('5000-page cap reached - some pages not shown');
    expect(frame).toContain('1 stored root_page_ids no longer visible - they will be removed if you save');
    expect(frame).toContain('▸ [ ] Engineering Docs ▸ (1)');
    expect(frame).toContain('  [ ] Marketing');
    expect(frame).not.toContain('Search ready: -');
    expect(frame).toContain('space toggle · enter expand · / search · a all · n none · s save & exit · q quit');
  });

  it('renders partial discovery warnings without stale-root save suffix', () => {
    const initialState = {
      ...state(),
      preLoadWarnings: ['Notion search stopped early: rate limit after first page'],
    };
    const { lastFrame } = renderInkTest(
      <NotionPickerApp
        initialState={initialState}
        connectionId="notion-main"
        workspaceLabel="Design Workspace"
        cappedAtCount={null}
        currentCrawlMode="selected_roots"
        terminalRows={24}
        terminalWidth={100}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Notion search stopped early: rate limit after first page');
    expect(frame).not.toContain(
      'Notion search stopped early: rate limit after first page - they will be removed if you save',
    );
  });

  it('renders checked parents and locked descendants with the locked design glyphs', () => {
    const initialState = {
      ...state(),
      checked: new Set([IDS.engineering]),
      expanded: new Set([IDS.engineering]),
    };
    const { lastFrame } = renderInkTest(
      <NotionPickerApp
        initialState={initialState}
        connectionId="notion-main"
        workspaceLabel="Design Workspace"
        cappedAtCount={null}
        currentCrawlMode="selected_roots"
        terminalRows={24}
        terminalWidth={100}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('▸ [×] Engineering Docs ▾');
    expect(frame).toContain('  [~]   Architecture');
  });

  it('supports keyboard selection, all_accessible confirmation, and save callback', async () => {
    const onExit = vi.fn();
    const { stdin, lastFrame } = renderInkTest(
      <NotionPickerApp
        initialState={state('all_accessible')}
        connectionId="notion-main"
        workspaceLabel="Design Workspace"
        cappedAtCount={null}
        currentCrawlMode="all_accessible"
        terminalRows={24}
        terminalWidth={100}
        onExit={onExit}
      />,
    );

    stdin.write(' ');
    await waitForInkInput();
    expect(lastFrame()).toContain('[×] Engineering Docs');

    stdin.write('s');
    await waitForInkInput();
    expect(normalizeFrameWrap(lastFrame())).toContain(
      'Save will switch crawl_mode all_accessible -> selected_roots and limit ingest to 1 selected page. [y] confirm  [esc] back',
    );

    stdin.write('y');
    await waitForInkInput();
    expect(onExit).toHaveBeenCalledWith({ kind: 'save', rootPageIds: [IDS.engineering] });
  });

  it('removes transient hints after their expiry time', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const { stdin, lastFrame } = renderInkTest(
      <NotionPickerApp
        initialState={state()}
        connectionId="notion-main"
        workspaceLabel="Design Workspace"
        cappedAtCount={null}
        currentCrawlMode="selected_roots"
        terminalRows={24}
        terminalWidth={100}
        onExit={onExit}
      />,
    );

    await act(async () => {
      stdin.write('s');
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(lastFrame()).toContain('Select at least one page or press q to quit');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(lastFrame()).not.toContain('Select at least one page or press q to quit');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('renders row-window overflow indicators when the visible list is clipped', async () => {
    const onExit = vi.fn();
    const initialState = buildInitialState({
      tree: buildPickerTree(manyPages()),
      existingRootPageIds: [],
      currentCrawlMode: 'selected_roots',
    });
    initialState.expanded = new Set([IDS.engineering]);
    const { stdin, lastFrame } = renderInkTest(
      <NotionPickerApp
        initialState={initialState}
        connectionId="notion-main"
        workspaceLabel="Design Workspace"
        cappedAtCount={null}
        currentCrawlMode="selected_roots"
        terminalRows={13}
        terminalWidth={100}
        onExit={onExit}
      />,
    );

    expect(lastFrame()).toContain('↓ 4 more');

    stdin.write('\u001B[B');
    stdin.write('\u001B[B');
    stdin.write('\u001B[B');
    stdin.write('\u001B[B');
    await waitForInkInput();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑ ');
    expect(frame).toContain('↓ ');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('returns quit without saving', async () => {
    const onExit = vi.fn();
    const { stdin } = renderInkTest(
      <NotionPickerApp
        initialState={state()}
        connectionId="notion-main"
        workspaceLabel="Design Workspace"
        cappedAtCount={null}
        currentCrawlMode="selected_roots"
        terminalRows={24}
        terminalWidth={100}
        onExit={onExit}
      />,
    );

    stdin.write('q');
    await waitForInkInput();
    expect(onExit).toHaveBeenCalledWith({ kind: 'quit' });
  });
});

describe('renderNotionPickerTui', () => {
  it('returns the app result from the Ink runtime', async () => {
    const io = {
      stdin: { isTTY: true, setRawMode: vi.fn() },
      stdout: { isTTY: true, columns: 100, rows: 24, write: vi.fn() },
      stderr: { write: vi.fn() },
    };
    const renderInk = vi.fn((_tree: ReactNode, _options: NotionPickerInkRenderOptions) => fakeInkInstance());

    await expect(
      renderNotionPickerTui(
        {
          initialState: state(),
          connectionId: 'notion-main',
          workspaceLabel: 'Design Workspace',
          cappedAtCount: null,
          currentCrawlMode: 'selected_roots',
        },
        io,
        { renderInk },
      ),
    ).resolves.toEqual({ kind: 'quit' });
    expect(renderInk).toHaveBeenCalledOnce();
  });

  it('sanitizes render errors and tells the user to use no-input mode', async () => {
    expect(sanitizeNotionPickerTuiError(new Error('token=secret https://api.notion.com/v1/search'))).toBe(
      '[redacted] [redacted-url]',
    );
  });

  it('falls back to quit with a scripted-mode hint when Ink cannot initialize', async () => {
    let stderr = '';
    const io = {
      stdin: { isTTY: false, setRawMode: vi.fn() },
      stdout: { isTTY: false, columns: 100, rows: 24, write: vi.fn() },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
        },
      },
    };

    await expect(
      renderNotionPickerTui(
        {
          initialState: state(),
          connectionId: 'notion-main',
          workspaceLabel: 'Design Workspace',
          cappedAtCount: null,
          currentCrawlMode: 'selected_roots',
        },
        io,
        {
          renderInk: vi.fn(() => {
            throw new Error('token=secret');
          }),
        },
      ),
    ).resolves.toEqual({ kind: 'quit' });
    expect(stderr).toContain('Use --no-input --notion-root-page-id <UUID> for scripted mode');
    expect(stderr).not.toContain('secret');
  });
});
