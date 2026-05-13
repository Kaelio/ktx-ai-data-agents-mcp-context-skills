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
} from './tree-picker-state.js';
import type { KtxCliIo } from './cli-runtime.js';

const COLOR_THEME = {
  text: 'white',
  muted: 'gray',
  active: 'cyan',
  selected: 'green',
  warning: 'yellow',
} as const;

const NO_COLOR_THEME = {
  text: 'white',
  muted: 'white',
  active: 'white',
  selected: 'white',
  warning: 'white',
} as const;

type TreePickerTheme = Record<keyof typeof COLOR_THEME, string>;

const DEFAULT_TREE_PICKER_HELP_TEXT =
  'Right Arrow to expand, Up/Down to move, Space to select or unselect, Slash to filter, Enter to confirm, Escape to go back, or Ctrl+C to exit.';

const DEFAULT_SKIP_EMPTY_MESSAGE =
  'Nothing selected. Skip this step? Press Enter to skip or Escape to go back.';

export interface TreePickerTuiIo extends KtxCliIo {
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

export type TreePickerResult = { kind: 'save'; selectedIds: string[] } | { kind: 'quit' };

export interface TreePickerChrome {
  title: string;
  helpText?: string;
  subtitleLines?: readonly string[];
  warningLines?: readonly string[];
  confirmSaveMessage?: (state: PickerState) => string;
  skipEmptyMessage?: string;
}

export interface TreePickerRenderInput {
  initialState: PickerState;
  chrome: TreePickerChrome;
}

interface TreePickerAppProps extends TreePickerRenderInput {
  terminalRows?: number;
  terminalWidth?: number;
  env?: NodeJS.ProcessEnv;
  onExit(result: TreePickerResult): void;
}

export interface TreePickerInkInstance {
  rerender(tree: ReactNode): void;
  unmount(): void;
  waitUntilExit(): Promise<void>;
}

export interface TreePickerInkRenderOptions {
  stdin?: TreePickerTuiIo['stdin'];
  stdout: TreePickerTuiIo['stdout'];
  stderr: TreePickerTuiIo['stderr'];
  exitOnCtrlC: boolean;
  patchConsole: boolean;
  maxFps: number;
  alternateScreen: boolean;
}

function resolveTheme(env: NodeJS.ProcessEnv = process.env): TreePickerTheme {
  return env.NO_COLOR || env.TERM === 'dumb' ? NO_COLOR_THEME : COLOR_THEME;
}

export function resolveTreePickerWidth(columns: number | undefined): number {
  const resolvedColumns = columns ?? 100;
  return Math.max(60, Math.min(120, resolvedColumns - 4));
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

export function sanitizeTreePickerTuiError(error: unknown): string {
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

export function treePickerCommandForInkInput(
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
    if (input.length === 1 && input >= ' ' && input !== '') return { type: 'search-input', value: input };
    return null;
  }
  if (key.ctrl === true && input === 'c') return 'quit';
  if (key.upArrow) return 'cursor-up';
  if (key.downArrow) return 'cursor-down';
  if (key.leftArrow) return 'cursor-left';
  if (key.rightArrow) return 'cursor-right';
  if (key.return) return 'save-request';
  if (input === ' ') return 'toggle-check';
  if (input === '/') return 'search-start';
  if (input === 'a') return 'select-all-visible';
  if (input === 'n') return 'select-none';
  if (key.escape) return 'quit';
  return null;
}

function PickerRow(props: { state: PickerState; nodeId: string; width: number; theme: TreePickerTheme }): ReactNode {
  const node = props.state.byId.get(props.nodeId);
  if (!node) return null;
  const focused = props.state.cursorId === node.id;
  const locked = isAncestorChecked(node.id, props.state.checked, props.state.byId);
  const checked = props.state.checked.has(node.id);
  const isSelected = checked || locked;
  const glyph = isSelected ? '◼' : '◻';
  const glyphColor = checked || locked ? props.theme.selected : props.theme.muted;
  const childAffordance =
    node.childIds.length > 0 ? (props.state.expanded.has(node.id) ? ' ▾' : ` ▸ (${node.childIds.length})`) : '';
  const indent = ' '.repeat(node.depth * 2);
  const titleColor = focused ? props.theme.active : props.theme.text;
  const inverse = rowMatchesSearch(props.state, node.id);
  const prefixWidth = indent.length + 2 + childAffordance.length;
  const title = truncateText(node.title, Math.max(10, props.width - prefixWidth));

  return (
    <Text>
      <Text color={glyphColor}>
        {indent}
        {glyph}
      </Text>
      <Text color={titleColor} strikethrough={node.archived} bold={focused}>
        {' '}
        <Text inverse={inverse}>{title}</Text>
      </Text>
      {childAffordance.length > 0 ? <Text color={props.theme.muted}>{childAffordance}</Text> : null}
    </Text>
  );
}

export function TreePickerApp(props: TreePickerAppProps): ReactNode {
  const app = useApp();
  const [state, setState] = useState(props.initialState);
  const stateRef = useRef(state);
  const theme = useMemo(() => resolveTheme(props.env), [props.env]);
  const visibleIds = visibleNodeIds(state);
  const selectedIndex = Math.max(0, visibleIds.indexOf(state.cursorId));
  const reservedRows = state.pendingConfirm === 'save-confirm' ? 10 : 9;
  const visibleRows = Math.max(5, Math.min(12, (props.terminalRows ?? 24) - reservedRows));
  const rows = windowItems(visibleIds, selectedIndex, visibleRows);
  const hiddenAbove = rows.offset;
  const hiddenBelow = Math.max(0, visibleIds.length - rows.offset - rows.items.length);
  const searchMatchCount = filterTree(state).visibleIds.size;
  const width = resolveTreePickerWidth(props.terminalWidth);
  const showSearch = state.search.editing || state.search.query.trim().length > 0;
  const helpText = props.chrome.helpText ?? DEFAULT_TREE_PICKER_HELP_TEXT;
  const skipEmptyMessage = props.chrome.skipEmptyMessage ?? DEFAULT_SKIP_EMPTY_MESSAGE;

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
    const command = treePickerCommandForInkInput(input, key, stateRef.current.search, stateRef.current.pendingConfirm);
    if (!command) {
      return;
    }
    const { next, effect } = reducer(stateRef.current, command);
    stateRef.current = next;
    setState(next);
    if (effect === 'save') {
      props.onExit({ kind: 'save', selectedIds: flattenSelection(next.checked, next.byId) });
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
      <Text>
        <Text color={theme.active}>◆</Text>
        <Text bold> {props.chrome.title}</Text>
      </Text>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={theme.active}
        paddingLeft={1}
      >
        <Text color={theme.muted}>{helpText}</Text>
        <Text> </Text>
        {(props.chrome.subtitleLines ?? []).map((line, idx) => (
          <Text key={`subtitle-${idx}`} color={theme.muted}>
            {line}
          </Text>
        ))}
        {(props.chrome.warningLines ?? []).map((line, idx) => (
          <Text key={`chromewarn-${idx}`} color={theme.warning}>
            {line}
          </Text>
        ))}
        {state.preLoadWarnings.map((warning) => (
          <Text key={warning} color={theme.warning}>
            {warning}
          </Text>
        ))}
        {showSearch ? (
          <Text>
            <Text color={theme.muted}>/ </Text>
            <Text>
              {state.search.query}
              {state.search.editing ? '█' : ''}
            </Text>
            <Text color={theme.muted}>  ({searchMatchCount} matches)</Text>
          </Text>
        ) : null}
        <Text> </Text>
        {hiddenAbove > 0 ? <Text color={theme.muted}>↑ {hiddenAbove} more</Text> : null}
        {rows.items.map((nodeId) => (
          <PickerRow key={nodeId} state={state} nodeId={nodeId} width={width} theme={theme} />
        ))}
        {hiddenBelow > 0 ? <Text color={theme.muted}>↓ {hiddenBelow} more</Text> : null}
        {state.pendingConfirm === 'save-confirm' ? (
          <Text color={theme.warning}>
            {props.chrome.confirmSaveMessage
              ? props.chrome.confirmSaveMessage(state)
              : 'Confirm save? Press Enter to confirm or Escape to go back.'}
          </Text>
        ) : null}
        {state.pendingConfirm === 'skip-empty' ? <Text color={theme.warning}>{skipEmptyMessage}</Text> : null}
        {state.transientHint ? <Text color={theme.warning}>{state.transientHint.text}</Text> : null}
      </Box>
      <Text color={theme.active}>└</Text>
    </Box>
  );
}

function renderInk(tree: ReactNode, options: TreePickerInkRenderOptions): TreePickerInkInstance {
  return renderInkRuntime(tree, {
    stdin: options.stdin as NodeJS.ReadStream | undefined,
    stdout: options.stdout as NodeJS.WriteStream,
    stderr: options.stderr as NodeJS.WriteStream,
    exitOnCtrlC: options.exitOnCtrlC,
    patchConsole: options.patchConsole,
    maxFps: options.maxFps,
    alternateScreen: options.alternateScreen,
  }) as TreePickerInkInstance;
}

export interface RenderTreePickerOptions {
  renderInk?: (tree: ReactNode, options: TreePickerInkRenderOptions) => TreePickerInkInstance;
  scriptedModeHint?: string;
}

export async function renderTreePickerTui(
  input: TreePickerRenderInput,
  io: TreePickerTuiIo,
  options: RenderTreePickerOptions = {},
): Promise<TreePickerResult> {
  let result: TreePickerResult = { kind: 'quit' };
  let instance: TreePickerInkInstance | null = null;
  try {
    instance = (options.renderInk ?? renderInk)(
      <TreePickerApp
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
        alternateScreen: false,
      },
    );
    await instance.waitUntilExit();
    instance.unmount();
    return result;
  } catch (error) {
    const hint = options.scriptedModeHint ?? 'Picker requires a TTY.';
    io.stderr.write(`${hint} ${sanitizeTreePickerTuiError(error)}\n`);
    return { kind: 'quit' };
  }
}
