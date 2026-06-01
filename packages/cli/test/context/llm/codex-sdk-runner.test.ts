import { describe, expect, it, vi } from 'vitest';

const sdkMock = vi.hoisted(() => {
  const events = (async function* () {
    yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } };
  })();
  const observedEnv: Array<string | undefined> = [];
  const runStreamed = vi.fn(async () => ({ events }));
  const startThread = vi.fn(() => ({ runStreamed }));
  const Codex = vi.fn(function Codex(this: { startThread: typeof startThread }, options?: unknown) {
    observedEnv.push(process.env.KTX_CODEX_RUNTIME_MCP_TOKEN);
    Object.assign(this, { options, startThread });
  });
  return { Codex, startThread, runStreamed, observedEnv };
});

vi.mock('@openai/codex-sdk', () => ({ Codex: sdkMock.Codex }));

import { CodexSdkCliRunner } from '../../../src/context/llm/codex-sdk-runner.js';

describe('CodexSdkCliRunner', () => {
  it('constructs Codex with per-run config and streams thread events', async () => {
    const runner = new CodexSdkCliRunner();
    const previousToken = process.env.KTX_CODEX_RUNTIME_MCP_TOKEN;
    delete process.env.KTX_CODEX_RUNTIME_MCP_TOKEN;
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };

    try {
      const events = await runner.runStreamed({
        projectDir: '/tmp/ktx-project',
        model: 'gpt-5.3-codex',
        prompt: 'Return JSON.',
        configOverrides: {
          approval_policy: 'never',
          sandbox_mode: 'read-only',
        },
        env: { KTX_CODEX_RUNTIME_MCP_TOKEN: 'token' },
        outputSchema,
      });

      expect(sdkMock.Codex).toHaveBeenCalledWith({
        config: {
          approval_policy: 'never',
          sandbox_mode: 'read-only',
          model: 'gpt-5.3-codex',
        },
      });
      expect(sdkMock.observedEnv).toEqual(['token']);
      expect(process.env.KTX_CODEX_RUNTIME_MCP_TOKEN).toBeUndefined();
      expect(sdkMock.startThread).toHaveBeenCalledWith({
        workingDirectory: '/tmp/ktx-project',
        skipGitRepoCheck: true,
      });
      expect(sdkMock.runStreamed).toHaveBeenCalledWith('Return JSON.', { outputSchema });
      await expect(Array.fromAsync(events)).resolves.toEqual([
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      ]);
    } finally {
      if (previousToken === undefined) {
        delete process.env.KTX_CODEX_RUNTIME_MCP_TOKEN;
      } else {
        process.env.KTX_CODEX_RUNTIME_MCP_TOKEN = previousToken;
      }
    }
  });
});
