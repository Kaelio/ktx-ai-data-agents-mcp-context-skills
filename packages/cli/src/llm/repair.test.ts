import { NoSuchToolError, type LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createKtxToolCallRepairHandler } from './repair.js';

const repairModel = { modelId: 'claude-repair', provider: 'anthropic' } as LanguageModel;

describe('createKtxToolCallRepairHandler', () => {
  it('returns null for NoSuchToolError', async () => {
    const handler = createKtxToolCallRepairHandler({
      source: 'unit',
      getRepairModel: () => repairModel,
      generateText: vi.fn(),
    });

    await expect(
      handler({
        system: undefined,
        messages: [],
        toolCall: { type: 'tool-call', toolName: 'missing', toolCallId: 'tc_1', input: '{}' },
        tools: {},
        inputSchema: async () => ({}),
        error: new NoSuchToolError({ toolName: 'missing' }),
      }),
    ).resolves.toBeNull();
  });

  it('repairs string input by local JSON extraction without an LLM call', async () => {
    const generateText = vi.fn();
    const handler = createKtxToolCallRepairHandler({
      source: 'unit',
      getRepairModel: () => repairModel,
      generateText,
    });

    await expect(
      handler({
        system: undefined,
        messages: [],
        toolCall: {
          type: 'tool-call',
          toolName: 'write_source',
          toolCallId: 'tc_2',
          input: 'prefix {"path":"orders.yaml"} suffix',
        },
        tools: { write_source: {} as never },
        inputSchema: async () => ({ type: 'object' }),
        error: new Error('Invalid tool input') as never,
      }),
    ).resolves.toEqual({
      type: 'tool-call',
      toolName: 'write_source',
      toolCallId: 'tc_2',
      input: '{"path":"orders.yaml"}',
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('falls back to the repair model when local extraction fails', async () => {
    const generateText = vi.fn().mockResolvedValue({ text: '{"path":"customers.yaml"}' });
    const handler = createKtxToolCallRepairHandler({
      source: 'unit',
      getRepairModel: () => repairModel,
      generateText,
    });

    await expect(
      handler({
        system: undefined,
        messages: [],
        toolCall: {
          type: 'tool-call',
          toolName: 'write_source',
          toolCallId: 'tc_3',
          input: 'not json',
        },
        tools: { write_source: {} as never },
        inputSchema: async () => ({ type: 'object', properties: { path: { type: 'string' } } }),
        error: new Error('Invalid tool input') as never,
      }),
    ).resolves.toEqual({
      type: 'tool-call',
      toolName: 'write_source',
      toolCallId: 'tc_3',
      input: '{"path":"customers.yaml"}',
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: repairModel,
        prompt: expect.stringContaining('The model tried to call the tool "write_source"'),
      }),
    );
  });
});
