import { describe, expect, it, vi } from 'vitest';
import { createLocalKtxLlmProviderFromConfig, createLocalKtxLlmRuntimeFromConfig } from '../../../src/context/llm/local-config.js';

describe('local ktx LLM runtime config', () => {
  it('creates a Claude Code runtime for claude-code backend without creating an AI SDK provider', () => {
    const runtime = createLocalKtxLlmRuntimeFromConfig(
      {
        provider: { backend: 'claude-code' },
        models: { default: 'sonnet', triage: 'haiku' },
      },
      { env: {}, projectDir: '/tmp/project', createClaudeCodeRuntime: vi.fn((deps) => ({ deps }) as never) },
    );

    expect(runtime).toMatchObject({ deps: expect.objectContaining({ projectDir: '/tmp/project' }) });
  });

  it('returns null from the AI SDK provider factory for claude-code backend', () => {
    expect(
      createLocalKtxLlmProviderFromConfig({
        provider: { backend: 'claude-code' },
        models: { default: 'sonnet' },
      }),
    ).toBeNull();
  });

  it('creates a Codex runtime for codex backend without creating an AI SDK provider', () => {
    const runtime = createLocalKtxLlmRuntimeFromConfig(
      {
        provider: { backend: 'codex' },
        models: { default: 'codex', triage: 'gpt-5.4' },
      },
      { env: {}, projectDir: '/tmp/project', createCodexRuntime: vi.fn((deps) => ({ deps }) as never) },
    );

    expect(runtime).toMatchObject({ deps: expect.objectContaining({ projectDir: '/tmp/project' }) });
  });

  it('returns null from the AI SDK provider factory for codex backend', () => {
    expect(
      createLocalKtxLlmProviderFromConfig({
        provider: { backend: 'codex' },
        models: { default: 'codex' },
      }),
    ).toBeNull();
  });
});
