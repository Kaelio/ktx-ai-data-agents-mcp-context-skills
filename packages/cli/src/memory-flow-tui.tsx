/* @jsxImportSource react */
import {
  buildMemoryFlowViewModel,
  createInitialMemoryFlowInteractionState,
  findMemoryFlowSearchMatches,
  type MemoryFlowColumnId,
  type MemoryFlowInteractionCommand,
  type MemoryFlowInteractionState,
  type MemoryFlowReplayInput,
  type MemoryFlowViewModel,
  reduceMemoryFlowInteractionState,
  selectedMemoryFlowColumn,
  selectedMemoryFlowDetails,
} from './context/ingest/index.js';
import { Box, Text, render as renderInkRuntime, useApp, useInput } from 'ink';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityFeed,
  Hud,
  Logo,
} from './memory-flow-hud.js';
import { profileMark } from './startup-profile.js';

profileMark('module:memory-flow-tui');

const COLOR_THEME = {
  text: 'white',
  muted: 'gray',
  active: 'cyan',
  complete: 'green',
  warning: 'yellow',
  failed: 'red',
  border: 'gray',
} as const;

const NO_COLOR_THEME = {
  text: 'white',
  muted: 'white',
  active: 'white',
  complete: 'white',
  warning: 'white',
  failed: 'white',
  border: 'white',
} as const;

type MemoryFlowTuiTheme = Record<keyof typeof COLOR_THEME, string>;

const STAGE_LABELS = {
  source: 'CONNECT',
  chunks: 'SNAPSHOT',
  workUnits: 'PLAN',
  actions: 'ANALYZE',
  gates: 'VALIDATE',
  saved: 'MEMORY',
} satisfies Record<MemoryFlowColumnId, string>;

export interface KtxMemoryFlowTuiIo {
  stdin?: { isTTY?: boolean; setRawMode?(value: boolean): void };
  stdout: { isTTY?: boolean; columns?: number; write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export interface MemoryFlowTuiLiveSession {
  update(input: MemoryFlowReplayInput): void;
  close(): void;
  isClosed(): boolean;
}

export interface MemoryFlowInkInstance {
  rerender(tree: ReactNode): void;
  unmount(): void;
  waitUntilExit(): Promise<void>;
  clear?(): void;
}

export interface MemoryFlowInkRenderOptions {
  stdin?: KtxMemoryFlowTuiIo['stdin'];
  stdout: KtxMemoryFlowTuiIo['stdout'];
  stderr: KtxMemoryFlowTuiIo['stderr'];
  exitOnCtrlC: boolean;
  patchConsole: boolean;
  maxFps: number;
  alternateScreen: boolean;
}

interface RenderMemoryFlowTuiOptions {
  renderInk?: (tree: ReactNode, options: MemoryFlowInkRenderOptions) => MemoryFlowInkInstance;
  paceEvents?: boolean;
  paceMsPerEvent?: number;
  speedMultiplier?: number;
}

interface StartLiveMemoryFlowTuiOptions {
  renderInk?: (tree: ReactNode, options: MemoryFlowInkRenderOptions) => MemoryFlowInkInstance;
}

interface RenderTreeOptions {
  paceEvents?: boolean;
  paceMsPerEvent?: number;
  frameMs?: number;
  completionFrameMs?: number;
  completionHoldMs?: number;
}

interface MemoryFlowTuiTiming {
  paceMsPerEvent: number;
  frameMs: number;
  completionFrameMs: number;
  completionHoldMs: number;
}

const DEFAULT_TUI_TIMING = {
  paceMsPerEvent: 180,
  frameMs: 140,
  completionFrameMs: 80,
  completionHoldMs: 1000,
} satisfies MemoryFlowTuiTiming;

interface InkKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

interface MemoryFlowTuiAppProps {
  input: MemoryFlowReplayInput;
  terminalWidth?: number;
  env?: NodeJS.ProcessEnv;
  onExit(): void;
  paceEvents?: boolean;
  paceMsPerEvent?: number;
  frameMs?: number;
  completionFrameMs?: number;
  completionHoldMs?: number;
  showBoot?: boolean;
}

function resolveMemoryFlowTuiTheme(env: NodeJS.ProcessEnv = process.env): MemoryFlowTuiTheme {
  if (env.NO_COLOR || env.TERM === 'dumb') {
    return NO_COLOR_THEME;
  }
  return COLOR_THEME;
}

export function sanitizeMemoryFlowTuiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\b(api[_-]?key|password|token|secret)=\S+/gi, '[redacted]');
}

