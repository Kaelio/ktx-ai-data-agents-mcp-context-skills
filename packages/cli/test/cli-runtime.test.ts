import { describe, expect, it } from 'vitest';

import type { KtxCliIo } from '../src/cli-runtime.js';
import { writeGlobalExceptionToStderr } from '../src/cli-runtime.js';

function makeIo(stderrIsTty: boolean): { io: KtxCliIo; stderr: () => string } {
  let stderr = '';
  const stderrStream = stderrIsTty
    ? {
        isTTY: true,
        columns: 80,
        on: () => undefined,
        write: (chunk: string) => {
          stderr += chunk;
        },
      }
    : {
        write: (chunk: string) => {
          stderr += chunk;
        },
      };

  return {
    io: {
      stdout: {
        write: () => undefined,
      },
      stderr: stderrStream,
    },
    stderr: () => stderr,
  };
}

describe('writeGlobalExceptionToStderr', () => {
  it('prints the crash Slack hint after a stack on TTY stderr', () => {
    const testIo = makeIo(true);

    writeGlobalExceptionToStderr(testIo.io, new Error('global boom'));

    expect(testIo.stderr()).toContain('Error: global boom');
    expect(testIo.stderr()).toContain('This may be a bug');
    expect(testIo.stderr()).toContain('https://ktx.sh/slack');
  });

  it('prints crash details without the Slack hint on non-TTY stderr', () => {
    const testIo = makeIo(false);

    writeGlobalExceptionToStderr(testIo.io, 'global boom');

    expect(testIo.stderr()).toContain('global boom');
    expect(testIo.stderr()).not.toContain('https://ktx.sh/slack');
  });
});
