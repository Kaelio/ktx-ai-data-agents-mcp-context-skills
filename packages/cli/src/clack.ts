import { cancel, confirm, isCancel, log, spinner } from '@clack/prompts';
import type { KtxCliIo } from './cli-runtime.js';

const ESC = String.fromCharCode(0x1b);

export interface CliStyleEnv {
  NO_COLOR?: string;
  TERM?: string;
}

function ansiEnabled(env: CliStyleEnv = process.env): boolean {
  return !env.NO_COLOR && env.TERM !== 'dumb';
}

function ansiColor(text: string, open: number, close: number, env?: CliStyleEnv): string {
  if (!ansiEnabled(env)) {
    return text;
  }
  return `${ESC}[${open}m${text}${ESC}[${close}m`;
}

export function dim(text: string, env?: CliStyleEnv): string {
  return ansiColor(text, 2, 22, env);
}

export function cyan(text: string, env?: CliStyleEnv): string {
  return ansiColor(text, 36, 39, env);
}

export interface RailBufferedSource {
  stdoutText(): string;
  stderrText(): string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function writePrefixedLines(write: (chunk: string) => void, output: string): void {
  for (const line of output.split(/\r?\n/)) {
    if (line.length > 0) {
      write(`│  ${line}\n`);
    }
  }
}

export function flushPrefixedBufferedCommandOutput(io: KtxCliIo, buffered: RailBufferedSource): void {
  writePrefixedLines((chunk) => io.stdout.write(chunk), buffered.stdoutText());
  writePrefixedLines((chunk) => io.stderr.write(chunk), buffered.stderrText());
}

export interface KtxCliSpinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export interface KtxCliSpinnerIo {
  stderr: { write(chunk: string): void };
}

export interface KtxCliPromptAdapter {
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  cancel(message: string): void;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    success(message: string): void;
    step(message: string): void;
  };
  spinner(): KtxCliSpinner;
}

class KtxCliPromptCancelledError extends Error {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'KtxCliPromptCancelledError';
  }
}

export function createClackSpinner(): KtxCliSpinner {
  // clack colors the animated spinner frame magenta by default; styleFrame
  // (typed in SpinnerOptions, absent from the README) recolors it ktx orange.
  return spinner({ styleFrame: orange });
}

// ktx mascot orange (#FF8A4C) via 24-bit truecolor.
function orange(text: string): string {
  if (!ansiEnabled()) {
    return text;
  }
  return `${ESC}[38;2;255;138;76m${text}${ESC}[39m`;
}

function red(text: string): string {
  return ansiColor(text, 31, 39);
}

/**
 * Stderr-only, non-animated spinner. Use this instead of {@link createCliSpinner}
 * when the next step reads stdin in raw mode (an Ink TUI or a keypress wait):
 * the animated clack spinner seizes stdin via `@clack/core`'s `block()` and
 * leaves it dirty, which the following raw-mode reader misreads as a stray key.
 */
export function createStaticCliSpinner(io: KtxCliSpinnerIo): KtxCliSpinner {
  return {
    start(message) {
      io.stderr.write(`${orange('◐')}  ${message}\n`);
    },
    message(message) {
      io.stderr.write(`${orange('│')}  ${message}\n`);
    },
    stop(message) {
      io.stderr.write(`${orange('◇')}  ${message}\n`);
    },
    error(message) {
      io.stderr.write(`${red('■')}  ${message}\n`);
    },
  };
}

/**
 * Animated spinner in an interactive terminal, static `◐/◇/■` lines otherwise
 * (scripts, CI, piped output) so logs stay clean and uncluttered by frames.
 */
export function createCliSpinner(io: KtxCliIo): KtxCliSpinner {
  return io.stdout.isTTY === true ? createClackSpinner() : createStaticCliSpinner(io);
}

export async function runWithCliSpinner<T>(
  spinner: KtxCliSpinner,
  text: { start: string; success: string; failure: string },
  run: () => Promise<T>,
): Promise<T> {
  spinner.start(text.start);
  try {
    const value = await run();
    spinner.stop(text.success);
    return value;
  } catch (error) {
    spinner.error(text.failure);
    throw error;
  }
}

export function createClackPromptAdapter(): KtxCliPromptAdapter {
  return {
    async confirm(options) {
      const value = await confirm(options);
      if (isCancel(value)) {
        cancel('Operation cancelled.');
        throw new KtxCliPromptCancelledError();
      }
      return value;
    },
    cancel(message) {
      cancel(message);
    },
    log: {
      info(message) {
        log.info(message);
      },
      warn(message) {
        log.warn(message);
      },
      error(message) {
        log.error(message);
      },
      success(message) {
        log.success(message);
      },
      step(message) {
        log.step(message);
      },
    },
    spinner() {
      return createClackSpinner();
    },
  };
}