export function memoryFlowCommandForInkInput(
  input: string,
  key: InkKey,
  search: MemoryFlowInteractionState['search'] = { editing: false, query: '', matchIndex: 0 },
): MemoryFlowInteractionCommand | null {
  if (search.editing) {
    if (key.escape) return 'search-clear';
    if (key.return) return 'search-submit';
    if (key.backspace || key.delete) return 'search-backspace';
    if (key.downArrow || (key.tab && !key.shift)) return 'search-next';
    if (key.upArrow || (key.tab && key.shift)) return 'search-previous';
    if (input.length === 1 && input >= ' ' && input !== '') {
      return { type: 'search-input', value: input };
    }
    return null;
  }

  if (key.ctrl === true && input === 'c') return 'quit';
  if (input === '/') return 'search-start';
  if (search.query && input === 'n') return 'search-next';
  if (search.query && input === 'N') return 'search-previous';
  if (input === '[D') return 'left';
  if (input === '[C') return 'right';
  if (input === '[A') return 'up';
  if (input === '[B') return 'down';
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.return) return 'enter';
  if (key.tab) return 'tab';
  if (input === 'f') return 'filter';
  if (input === 'p') return 'provenance';
  if (input === 't') return 'transcript';
  if (input === 'q' || key.escape) return 'quit';
  return null;
}

function stageLabel(columnId: MemoryFlowColumnId): string {
  return STAGE_LABELS[columnId];
}

function filterLabel(filter: MemoryFlowInteractionState['filter']): string {
  return filter === 'failed_or_flagged' ? 'issues' : 'all';
}

function searchStatusLine(view: MemoryFlowViewModel, state: MemoryFlowInteractionState): string | null {
  if (!state.search.editing && state.search.query.length === 0) {
    return null;
  }
  const matches = findMemoryFlowSearchMatches(view, state.search.query);
  const status = state.search.editing ? 'editing' : 'locked';
  const position = matches.length === 0 ? '0/0' : `${state.search.matchIndex + 1}/${matches.length}`;
  return `Search: ${state.search.query || '/'} (${position} matches, ${status})`;
}

function humanizeDemoText(value: string): string {
  return value
    .replace(/\bWORKUNITS\b/g, 'PLAN')
    .replace(/\bWorkUnit\b/g, 'Table review')
    .replace(/\bwork units\b/gi, 'table reviews')
    .replace(/\bwork-unit\b/gi, 'table-review')
    .replace(/\bWUs\b/g, 'tables')
    .replace(/\bchunks\b/gi, 'table groups')
    .replace(/\bcandidates\b/gi, 'drafts')
    .replace(/\bcandidate\b/gi, 'draft')
    .replace(/\braw files\b/gi, 'database files')
    .replace(/\braw file\b/gi, 'database file')
    .replace(/\bSL\b/g, 'context layer');
}

function DetailsPane(props: {
  view: MemoryFlowViewModel;
  state: MemoryFlowInteractionState;
  theme: MemoryFlowTuiTheme;
}): ReactNode {
  const column = selectedMemoryFlowColumn(props.view, props.state);
  const details = selectedMemoryFlowDetails(props.view, props.state).map(humanizeDemoText).slice(0, 8);
  const rawFiles = Array.from(
    new Set([
      ...props.view.details.actions.flatMap((action) => action.rawFiles),
      ...props.view.details.provenance.map((row) => row.rawPath),
    ]),
  ).slice(0, 4);
  const searchLine = searchStatusLine(props.view, props.state);

  return (
    <Box flexDirection="column">
      <Text color={props.theme.active}>
        Details / focus: {stageLabel(column.id)}  Pane: {props.state.pane}  Filter: {filterLabel(props.state.filter)}
      </Text>
      {searchLine && <Text color={props.theme.active}>{searchLine}</Text>}
      {details.map((detail, index) => (
        <Text key={`${index}-${detail}`} color={props.theme.text}>
          - {detail}
        </Text>
      ))}
      {rawFiles.map((rawFile) => (
        <Text key={rawFile} color={props.theme.muted}>
          - {rawFile}
        </Text>
      ))}
      {props.view.completionLine && <Text color={props.theme.complete}>{humanizeDemoText(props.view.completionLine)}</Text>}
    </Box>
  );
}

function TrustIssues(props: { view: MemoryFlowViewModel; theme: MemoryFlowTuiTheme }): ReactNode {
  if (props.view.trustIssues.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={props.theme.warning}>Validation notes</Text>
      {props.view.trustIssues.slice(0, 4).map((issue) => (
        <Text
          key={`${issue.severity}-${issue.title}`}
          color={issue.severity === 'failed' ? props.theme.failed : props.theme.warning}
        >
          {issue.severity === 'failed' ? 'FAILED' : 'WARNING'} {humanizeDemoText(issue.title)}:{' '}
          {humanizeDemoText(issue.detail)}
        </Text>
      ))}
    </Box>
  );
}

