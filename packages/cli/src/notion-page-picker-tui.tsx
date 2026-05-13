/* @jsxImportSource react */
import { Box, Text, render as renderInkRuntime, useApp, useInput } from 'ink';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  filterTree,
  flattenSelection,
  isAncestorChecked,
  reducer,
  visibleNodeIds,
  type PickerCommand,
  type PickerState,
} from './notion-page-picker-tree.js';
import type { KtxCliIo } from './cli-runtime.js';

const COLOR_THEME = {
  text: 'white',
  muted: 'gray',
  active: 'cyan',
  warning: 'yellow',
} as const;

const NO_COLOR_THEME = {
  text: 'white',
  muted: 'white',
  active: 'white',
  warning: 'white',
} as const;

type NotionPickerTheme = Record<keyof typeof COLOR_THEME, string>;

export interface NotionPickerTuiIo extends KtxCliIo {
  stdin?: { isTTY?: boolean; setRawMode?(value: boolean): void };
  stdout: KtxCliIo['stdout'] & { isTTY?: boolean; columns?: number; rows?: number };
}

interface InkKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export type PickerRenderResult = { kind: 'save'; rootPageIds: string[] } | { kind: 'quit' };

export interface PickerRenderInput {
  initialState: PickerState;
  connectionId: string;
  workspaceLabel: string;
  cappedAtCount: number | null;
  currentCrawlMode: 'all_accessible' | 'selected_roots';
}

interface NotionPickerAppProps extends PickerRenderInput {
  terminalRows?: number;
  terminalWidth?: number;
  env?: NodeJS.ProcessEnv;
  onExit(result: PickerRenderResult): void;
}

export interface NotionPickerInkInstance {
  rerender(tree: ReactNode): void;
  unmount(): void;
  waitUntilExit(): Promise<void>;
}

export interface NotionPickerInkRenderOptions {
  stdin?: NotionPickerTuiIo['stdin'];
  stdout: NotionPickerTuiIo['stdout'];
  stderr: NotionPickerTuiIo['stderr'];
  exitOnCtrlC: boolean;
  patchConsole: boolean;
  maxFps: number;
  alternateScreen: boolean;
}

function resolveTheme(env: NodeJS.ProcessEnv = process.env): NotionPickerTheme {
  return env.NO_COLOR || env.TERM === 'dumb' ? NO_COLOR_THEME : COLOR_THEME;
}

export function resolveNotionPickerWidth(columns: number | undefined): number {
  const resolvedColumns = columns ?? 100;
  return Math.max(60, Math.min(120, resolvedColumns - 4));
}

function staleWarningText(warning: string): string {
  return warning.includes('stored root_page_ids no longer visible')
    ? `${warning} - they will be removed if you save`
    : warning;
}

function selectedPageCountText(count: number): string {
  return `${count} selected ${count === 1 ? 'page' : 'pages'}`;
}

function rowMatchesSearch(state: PickerState, nodeId: string): boolean {
  const query = state.search.query.trim().toLocaleLowerCase();
  if (!query) {
    return false;
  }
  const node = state.byId.get(nodeId);
  if (!node) {
    return false;
  }
  return node.title.toLocaleLowerCase().includes(query) || node.path.toLocaleLowerCase().includes(query);
}

export function sanitizeNotionPickerTuiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\b(api[_-]?key|password|token|secret)=\S+/gi, '[redacted]');
}

export function windowOffset(count: number, selected: number, visible: number): number {
  if (count <= visible) return 0;
  return Math.max(0, Math.min(count - visible, selected - Math.floor(visible / 2)));
}

export function windowItems<T>(items: T[], selected: number, visible: number): { items: T[]; offset: number } {
  const offset = windowOffset(items.length, selected, visible);
  return { items: items.slice(offset, offset + visible), offset };
}

