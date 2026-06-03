import type { KtxCliIo } from '../cli-runtime.js';

export interface BufferedCommandIo extends KtxCliIo {
  stdoutText(): string;
  stderrText(): string;
}

/**
 * Captures stdout/stderr from a command (e.g. `runKtxConnection`) into buffers
 * instead of the terminal. Callers decide whether to flush the captured text to
 * the user or discard it.
 */
export function createBufferedCommandIo(): BufferedCommandIo {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      isTTY: false,
      write(chunk: string) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
      },
    },
    stdoutText() {
      return stdout;
    },
    stderrText() {
      return stderr;
    },
  };
}