export function MemoryFlowTuiApp(props: MemoryFlowTuiAppProps): ReactNode {
  const app = useApp();
  const totalEvents = props.input.events.length;
  const paceEnabled = props.paceEvents === true && totalEvents > 0;
  const [pacedCount, setPacedCount] = useState<number>(paceEnabled ? 0 : totalEvents);

  const pacedInput = useMemo<MemoryFlowReplayInput>(() => {
    if (!paceEnabled || pacedCount >= totalEvents) {
      return props.input;
    }
    return {
      ...props.input,
      status: 'running',
      events: props.input.events.slice(0, pacedCount),
    };
  }, [paceEnabled, pacedCount, totalEvents, props.input]);

  const pacedNow = useMemo<(() => number) | undefined>(() => {
    if (!paceEnabled) return undefined;
    const firstEvent = props.input.events[0];
    if (!firstEvent?.emittedAt) return undefined;
    const firstEventMs = Date.parse(firstEvent.emittedAt);
    if (!Number.isFinite(firstEventMs)) return undefined;
    const stride = props.paceMsPerEvent ?? DEFAULT_TUI_TIMING.paceMsPerEvent;
    return () => firstEventMs + pacedCount * stride;
  }, [paceEnabled, pacedCount, props.input.events, props.paceMsPerEvent]);

  const view = useMemo(() => buildMemoryFlowViewModel(pacedInput), [pacedInput]);
  const [state, setState] = useState<MemoryFlowInteractionState>(() => createInitialMemoryFlowInteractionState(view));
  const [frame, setFrame] = useState(0);
  const [completionFrame, setCompletionFrame] = useState(0);
  const [holdComplete, setHoldComplete] = useState(false);
  const [userHasNavigated, setUserHasNavigated] = useState(false);
  const lastEventCountRef = useRef(pacedInput.events.length);
  const lastStatusRef = useRef(pacedInput.status);
  const exitHandled = useRef(false);
  const theme = resolveMemoryFlowTuiTheme(props.env);

  useEffect(() => {
    if (!state.shouldQuit || exitHandled.current) {
      return;
    }
    exitHandled.current = true;
    props.onExit();
    app.exit();
  }, [app, props, state.shouldQuit]);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, props.frameMs ?? DEFAULT_TUI_TIMING.frameMs);
    return () => clearInterval(timer);
  }, [props.frameMs]);

  useEffect(() => {
    if (lastEventCountRef.current !== pacedInput.events.length) {
      lastEventCountRef.current = pacedInput.events.length;
    }
  }, [pacedInput.events.length]);

  useEffect(() => {
    if (lastStatusRef.current !== pacedInput.status) {
      lastStatusRef.current = pacedInput.status;
      if (pacedInput.status === 'done' || pacedInput.status === 'error') {
        setCompletionFrame(0);
      }
    }
  }, [pacedInput.status]);

  useEffect(() => {
    if (pacedInput.status !== 'done' && pacedInput.status !== 'error') return;
    if (completionFrame >= 12) return;
    const timer = setInterval(
      () => setCompletionFrame((current) => Math.min(12, current + 1)),
      props.completionFrameMs ?? DEFAULT_TUI_TIMING.completionFrameMs,
    );
    return () => clearInterval(timer);
  }, [pacedInput.status, completionFrame, props.completionFrameMs]);

  useEffect(() => {
    if (completionFrame < 12) {
      setHoldComplete(false);
      return;
    }
    const timer = setTimeout(
      () => setHoldComplete(true),
      props.completionHoldMs ?? DEFAULT_TUI_TIMING.completionHoldMs,
    );
    return () => clearTimeout(timer);
  }, [completionFrame, props.completionHoldMs]);

  useEffect(() => {
    if (!paceEnabled || pacedCount >= totalEvents) {
      return;
    }
    const interval = props.paceMsPerEvent ?? DEFAULT_TUI_TIMING.paceMsPerEvent;
    const timer = setInterval(() => {
      setPacedCount((current) => Math.min(totalEvents, current + 1));
    }, interval);
    return () => clearInterval(timer);
  }, [paceEnabled, pacedCount, totalEvents, props.paceMsPerEvent]);

  useInput((input, key) => {
    const command = memoryFlowCommandForInkInput(input, key, state.search);
    if (!command) return;
    if (command === 'quit' && isComplete && !holdComplete) return;
    if (command !== 'quit') setUserHasNavigated(true);
    setState((current) => reduceMemoryFlowInteractionState(current, command, view));
  });

  const isComplete = pacedInput.status === 'done' || pacedInput.status === 'error';

  const termWidth = props.terminalWidth ?? 80;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Logo theme={theme} done={isComplete} />
      <Hud input={pacedInput} theme={theme} frame={frame} width={termWidth} now={pacedNow} />
      <ActivityFeed input={pacedInput} theme={theme} frame={frame} width={termWidth} completionFrame={completionFrame} showCompletion={isComplete} holdComplete={holdComplete} />
      <TrustIssues view={view} theme={theme} />
      {userHasNavigated && <DetailsPane view={view} state={state} theme={theme} />}
    </Box>
  );
}

