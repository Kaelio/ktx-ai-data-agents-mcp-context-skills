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
