import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { KtxMessageBuilder } from './message-builder.js';
import { createKtxLlmProvider } from './model-provider.js';

function makeBuilder(overrides: Parameters<typeof createKtxLlmProvider>[0]['promptCaching'] = {}) {
  const provider = createKtxLlmProvider({
    backend: 'gateway',
    gateway: { baseURL: 'https://gateway.test' },
    modelSlots: { default: 'anthropic/claude-sonnet-4-6' },
    promptCaching: { enabled: true, ...overrides },
  });
  return new KtxMessageBuilder(provider);
}

describe('KtxMessageBuilder.build', () => {
  it('caches static system, last sorted tool, and last history message', () => {
    const builder = makeBuilder();

    const out = builder.build({
      parts: { staticSystem: 'STATIC', dynamicSystem: 'DYNAMIC' },
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'text', text: 'reply A' }, { type: 'text', text: 'reply B' }] } as ModelMessage,
      ],
      currentMessage: { role: 'user', content: 'now' },
      tools: {
        zoo: { description: 'z' },
        apple: { description: 'a' },
      },
      model: 'anthropic/claude-sonnet-4-6',
    });

    expect(out.messages[0]).toMatchObject({
      role: 'system',
      content: 'STATIC',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    });
    expect(out.messages[1]).toMatchObject({ role: 'system', content: 'DYNAMIC' });
    expect((out.messages[1] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect((out.messages[3] as { content: Array<{ providerOptions?: unknown }> }).content[1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } },
    });
    expect(Object.keys(out.tools)).toEqual(['apple', 'zoo']);
    expect((out.tools.zoo as { providerOptions?: unknown }).providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });
  });

  it('wraps leading user context onto currentMessage as a system reminder part', () => {
    const builder = makeBuilder();

    const out = builder.build({
      parts: { staticSystem: 'STATIC', leadingUserContext: 'current_date: 2026-05-04' },
      history: [],
      currentMessage: { role: 'user', content: 'question' },
      tools: {},
      model: 'anthropic/claude-sonnet-4-6',
    });

    expect(out.messages[out.messages.length - 1]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\ncurrent_date: 2026-05-04\n</system-reminder>' },
        { type: 'text', text: 'question' },
      ],
    });
  });

  it('omits cache markers for non-Anthropic protocol models', () => {
    const builder = makeBuilder();

    const out = builder.wrapSimple({
      system: 'SYS',
      messages: [{ role: 'user', content: 'q' }],
      tools: { z: {} },
      model: 'gpt-5',
    });

    expect((out.messages[0] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect((out.tools.z as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('wrapSimple does not mark a single user message with a cache breakpoint', () => {
    const builder = makeBuilder();

    const out = builder.wrapSimple({
      system: 'SYS',
      messages: [{ role: 'user', content: 'one-shot prompt' }],
      tools: {},
      model: 'anthropic/claude-sonnet-4-6',
    });

    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toMatchObject({
      role: 'system',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    });
    expect(out.messages[1]).toMatchObject({ role: 'user', content: 'one-shot prompt' });
    expect((out.messages[1] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('wrapSimple still marks the last history message when there are multiple messages', () => {
    const builder = makeBuilder();

    const out = builder.wrapSimple({
      system: 'SYS',
      messages: [
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'turn 2' },
      ],
      tools: {},
      model: 'anthropic/claude-sonnet-4-6',
    });

    expect(out.messages).toHaveLength(4);
    expect(out.messages[1]).toMatchObject({ role: 'user' });
    expect((out.messages[1] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect(out.messages[2]).toMatchObject({ role: 'assistant' });
    expect((out.messages[2] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    const last = out.messages[3] as { content: Array<{ providerOptions?: unknown }> };
    expect(last.content[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } },
    });
  });

  it('clamps every TTL to 5m for Vertex when vertexFallbackTo5m is enabled', () => {
    const provider = createKtxLlmProvider({
      backend: 'vertex',
      vertex: { project: 'ktx-test', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: {
        enabled: true,
        systemTtl: '1h',
        toolsTtl: '1h',
        historyTtl: '1h',
        vertexFallbackTo5m: true,
      },
    });
    const builder = new KtxMessageBuilder(provider);

    const out = builder.build({
      parts: { staticSystem: 'STATIC' },
      history: [{ role: 'user', content: 'history' }],
      currentMessage: { role: 'user', content: 'now' },
      tools: { z: {} },
      model: 'claude-sonnet-4-6',
    });

    expect((out.messages[0] as { providerOptions: any }).providerOptions.anthropic.cacheControl.ttl).toBe('5m');
    expect((out.messages[1] as { content: Array<{ providerOptions: any }> }).content[0].providerOptions.anthropic.cacheControl.ttl).toBe(
      '5m',
    );
    expect((out.tools.z as { providerOptions: any }).providerOptions.anthropic.cacheControl.ttl).toBe('5m');
  });
});