function renderTree(
  input: MemoryFlowReplayInput,
  io: KtxMemoryFlowTuiIo,
  onExit: () => void,
  options: RenderTreeOptions = {},
): ReactNode {
  return (
    <MemoryFlowTuiApp
      input={input}
      terminalWidth={io.stdout.columns ?? process.stdout.columns}
      onExit={onExit}
      paceEvents={options.paceEvents}
      paceMsPerEvent={options.paceMsPerEvent}
      frameMs={options.frameMs}
      completionFrameMs={options.completionFrameMs}
      completionHoldMs={options.completionHoldMs}
    />
  );
}

function renderInk(tree: ReactNode, options: MemoryFlowInkRenderOptions): MemoryFlowInkInstance {
  return renderInkRuntime(tree, {
    stdin: options.stdin as NodeJS.ReadStream | undefined,
    stdout: options.stdout as NodeJS.WriteStream,
    stderr: options.stderr as NodeJS.WriteStream,
    exitOnCtrlC: options.exitOnCtrlC,
    patchConsole: options.patchConsole,
    maxFps: options.maxFps,
    alternateScreen: options.alternateScreen,
  }) as MemoryFlowInkInstance;
}

function renderOptions(io: KtxMemoryFlowTuiIo): MemoryFlowInkRenderOptions {
  return {
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
    alternateScreen: true,
  };
}

function scaleTiming(ms: number, speedMultiplier: number): number {
  return Math.max(20, Math.round(ms / speedMultiplier));
}

function resolveTiming(options: RenderMemoryFlowTuiOptions): MemoryFlowTuiTiming {
  const speedMultiplier =
    typeof options.speedMultiplier === 'number' && options.speedMultiplier > 0 ? options.speedMultiplier : 1;
  return {
    paceMsPerEvent:
      typeof options.paceMsPerEvent === 'number' && options.paceMsPerEvent > 0
        ? options.paceMsPerEvent
        : scaleTiming(DEFAULT_TUI_TIMING.paceMsPerEvent, speedMultiplier),
    frameMs: DEFAULT_TUI_TIMING.frameMs,
    completionFrameMs: DEFAULT_TUI_TIMING.completionFrameMs,
    completionHoldMs: DEFAULT_TUI_TIMING.completionHoldMs,
  };
}

export async function renderMemoryFlowTui(
  input: MemoryFlowReplayInput,
  io: KtxMemoryFlowTuiIo,
  options: RenderMemoryFlowTuiOptions = {},
): Promise<boolean> {
  let instance: MemoryFlowInkInstance | null = null;
  const paceEvents = options.paceEvents !== false;
  const timing = resolveTiming(options);
  try {
    const onExit = (): void => {
      instance?.unmount();
    };
    instance = (options.renderInk ?? renderInk)(
      renderTree(input, io, onExit, { paceEvents, ...timing }),
      renderOptions(io),
    );
    await instance.waitUntilExit();
    instance.unmount();
    return true;
  } catch (error) {
    io.stderr.write(`TUI visualization unavailable: ${sanitizeMemoryFlowTuiError(error)}; using text renderer.\n`);
    return false;
  }
}

export async function startLiveMemoryFlowTui(
  input: MemoryFlowReplayInput,
  io: KtxMemoryFlowTuiIo,
  options: StartLiveMemoryFlowTuiOptions = {},
): Promise<MemoryFlowTuiLiveSession | null> {
  let instance: MemoryFlowInkInstance | null = null;
  let closed = false;

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    instance?.unmount();
  };

  try {
    instance = (options.renderInk ?? renderInk)(renderTree(input, io, close), renderOptions(io));

    return {
      update(nextInput: MemoryFlowReplayInput): void {
        if (closed) {
          return;
        }
        instance?.rerender(renderTree(nextInput, io, close));
      },
      close,
      isClosed(): boolean {
        return closed;
      },
    };
  } catch (error) {
    io.stderr.write(`TUI visualization unavailable: ${sanitizeMemoryFlowTuiError(error)}; using text renderer.\n`);
    return null;
  }
}