function truncateText(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

export function notionPickerCommandForInkInput(
  input: string,
  key: InkKey,
  search: PickerState['search'],
  pendingConfirm: PickerState['pendingConfirm'],
): PickerCommand | null {
  if (pendingConfirm) {
    if (input === 'y' || key.return) return 'save-confirm';
    if (input === 'n' || key.escape) return 'save-cancel';
    if (key.ctrl === true && input === 'c') return 'quit';
    return null;
  }
  if (search.editing) {
    if (key.escape) return 'search-cancel';
    if (key.return) return 'search-submit';
    if (key.backspace || key.delete) return 'search-backspace';
    if (key.downArrow) return 'cursor-down';
    if (key.upArrow) return 'cursor-up';
    if (input.length === 1 && input >= ' ' && input !== '\u007f') return { type: 'search-input', value: input };
    return null;
  }
  if (key.ctrl === true && input === 'c') return 'quit';
  if (key.upArrow) return 'cursor-up';
  if (key.downArrow) return 'cursor-down';
  if (key.leftArrow) return 'cursor-left';
  if (key.rightArrow) return 'cursor-right';
  if (key.return) return 'expand';
  if (input === ' ') return 'toggle-check';
  if (input === '/') return 'search-start';
  if (input === 'a') return 'select-all-visible';
  if (input === 'n') return 'select-none';
  if (input === 's') return 'save-request';
  if (input === 'q' || key.escape) return 'quit';
  return null;
}

function PickerRow(props: { state: PickerState; nodeId: string; width: number; theme: NotionPickerTheme }): ReactNode {
  const node = props.state.byId.get(props.nodeId);
  if (!node) return null;
  const focused = props.state.cursorId === node.id;
  const locked = isAncestorChecked(node.id, props.state.checked, props.state.byId);
  const checked = props.state.checked.has(node.id);
  const glyph = locked ? '[~]' : checked ? '[×]' : '[ ]';
  const children =
    node.childIds.length > 0 ? (props.state.expanded.has(node.id) ? ' ▾' : ` ▸ (${node.childIds.length})`) : '';
  const prefix = `${focused ? '▸' : ' '} ${glyph} ${' '.repeat(node.depth * 2)}`;
  const color = focused ? props.theme.active : locked || node.archived ? props.theme.muted : props.theme.text;
  const title = truncateText(`${node.title}${children}`, Math.max(10, props.width - prefix.length));
  const inverse = rowMatchesSearch(props.state, node.id);

  return (
    <Text color={color} strikethrough={node.archived}>
      {prefix}
      <Text inverse={inverse}>{title}</Text>
    </Text>
  );
}

export function NotionPickerApp(props: NotionPickerAppProps): ReactNode {
  const app = useApp();
  const [state, setState] = useState(props.initialState);
  const stateRef = useRef(state);
  const theme = useMemo(() => resolveTheme(props.env), [props.env]);
  const visibleIds = visibleNodeIds(state);
  const selectedIndex = Math.max(0, visibleIds.indexOf(state.cursorId));
  const reservedRows = state.pendingConfirm === 'mode-switch' ? 9 : 8;
  const visibleRows = Math.max(5, Math.min(20, (props.terminalRows ?? 24) - reservedRows));
  const rows = windowItems(visibleIds, selectedIndex, visibleRows);
  const hiddenAbove = rows.offset;
  const hiddenBelow = Math.max(0, visibleIds.length - rows.offset - rows.items.length);
  const searchMatchCount = filterTree(state).visibleIds.size;
  const width = resolveNotionPickerWidth(props.terminalWidth);
  const showSearch = state.search.editing || state.search.query.trim().length > 0;
  const selectedCount = flattenSelection(state.checked, state.byId).length;

  stateRef.current = state;

  useEffect(() => {
    const hint = state.transientHint;
    if (!hint) {
      return;
    }

    const clearHint = () => {
      setState((current) => {
        const { next } = reducer(current, 'clear-transient-hint');
        stateRef.current = next;
        return next;
      });
    };
    const delay = hint.expiresAt - Date.now();
    if (delay <= 0) {
      clearHint();
      return;
    }

    const timeout = setTimeout(clearHint, delay);

    return () => clearTimeout(timeout);
  }, [state.transientHint?.expiresAt]);

  useInput((input, key) => {
    const command = notionPickerCommandForInkInput(input, key, stateRef.current.search, stateRef.current.pendingConfirm);
    if (!command) {
      return;
    }
    const { next, effect } = reducer(stateRef.current, command);
    stateRef.current = next;
    setState(next);
    if (effect === 'save') {
      props.onExit({ kind: 'save', rootPageIds: flattenSelection(next.checked, next.byId) });
      app.exit();
      return;
    }
    if (effect === 'quit-without-save') {
      props.onExit({ kind: 'quit' });
      app.exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.active}>Notion pages visible to integration "{props.workspaceLabel}"</Text>
      {props.cappedAtCount ? <Text color={theme.warning}>{props.cappedAtCount}-page cap reached - some pages not shown</Text> : null}
      {state.preLoadWarnings.map((warning) => (
        <Text key={warning} color={theme.warning}>
          {staleWarningText(warning)}
        </Text>
      ))}
      {showSearch ? (
        <Text color={theme.muted}>
          / {state.search.query}
          {state.search.editing ? '█' : ''} ({searchMatchCount} matches)
        </Text>
      ) : null}
      <Box flexDirection="column">
        {hiddenAbove > 0 ? <Text color={theme.muted}>↑ {hiddenAbove} more</Text> : null}
        {rows.items.map((nodeId) => (
          <PickerRow key={nodeId} state={state} nodeId={nodeId} width={width} theme={theme} />
        ))}
        {hiddenBelow > 0 ? <Text color={theme.muted}>↓ {hiddenBelow} more</Text> : null}
      </Box>
      {state.pendingConfirm === 'mode-switch' ? (
        <Text color={theme.warning}>
          Save will switch crawl_mode all_accessible -&gt; selected_roots and limit ingest to{' '}
          {selectedPageCountText(selectedCount)}. [y] confirm  [esc] back
        </Text>
      ) : null}
      {state.transientHint ? <Text color={theme.warning}>{state.transientHint.text}</Text> : null}
      <Text color={theme.muted}>space toggle · enter expand · / search · a all · n none · s save &amp; exit · q quit</Text>
    </Box>
  );
}

function renderInk(tree: ReactNode, options: NotionPickerInkRenderOptions): NotionPickerInkInstance {
  return renderInkRuntime(tree, {
    stdin: options.stdin as NodeJS.ReadStream | undefined,
    stdout: options.stdout as NodeJS.WriteStream,
    stderr: options.stderr as NodeJS.WriteStream,
    exitOnCtrlC: options.exitOnCtrlC,
    patchConsole: options.patchConsole,
    maxFps: options.maxFps,
    alternateScreen: options.alternateScreen,
  }) as NotionPickerInkInstance;
}

export async function renderNotionPickerTui(
  input: PickerRenderInput,
  io: NotionPickerTuiIo,
  options: { renderInk?: (tree: ReactNode, options: NotionPickerInkRenderOptions) => NotionPickerInkInstance } = {},
): Promise<PickerRenderResult> {
  let result: PickerRenderResult = { kind: 'quit' };
  let instance: NotionPickerInkInstance | null = null;
  try {
    instance = (options.renderInk ?? renderInk)(
      <NotionPickerApp
        {...input}
        terminalRows={(io.stdout as { rows?: number }).rows ?? process.stdout.rows ?? 24}
        terminalWidth={io.stdout.columns ?? process.stdout.columns}
        onExit={(next) => {
          result = next;
          instance?.unmount();
        }}
      />,
      {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: 30,
        alternateScreen: true,
      },
    );
    await instance.waitUntilExit();
    instance.unmount();
    return result;
  } catch (error) {
    io.stderr.write(
      `Notion picker requires a TTY. Use --no-input --notion-root-page-id <UUID> for scripted mode. ${sanitizeNotionPickerTuiError(error)}\n`,
    );
    return { kind: 'quit' };
  }
}
