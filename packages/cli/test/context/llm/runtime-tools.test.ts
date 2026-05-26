import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAiSdkToolSet, createClaudeSdkTools, normalizeKtxRuntimeToolOutput } from '../../../src/context/llm/runtime-tools.js';
import type { KtxRuntimeToolDescriptor } from '../../../src/context/llm/runtime-port.js';

describe('runtime tool descriptors', () => {
  const descriptor: KtxRuntimeToolDescriptor<{ id: string }, { ok: boolean }> = {
    name: 'read_thing',
    description: 'Read one thing.',
    inputSchema: z.object({ id: z.string() }),
    execute: vi.fn(async (input) => ({
      markdown: `Read ${input.id}`,
      structured: { ok: true },
    })),
  };

  it('normalizes string and object tool outputs into markdown plus optional structured payload', () => {
    expect(normalizeKtxRuntimeToolOutput('plain text')).toEqual({ markdown: 'plain text' });
    expect(normalizeKtxRuntimeToolOutput({ markdown: 'shown', structured: { id: 1 } })).toEqual({
      markdown: 'shown',
      structured: { id: 1 },
    });
    expect(normalizeKtxRuntimeToolOutput({ name: 'skill', content: 'body' })).toEqual({
      markdown: '```json\n{\n  "name": "skill",\n  "content": "body"\n}\n```',
      structured: { name: 'skill', content: 'body' },
    });
  });

  it('builds AI SDK tools that expose markdown to the model', async () => {
    const tools = createAiSdkToolSet({ read_thing: descriptor });
    const output = await tools.read_thing.execute?.({ id: 'a' }, { toolCallId: 'call-1', messages: [] } as never);
    const modelOutput = tools.read_thing.toModelOutput?.({ output } as never);

    expect(modelOutput).toEqual({ type: 'text', value: 'Read a' });
  });

  it('builds Claude SDK tools that return text content only', async () => {
    const tools = createClaudeSdkTools({ read_thing: descriptor });
    const result = await tools[0].handler({ id: 'b' } as never, {});

    expect(result).toEqual({ content: [{ type: 'text', text: 'Read b' }] });
  });
});
