import { cancel, confirm, isCancel, log, spinner } from '@clack/prompts';
import type { KtxCliIo } from './cli-runtime.js';

const ESC = String.fromCharCode(0x1b);

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
  return spinner();
}

function magenta(text: string): string {
  return `${ESC}[35m${text}${ESC}[39m`;
}

function red(text: string): string {
  return `${ESC}[31m${text}${ESC}[39m`;
}

export function createStaticCliSpinner(io: KtxCliSpinnerIo): KtxCliSpinner {
  return {
    start(message) {
      io.stderr.write(`${magenta('◐')}  ${message}\n`);
    },
    message(message) {
      io.stderr.write(`${magenta('│')}  ${message}\n`);
    },
    stop(message) {
      io.stderr.write(`${magenta('◇')}  ${message}\n`);
    },
    error(message) {
      io.stderr.write(`${red('■')}  ${message}\n`);
    },
  };
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
