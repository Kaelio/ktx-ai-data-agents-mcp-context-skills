import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentTool } from './agent-tool.js';
import { ClaudeAgentSdkRunnerService } from './claude-agent-sdk-runner.service.js';

function asyncMessages(messages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
    close: vi.fn(),
  };
}

describe('ClaudeAgentSdkRunnerService', () => {
  it('runs with isolated settings, no built-ins, KTX MCP tools, and role model mapping', async () => {
    const query = vi.fn(() =>
      asyncMessages([
        { type: 'system', subtype: 'init', mcp_servers: [{ name: 'ktx', status: 'connected' }] },
        {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          result: 'done',
          is_error: false,
          permission_denials: [],
          errors: [],
        },
      ]),
    );
    const runner = new ClaudeAgentSdkRunnerService({
      projectDir: '/tmp/project',
      modelSlots: { default: 'claude-sonnet-4-6', reconcile: 'claude-opus-4-6' },
      query: query as never,
      createSdkMcpServer: vi.fn((input) => ({ type: 'sdk', name: input.name, instance: {} })) as never,
      tool: vi.fn((name, description, inputSchema, handler) => ({ name, description, inputSchema, handler })) as never,
    });

    const result = await runner.runLoop({
      modelRole: 'reconcile',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 7,
      telemetryTags: {},
      toolSet: {
        ping: createAgentTool({
          name: 'ping',
          description: 'Ping',
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => ({ markdown: `pong ${value}`, structured: { value } }),
        }),
      },
    });

    expect(result).toEqual({ stopReason: 'natural' });
    expect(query).toHaveBeenCalledWith({
      prompt: 'user',
      options: expect.objectContaining({
        cwd: '/tmp/project',
        systemPrompt: 'system',
        model: 'claude-opus-4-6',
        maxTurns: 7,
        tools: [],
        settingSources: [],
        skills: [],
        allowedTools: ['mcp__ktx__*'],
        permissionMode: 'dontAsk',
      }),
    });
  });

  it('maps max-turn terminal results to budget', async () => {
    const query = vi.fn(() =>
      asyncMessages([
        {
          type: 'result',
          subtype: 'error_max_turns',
          terminal_reason: 'max_turns',
          is_error: true,
          errors: [],
          permission_denials: [],
        },
      ]),
    );
    const runner = new ClaudeAgentSdkRunnerService({
      projectDir: '/tmp/project',
      modelSlots: {},
      query: query as never,
    });

    await expect(
      runner.runLoop({
        modelRole: 'default',
        systemPrompt: 'system',
        userPrompt: 'user',
        stepBudget: 1,
        telemetryTags: {},
        toolSet: {},
      }),
    ).resolves.toEqual({ stopReason: 'budget' });
  });

  it('denies non-KTX tool permission checks', async () => {
    const query = vi.fn(() =>
      asyncMessages([{ type: 'result', subtype: 'success', terminal_reason: 'completed', result: 'done' }]),
    );
    const runner = new ClaudeAgentSdkRunnerService({
      projectDir: '/tmp/project',
      modelSlots: {},
      query: query as never,
    });

    await runner.runLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 1,
      telemetryTags: {},
      toolSet: {},
    });

    const options = (query as any).mock.calls[0][0].options;
    await expect(options.canUseTool('Bash', {}, { signal: new AbortController().signal, toolUseID: '1' })).resolves.toEqual({
      behavior: 'deny',
      message: 'Only KTX MCP tools are available in this session.',
    });
  });
});
