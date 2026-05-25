import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_PROVIDER_ENV_DENYLIST, createKtxClaudeCodeEnv } from '../../../src/context/llm/claude-code-env.js';

describe('createKtxClaudeCodeEnv', () => {
  it('strips provider-routing credentials from the Claude Code child environment', () => {
    const seeded = Object.fromEntries(CLAUDE_CODE_PROVIDER_ENV_DENYLIST.map((key) => [key, `${key}-value`]));
    const env = createKtxClaudeCodeEnv({
      ...seeded,
      PATH: '/usr/bin',
      HOME: '/Users/test',
    });

    for (const key of CLAUDE_CODE_PROVIDER_ENV_DENYLIST) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/test');
  });
});
