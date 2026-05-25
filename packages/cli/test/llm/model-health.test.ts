import { wrapLanguageModel as defaultWrapLanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { runKtxLlmHealthCheck } from '../../src/llm/model-health.js';

const anthropicModel = { modelId: 'claude-sonnet-4-6' } as never;

describe('KTX LLM health check', () => {
  it('runs a minimal non-streaming model call through the configured provider', async () => {
    const generateText = vi.fn(async () => ({ text: 'ok' }));
    const createAnthropic = vi.fn(() => vi.fn(() => anthropicModel));
    const wrapLanguageModel = vi.fn(defaultWrapLanguageModel);

    await expect(
      runKtxLlmHealthCheck(
        {
          backend: 'anthropic',
          anthropic: { apiKey: 'sk-ant-test' }, // pragma: allowlist secret
          modelSlots: { default: 'claude-sonnet-4-6' },
        },
        { deps: { createAnthropic, generateText, devtoolsEnabled: true, wrapLanguageModel } },
      ),
    ).resolves.toEqual({ ok: true });

    expect(createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-ant-test', // pragma: allowlist secret
      }),
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: anthropicModel,
        prompt: 'Reply with exactly: ok',
        temperature: 0,
        maxOutputTokens: 8,
      }),
    );
    expect(wrapLanguageModel).not.toHaveBeenCalled();
  });

  it('returns a failed result without exposing secret values', async () => {
    const generateText = vi.fn(async () => {
      throw new Error('401 invalid x-api-key sk-ant-secret');
    });

    await expect(
      runKtxLlmHealthCheck(
        {
          backend: 'anthropic',
          anthropic: { apiKey: 'sk-ant-secret' }, // pragma: allowlist secret
          modelSlots: { default: 'claude-sonnet-4-6' },
        },
        {
          deps: {
            createAnthropic: vi.fn(() => vi.fn(() => anthropicModel)),
            generateText,
          },
        },
      ),
    ).resolves.toEqual({
      ok: false,
      message: '401 invalid x-api-key [redacted]',
    });
  });

  it('reports claude-code as unsupported by the AI SDK health check', async () => {
    const result = await runKtxLlmHealthCheck({
      backend: 'claude-code',
      modelSlots: { default: 'sonnet' },
      promptCaching: { enabled: false },
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('claude-code is not an AI SDK LanguageModel backend'),
    });
  });
});
