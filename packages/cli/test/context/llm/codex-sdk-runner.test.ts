import { describe, expect, it, vi } from 'vitest';

const sdkMock = vi.hoisted(() => {
  const events = (async function* () {
    yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } };
  })();
  const runStreamed = vi.fn(async () => ({ events }));
  const startThread = vi.fn(() => ({ runStreamed }));
  const Codex = vi.fn(function Codex(this: { startThread: typeof startThread }, options?: unknown) {
    Object.assign(this, { options, startThread });
  });
  return { Codex, startThread, runStreamed };
});

vi.mock('@openai/codex-sdk', () => ({ Codex: sdkMock.Codex }));

import { CodexSdkCliRunner } from '../../../src/context/llm/codex-sdk-runner.js';

async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of items) {
    collected.push(item);
  }
  return collected;
}

describe('CodexSdkCliRunner', () => {
  it('passes isolated env through the SDK and runtime controls through thread options', async () => {
    const runner = new CodexSdkCliRunner({
      envBase: {
        HOME: '/home/ktx-user',
        PATH: '/usr/local/bin:/usr/bin',
        CODEX_HOME: '/home/ktx-user/.codex',
        HTTPS_PROXY: 'http://proxy.example',
        KTX_UNRELATED_PRIVATE_VALUE: 'must-not-copy',
      },
    });
    const previousToken = process.env.KTX_CODEX_RUNTIME_MCP_TOKEN;
    process.env.KTX_CODEX_RUNTIME_MCP_TOKEN = 'outer-token';
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
          history: { persistence: 'none' },
        },
        env: { KTX_CODEX_RUNTIME_MCP_TOKEN: 'run-token' },
        outputSchema,
      });

      expect(sdkMock.Codex).toHaveBeenCalledWith({
        config: {
          history: { persistence: 'none' },
        },
        env: {
          HOME: '/home/ktx-user',
          PATH: '/usr/local/bin:/usr/bin',
          CODEX_HOME: '/home/ktx-user/.codex',
          HTTPS_PROXY: 'http://proxy.example',
          KTX_CODEX_RUNTIME_MCP_TOKEN: 'run-token',
        },
      });
      expect(process.env.KTX_CODEX_RUNTIME_MCP_TOKEN).toBe('outer-token');
      expect(sdkMock.startThread).toHaveBeenCalledWith({
        workingDirectory: '/tmp/ktx-project',
        skipGitRepoCheck: true,
        model: 'gpt-5.3-codex',
        sandboxMode: 'read-only',
        webSearchMode: 'disabled',
        approvalPolicy: 'never',
      });
      expect(sdkMock.runStreamed).toHaveBeenCalledWith('Return JSON.', { outputSchema });
      await expect(collectAsync(events)).resolves.toEqual([
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
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
