import { emitKeypressEvents } from 'node:readline';
import {
  buildMemoryFlowViewModel,
  createInitialMemoryFlowInteractionState,
  reduceMemoryFlowInteractionState,
  renderMemoryFlowInteractive,
  type MemoryFlowInteractionCommand,
  type MemoryFlowInteractionState,
  type MemoryFlowReplayInput,
} from './context/ingest/index.js';

interface KtxMemoryFlowKey {
  name?: string;
  ctrl?: boolean;
}

export interface KtxMemoryFlowStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(value: boolean): void;
  resume?(): void;
  pause?(): void;
  on(event: 'keypress', listener: (chunk: string, key: KtxMemoryFlowKey) => void): this;
  off?(event: 'keypress', listener: (chunk: string, key: KtxMemoryFlowKey) => void): this;
  removeListener?(event: 'keypress', listener: (chunk: string, key: KtxMemoryFlowKey) => void): this;
}

interface KtxMemoryFlowInteractiveIo {
  stdin?: KtxMemoryFlowStdin;
  stdout: {
    isTTY?: boolean;
    columns?: number;
    write(chunk: string): void;
  };
}

interface RenderMemoryFlowInteractiveOptions {
  prepareKeypressEvents?(stdin: KtxMemoryFlowStdin): void;
}

function defaultPrepareKeypressEvents(stdin: KtxMemoryFlowStdin): void {
  emitKeypressEvents(stdin as Parameters<typeof emitKeypressEvents>[0]);
}

/** @internal */
export function memoryFlowCommandForKey(
  chunk: string,
  search: MemoryFlowInteractionState['search'],
  key: KtxMemoryFlowKey,
): MemoryFlowInteractionCommand | null {
  if (search.editing) {
    if (key.name === 'escape') return 'search-clear';
    if (key.name === 'return' || key.name === 'enter') return 'search-submit';
    if (key.name === 'backspace') return 'search-backspace';
    if (chunk.length === 1 && chunk >= ' ' && chunk !== '\u007f') {
      return { type: 'search-input', value: chunk };
    }
    return null;
  }

  if (key.ctrl === true && key.name === 'c') {
    return 'quit';
  }

  if (key.name === '/') return 'search-start';
  if (key.name === 'left') return 'left';
  if (key.name === 'right') return 'right';
  if (key.name === 'up') return 'up';
  if (key.name === 'down') return 'down';
  if (key.name === 'return' || key.name === 'enter') return 'enter';
  if (key.name === 'tab') return 'tab';
  if (key.name === 'f') return 'filter';
  if (key.name === 'p') return 'provenance';
  if (key.name === 't') return 'transcript';
  if (key.name === 'q' || key.name === 'escape') return 'quit';
  return null;
}

function removeKeypressListener(
  stdin: KtxMemoryFlowStdin,
  handler: (chunk: string, key: KtxMemoryFlowKey) => void,
): void {
  if (stdin.off) {
    stdin.off('keypress', handler);
    return;
  }
  stdin.removeListener?.('keypress', handler);
}

function repaint(input: MemoryFlowReplayInput, state: MemoryFlowInteractionState, io: KtxMemoryFlowInteractiveIo): void {
  const view = buildMemoryFlowViewModel(input);
  io.stdout.write('\u001b[2J\u001b[H');
  io.stdout.write(renderMemoryFlowInteractive(view, state, { terminalWidth: io.stdout.columns }));
}

export async function renderMemoryFlowInteractively(
  input: MemoryFlowReplayInput,
  io: KtxMemoryFlowInteractiveIo,
  options: RenderMemoryFlowInteractiveOptions = {},
): Promise<void> {
  const stdin = io.stdin;
  if (stdin?.isTTY !== true) {
    const view = buildMemoryFlowViewModel(input);
    io.stdout.write(
      renderMemoryFlowInteractive(view, createInitialMemoryFlowInteractionState(view), {
        terminalWidth: io.stdout.columns,
      }),
    );
    return;
  }

  const view = buildMemoryFlowViewModel(input);
  let state = createInitialMemoryFlowInteractionState(view);
  const previousRawMode = stdin.isRaw === true;

  return new Promise((resolve) => {
    const cleanup = (): void => {
      removeKeypressListener(stdin, handleKeypress);
      stdin.setRawMode?.(previousRawMode);
      stdin.pause?.();
    };

    const handleKeypress = (_chunk: string, key: KtxMemoryFlowKey): void => {
      const command = memoryFlowCommandForKey(_chunk, state.search, key);
      if (!command) {
        return;
      }

      state = reduceMemoryFlowInteractionState(state, command, view);
      repaint(input, state, io);

      if (state.shouldQuit) {
        cleanup();
        resolve();
      }
    };

    (options.prepareKeypressEvents ?? defaultPrepareKeypressEvents)(stdin);
    stdin.setRawMode?.(true);
    stdin.resume?.();
    stdin.on('keypress', handleKeypress);
    repaint(input, state, io);
  });
}
