/* @jsxImportSource react */
import { render as renderInkTest } from 'ink-testing-library';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildInitialState, buildPickerTree, type TreePickerNodeInput } from '../src/tree-picker-state.js';
import {
  TreePickerApp,
  renderTreePickerTui,
  resolveTreePickerWidth,
  sanitizeTreePickerTuiError,
  treePickerCommandForInkInput,
  windowItems,
  windowOffset,
  type TreePickerChrome,
  type TreePickerInkInstance,
  type TreePickerInkRenderOptions,
} from '../src/tree-picker-tui.js';

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

function pages(): TreePickerNodeInput[] {
  return [
    { id: IDS.engineering, title: 'Engineering Docs', archived: false, parentId: null },
    { id: IDS.architecture, title: 'Architecture', archived: false, parentId: IDS.engineering },
    { id: IDS.marketing, title: 'Marketing', archived: false, parentId: null },
  ];
}

function manyPages(): TreePickerNodeInput[] {
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

function state(options: { requireConfirmOnSave?: boolean } = {}) {
  return buildInitialState({
    tree: buildPickerTree(pages()),
    existingSelectedIds: [],
    requireConfirmOnSave: options.requireConfirmOnSave ?? false,
  });
}

function chrome(overrides: Partial<TreePickerChrome> = {}): TreePickerChrome {
  return {
    title: 'Select items',
    subtitleLines: ['Source: Test'],
    ...overrides,
  };
}

async function waitForInkInput(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function fakeInkInstance(): TreePickerInkInstance {
  return {
    rerender: vi.fn(),
    unmount: vi.fn(),
    waitUntilExit: vi.fn(async () => undefined),
  };
}

function normalizeFrameWrap(frame: string | undefined): string {
  return frame?.replace(/\n/g, ' ').replace(/│ /g, '').replace(/ +/g, ' ') ?? '';
}

describe('treePickerCommandForInkInput', () => {
  const browse = (overrides: Partial<{ search: { query: string }; isNavigating: boolean; pendingConfirm: null }> = {}) => ({
    search: { query: '' },
    isNavigating: false,
    pendingConfirm: null,
    ...overrides,
  });
  const confirming = { ...browse(), pendingConfirm: 'save-confirm' as const };

  it('routes cursor and confirm keys when no query is typed', () => {
    expect(treePickerCommandForInkInput('', { downArrow: true }, browse())).toBe('cursor-down');
    expect(treePickerCommandForInkInput('', { upArrow: true }, browse())).toBe('cursor-up');
    expect(treePickerCommandForInkInput('', { rightArrow: true }, browse())).toBe('cursor-right');
    expect(treePickerCommandForInkInput('', { leftArrow: true }, browse())).toBe('cursor-left');
    expect(treePickerCommandForInkInput('', { return: true }, browse())).toBe('save-request');
    expect(treePickerCommandForInkInput('', { escape: true }, browse())).toBe('quit');
    expect(treePickerCommandForInkInput('c', { ctrl: true }, browse())).toBe('quit');
  });

  it('Tab toggles selection regardless of search/navigation state', () => {
    expect(treePickerCommandForInkInput('', { tab: true }, browse())).toBe('toggle-check');
    expect(treePickerCommandForInkInput('', { tab: true }, browse({ search: { query: 'foo' }, isNavigating: false }))).toBe(
      'toggle-check',
    );
    expect(treePickerCommandForInkInput('', { tab: true }, browse({ isNavigating: true }))).toBe('toggle-check');
  });

  it('Space toggles only when navigating; otherwise typed into the search query', () => {
    expect(treePickerCommandForInkInput(' ', {}, browse({ isNavigating: true }))).toBe('toggle-check');
    expect(treePickerCommandForInkInput(' ', {}, browse({ isNavigating: false }))).toEqual({
      type: 'search-input',
      value: ' ',
    });
  });

  it('typed printable chars feed the search query — including a, n, and slash', () => {
    expect(treePickerCommandForInkInput('a', {}, browse())).toEqual({ type: 'search-input', value: 'a' });
    expect(treePickerCommandForInkInput('n', {}, browse())).toEqual({ type: 'search-input', value: 'n' });
    expect(treePickerCommandForInkInput('/', {}, browse())).toEqual({ type: 'search-input', value: '/' });
    expect(treePickerCommandForInkInput('x', {}, browse({ search: { query: 'foo' } }))).toEqual({
      type: 'search-input',
      value: 'x',
    });
  });

  it('Ctrl+A and Ctrl+N drive the bulk toggle helpers', () => {
    expect(treePickerCommandForInkInput('a', { ctrl: true }, browse())).toBe('toggle-select-all-visible');
    expect(treePickerCommandForInkInput('n', { ctrl: true }, browse())).toBe('select-none');
  });

  it('Backspace deletes from the query at any time; Esc clears query first then quits', () => {
    expect(treePickerCommandForInkInput('', { backspace: true }, browse({ search: { query: 'x' } }))).toBe(
      'search-backspace',
    );
    expect(treePickerCommandForInkInput('', { delete: true }, browse({ search: { query: 'x' } }))).toBe(
      'search-backspace',
    );
    expect(treePickerCommandForInkInput('', { escape: true }, browse({ search: { query: 'x' } }))).toBe('search-clear');
    expect(treePickerCommandForInkInput('', { escape: true }, browse())).toBe('quit');
  });

  it('confirm prompts intercept y/n/Enter/Esc before search routing', () => {
    expect(treePickerCommandForInkInput('y', {}, confirming)).toBe('save-confirm');
    expect(treePickerCommandForInkInput('', { return: true }, confirming)).toBe('save-confirm');
    expect(treePickerCommandForInkInput('n', {}, confirming)).toBe('save-cancel');
    expect(treePickerCommandForInkInput('', { escape: true }, confirming)).toBe('save-cancel');
  });
});

describe('window helpers', () => {
  it('centers the selected row and returns the visible slice', () => {
    expect(windowOffset(20, 10, 5)).toBe(8);
    expect(windowItems(['a', 'b', 'c', 'd', 'e'], 3, 3)).toEqual({ items: ['c', 'd', 'e'], offset: 2 });
  });

  it('clamps picker width to the design rule', () => {
    expect(resolveTreePickerWidth(200)).toBe(120);
    expect(resolveTreePickerWidth(100)).toBe(96);
    expect(resolveTreePickerWidth(50)).toBe(60);
    expect(resolveTreePickerWidth(undefined)).toBe(96);
  });
});

describe('TreePickerApp', () => {
  it('renders chrome title, subtitle, warnings, help, and row glyphs', () => {
    const initialState = {
      ...state(),
      preLoadWarnings: ['1 stale stored selections - they will be removed if you save'],
    };
    const { lastFrame } = renderInkTest(
      <TreePickerApp
        initialState={initialState}
        chrome={chrome({
          title: 'Select fancy widgets',
          subtitleLines: ['Workspace: Design Workspace'],
          warningLines: ['5000-page cap reached - some pages not shown'],
        })}
        terminalRows={24}
        terminalWidth={100}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Select fancy widgets');
    expect(frame).toContain('Workspace: Design Workspace');
    expect(frame).toContain('5000-page cap reached - some pages not shown');
    expect(frame).toContain('1 stale stored selections - they will be removed if you save');
    expect(frame).toContain('◻ Engineering Docs ▸ (1)');
    expect(frame).toContain('◻ Marketing');
    expect(normalizeFrameWrap(frame)).toContain(
      'Up/Down to move, Right/Left to expand or collapse, Tab to select, Type to search, Enter to confirm, Escape to clear search or go back, Ctrl+C to exit.',
    );
    expect(frame).toContain('Search:');
  });

  it('renders custom help text when supplied', () => {
    const { lastFrame } = renderInkTest(
      <TreePickerApp
        initialState={state()}
        chrome={chrome({ helpText: 'Bespoke instructions here.' })}
        terminalRows={24}
        terminalWidth={100}
        onExit={vi.fn()}
      />,
    );
    expect(lastFrame() ?? '').toContain('Bespoke instructions here.');
  });

  it('renders checked parents and locked descendants with locked glyphs', () => {
    const initialState = {
      ...state(),
      checked: new Set([IDS.engineering]),
      expanded: new Set([IDS.engineering]),
    };
    const { lastFrame } = renderInkTest(
      <TreePickerApp
        initialState={initialState}
        chrome={chrome()}
        terminalRows={24}
        terminalWidth={100}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('◼ Engineering Docs ▾');
    expect(frame).toContain('  ◼ Architecture');
  });

  it('renders the partial glyph on a parent whose descendant is checked', () => {
    const partialPages: TreePickerNodeInput[] = [
      { id: IDS.engineering, title: 'Engineering Docs', archived: false, parentId: null },
      { id: IDS.architecture, title: 'Architecture', archived: false, parentId: IDS.engineering },
    ];
    const initialState = buildInitialState({
      tree: buildPickerTree(partialPages),
      existingSelectedIds: [IDS.architecture],
    });
    const { lastFrame } = renderInkTest(
      <TreePickerApp
        initialState={initialState}
        chrome={chrome()}
        terminalRows={24}
        terminalWidth={100}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('◧ Engineering Docs ▾');
    expect(frame).toContain('  ◼ Architecture');
    expect(frame).not.toContain('◻ Engineering Docs');
  });

  it('supports keyboard selection, confirm-on-save, and save callback', async () => {
    const onExit = vi.fn();
    const { stdin, lastFrame } = renderInkTest(
      <TreePickerApp
        initialState={state({ requireConfirmOnSave: true })}
        chrome={chrome({
          confirmSaveMessage: (current) =>
            `Confirm: ${current.checked.size} item${current.checked.size === 1 ? '' : 's'}? Press Enter or Escape.`,
        })}
        terminalRows={24}
        terminalWidth={100}
        onExit={onExit}
      />,
    );

    stdin.write('\t');
    await waitForInkInput();
    expect(lastFrame()).toContain('◼ Engineering Docs');

    stdin.write('\r');
    await waitForInkInput();
    expect(normalizeFrameWrap(lastFrame())).toContain('Confirm: 1 item? Press Enter or Escape.');

    stdin.write('y');
    await waitForInkInput();
    expect(onExit).toHaveBeenCalledWith({ kind: 'save', selectedIds: [IDS.engineering] });
  });

  it('uses the chrome-supplied skip-empty message and quits on confirm', async () => {
    const onExit = vi.fn();
    const { stdin, lastFrame } = renderInkTest(
      <TreePickerApp
        initialState={state()}
        chrome={chrome({ skipEmptyMessage: 'No selections. Skip or back?' })}
        terminalRows={24}
        terminalWidth={100}
        onExit={onExit}
      />,
    );

    stdin.write('\r');
    await waitForInkInput();
    expect(normalizeFrameWrap(lastFrame())).toContain('No selections. Skip or back?');
    expect(onExit).not.toHaveBeenCalled();

    stdin.write('n');
    await waitForInkInput();
    expect(lastFrame()).not.toContain('No selections. Skip or back?');
    expect(onExit).not.toHaveBeenCalled();

    stdin.write('\r');
    await waitForInkInput();
    expect(lastFrame()).toContain('No selections. Skip or back?');

    stdin.write('\r');
    await waitForInkInput();
    expect(onExit).toHaveBeenCalledWith({ kind: 'quit' });
  });

  it('renders row-window overflow indicators when the visible list is clipped', async () => {
    const onExit = vi.fn();
    const initialState = buildInitialState({
      tree: buildPickerTree(manyPages()),
      existingSelectedIds: [],
    });
    initialState.expanded = new Set([IDS.engineering]);
    const { stdin, lastFrame } = renderInkTest(
      <TreePickerApp
        initialState={initialState}
        chrome={chrome()}
        terminalRows={13}
        terminalWidth={100}
        onExit={onExit}
      />,
    );

    expect(lastFrame()).toContain('↓ 4 more');

    stdin.write('[B');
    stdin.write('[B');
    stdin.write('[B');
    stdin.write('[B');
    await waitForInkInput();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑ ');
    expect(frame).toContain('↓ ');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('quits without saving on Ctrl+C', async () => {
    const onExit = vi.fn();
    const { stdin } = renderInkTest(
      <TreePickerApp
        initialState={state()}
        chrome={chrome()}
        terminalRows={24}
        terminalWidth={100}
        onExit={onExit}
      />,
    );

    stdin.write('');
    await waitForInkInput();
    expect(onExit).toHaveBeenCalledWith({ kind: 'quit' });
  });
});

describe('renderTreePickerTui', () => {
  it('returns the app result from the Ink runtime', async () => {
    const io = {
      stdin: { isTTY: true, setRawMode: vi.fn() },
      stdout: { isTTY: true, columns: 100, rows: 24, write: vi.fn() },
      stderr: { write: vi.fn() },
    };
    const renderInk = vi.fn((_tree: ReactNode, _options: TreePickerInkRenderOptions) => fakeInkInstance());

    await expect(
      renderTreePickerTui(
        { initialState: state(), chrome: chrome() },
        io,
        { renderInk },
      ),
    ).resolves.toEqual({ kind: 'quit' });
    expect(renderInk).toHaveBeenCalledOnce();
  });

  it('sanitizes render errors and uses the supplied scripted-mode hint', async () => {
    expect(sanitizeTreePickerTuiError(new Error('token=secret https://api.example.com/v1/search'))).toBe(
      '[redacted] [redacted-url]',
    );
  });

  it('falls back to quit with the scripted-mode hint when Ink cannot initialize', async () => {
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
      renderTreePickerTui(
        { initialState: state(), chrome: chrome() },
        io,
        {
          renderInk: vi.fn(() => {
            throw new Error('token=secret');
          }),
          scriptedModeHint: 'Use --no-input --foo bar for scripted mode.',
        },
      ),
    ).resolves.toEqual({ kind: 'quit' });
    expect(stderr).toContain('Use --no-input --foo bar for scripted mode.');
    expect(stderr).not.toContain('secret');
  });
});
