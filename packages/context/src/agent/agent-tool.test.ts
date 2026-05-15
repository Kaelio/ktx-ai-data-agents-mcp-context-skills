import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentTool, toAiSdkTool, toAiSdkToolSet } from './agent-tool.js';

describe('agent tools', () => {
  it('converts an agent tool to an AI SDK tool and preserves markdown output', async () => {
    const execute = vi.fn(async (input: { name: string }) => ({
      markdown: `hello ${input.name}`,
      structured: { ok: true },
    }));
    const agentTool = createAgentTool({
      name: 'greet',
      description: 'Greet someone',
      inputSchema: z.object({ name: z.string() }),
      execute,
    });

    const aiTool = toAiSdkTool(agentTool);
    const output = await aiTool.execute?.({ name: 'Ada' }, { toolCallId: 'call-1', messages: [] } as never);
    const modelOutput = aiTool.toModelOutput?.({ output } as never);

    expect(execute).toHaveBeenCalledWith({ name: 'Ada' }, { toolCallId: 'call-1' });
    expect(modelOutput).toEqual({ type: 'content', value: [{ type: 'text', text: 'hello Ada' }] });
  });

  it('converts a named map of agent tools to an AI SDK tool set', () => {
    const toolSet = toAiSdkToolSet({
      ping: createAgentTool({
        name: 'ping',
        description: 'Ping',
        inputSchema: z.object({}),
        execute: async () => 'pong',
      }),
    });

    expect(Object.keys(toolSet)).toEqual(['ping']);
    expect(toolSet.ping?.description).toBe('Ping');
  });
});
