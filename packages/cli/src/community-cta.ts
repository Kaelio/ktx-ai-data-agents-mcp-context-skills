import type { KtxCliIo } from './cli-runtime.js';
import { isWritableTtyOutput } from './io/tty.js';
import { dim } from './io/symbols.js';
import { SLACK_URL } from './links.js';

type ErrorCtaVariant = 'error' | 'crash';

/** @internal */
export const SLACK_HELP_FOOTER = `Community & support: ${SLACK_URL}`;

/** @internal */
export const SLACK_SETUP_NOTE = {
  title: 'Community',
  body: `Questions or feedback? Join the ktx Slack: ${SLACK_URL}`,
} as const;

export function writeErrorCommunityHint(io: KtxCliIo, variant: ErrorCtaVariant): void {
  if (!isWritableTtyOutput(io.stderr)) {
    return;
  }

  const line =
    variant === 'crash'
      ? `This may be a bug - report it or ask in the ktx community: ${SLACK_URL}`
      : `Stuck? The ktx community can help: ${SLACK_URL}`;

  io.stderr.write(`${dim(line)}\n`);
}
