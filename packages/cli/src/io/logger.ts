import type { KtxCliIo } from '../cli-runtime.js';
import type { KtxOutputMode } from './mode.js';

export interface KtxOperationalLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export type KtxOperationalOutputMode = KtxOutputMode | 'viz';

function writeLine(io: KtxCliIo, message: string): void {
  io.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

export function createNoopOperationalLogger(): KtxOperationalLogger {
  return {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

export function createCliOperationalLogger(
  io: KtxCliIo,
  mode: KtxOperationalOutputMode,
): KtxOperationalLogger {
  if (mode === 'json') {
    return createNoopOperationalLogger();
  }

  return {
    log: (message) => writeLine(io, message),
    warn: (message) => writeLine(io, message),
    error: (message) => writeLine(io, message),
    debug: (message) => writeLine(io, message),
  };
}
