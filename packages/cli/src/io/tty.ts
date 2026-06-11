import type { Writable } from 'node:stream';

import type { KtxCliIo } from '../cli-runtime.js';

type KtxCliOutput = (KtxCliIo['stdout'] | KtxCliIo['stderr']) & {
  isTTY?: boolean;
  columns?: number;
  on?: unknown;
};

export function isWritableTtyOutput(output: KtxCliOutput): output is KtxCliOutput & Writable {
  return (
    (output as { isTTY?: unknown }).isTTY === true &&
    typeof (output as { on?: unknown }).on === 'function' &&
    typeof (output as { columns?: unknown }).columns !== 'undefined'
  );
}

export function shouldUseColorOutput(output: { isTTY?: boolean }): boolean {
  if (output.isTTY !== true) return false;
  const env = process.env;
  return !env.NO_COLOR && env.TERM !== 'dumb' && !env.CI;
}

/**
 * Color depth in bits for the given output: 1 when color is disabled, the
 * stream-reported depth when available, and a 16-color baseline otherwise.
 */
export function colorDepthForOutput(output: KtxCliOutput): number {
  if (!shouldUseColorOutput(output)) return 1;
  const getColorDepth = (output as { getColorDepth?: () => number }).getColorDepth;
  return typeof getColorDepth === 'function' ? getColorDepth.call(output) : 4;
}
