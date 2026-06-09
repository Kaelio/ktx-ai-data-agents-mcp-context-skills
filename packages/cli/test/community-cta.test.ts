import { describe, expect, it } from 'vitest';

import {
  SLACK_HELP_FOOTER,
  SLACK_SETUP_NOTE,
  writeErrorCommunityHint,
} from '../src/community-cta.js';
import type { KtxCliIo } from '../src/cli-runtime.js';

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

describe('community CTA', () => {
  it('writes the error hint to TTY stderr', () => {
    const testIo = makeIo(true);

    writeErrorCommunityHint(testIo.io, 'error');

    expect(testIo.stderr()).toContain('Stuck? The ktx community can help');
    expect(testIo.stderr()).toContain('https://ktx.sh/slack');
  });

  it('suppresses the error hint for non-TTY stderr', () => {
    const testIo = makeIo(false);

    writeErrorCommunityHint(testIo.io, 'error');

    expect(testIo.stderr()).toBe('');
  });

  it('uses stronger crash copy for crash hints', () => {
    const testIo = makeIo(true);

    writeErrorCommunityHint(testIo.io, 'crash');

    expect(testIo.stderr()).toContain('This may be a bug');
    expect(testIo.stderr()).toContain('https://ktx.sh/slack');
  });

  it('exports setup and help copy with the stable Slack URL', () => {
    expect(SLACK_HELP_FOOTER).toBe('Community & support: https://ktx.sh/slack');
    expect(SLACK_SETUP_NOTE).toEqual({
      title: 'Community',
      body: 'Questions or feedback? Join the ktx Slack: https://ktx.sh/slack',
    });
  });
});
