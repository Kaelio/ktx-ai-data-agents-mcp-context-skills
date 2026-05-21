import { profileMark } from './startup-profile.js';

profileMark('module:viz-fallback');

type KtxVizFallbackReason =
  | 'stdout-not-tty'
  | 'term-dumb'
  | 'stdin-not-tty'
  | 'stdin-raw-mode-unavailable'
  | 'renderer-unavailable';

interface KtxVizFallbackIo {
  stdin?: { isTTY?: boolean; setRawMode?(value: boolean): void };
  stdout: { isTTY?: boolean };
  stderr: { write(chunk: string): void };
}

interface KtxVizFallbackOptions {
  requireInput?: boolean;
}

type KtxVizFallbackDecision =
  | {
      shouldDegrade: false;
    }
  | {
      shouldDegrade: true;
      reason: KtxVizFallbackReason;
      message: string;
    };

const warnedFallbackReasons = new Set<KtxVizFallbackReason>();

export function resolveVizFallback(
  io: KtxVizFallbackIo,
  env: NodeJS.ProcessEnv = process.env,
  options: KtxVizFallbackOptions = {},
): KtxVizFallbackDecision {
  if (io.stdout.isTTY !== true) {
    return {
      shouldDegrade: true,
      reason: 'stdout-not-tty',
      message: 'stdout is not an interactive terminal',
    };
  }

  if ((env.TERM ?? '').toLowerCase() === 'dumb') {
    return {
      shouldDegrade: true,
      reason: 'term-dumb',
      message: 'TERM=dumb does not support the visual renderer',
    };
  }

  if (options.requireInput === true && io.stdin?.isTTY !== true) {
    return {
      shouldDegrade: true,
      reason: 'stdin-not-tty',
      message: 'stdin is not an interactive terminal',
    };
  }

  if (options.requireInput === true && typeof io.stdin?.setRawMode !== 'function') {
    return {
      shouldDegrade: true,
      reason: 'stdin-raw-mode-unavailable',
      message: 'stdin raw mode is unavailable',
    };
  }

  return { shouldDegrade: false };
}

export function rendererUnavailableVizFallback(): KtxVizFallbackDecision {
  return {
    shouldDegrade: true,
    reason: 'renderer-unavailable',
    message: 'the terminal renderer is unavailable',
  };
}

export function warnVizFallbackOnce(io: KtxVizFallbackIo, decision: KtxVizFallbackDecision): void {
  if (!decision.shouldDegrade || warnedFallbackReasons.has(decision.reason)) {
    return;
  }

  warnedFallbackReasons.add(decision.reason);
  io.stderr.write(`Visualization requested but ${decision.message}; printing plain output.\n`);
}

/** @internal */
export function resetVizFallbackWarningsForTest(): void {
  warnedFallbackReasons.clear();
}
