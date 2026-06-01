import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CodexKtxLlmRuntime,
  runCodexAuthProbe,
} from '../../../src/context/llm/codex-runtime.js';

async function* events(items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

function runner(items: unknown[]) {
  return {
    runStreamed: vi.fn(async () => events(items)),
  };
}

function budgetRunner() {
  let observedSignal: AbortSignal | undefined;
  return {
    observedSignal: () => observedSignal,
    runStreamed: vi.fn(async (input: { signal?: AbortSignal }) => {
      observedSignal = input.signal;
      return events([
        { type: 'turn.started' },
        { type: 'item.started', item: { type: 'mcp_tool_call', server: 'ktx', tool: 'first', status: 'in_progress' } },
        { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'ktx', tool: 'first', status: 'completed' } },
        { type: 'item.started', item: { type: 'mcp_tool_call', server: 'ktx', tool: 'second', status: 'in_progress' } },
        { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'ktx', tool: 'second', status: 'completed' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
    }),
  };
}

describe('CodexKtxLlmRuntime', () => {
  it('generates text with the role-selected model and metrics', async () => {
    const onMetrics = vi.fn();
    const fakeRunner = runner([
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'hello' } },
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
    ]);
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex', triage: 'gpt-5.4' },
      runner: fakeRunner,
    });

    await expect(runtime.generateText({ role: 'triage', system: 'system', prompt: 'prompt', onMetrics })).resolves.toBe('hello');
    expect(fakeRunner.runStreamed).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: '/tmp/project',
        model: 'gpt-5.4',
        prompt: 'system\n\nprompt',
      }),
    );
    expect(onMetrics).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }));
  });

  it('generates and validates structured output', async () => {
    const fakeRunner = runner([
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"yes"}' } },
      { type: 'turn.completed' },
    ]);
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex' },
      runner: fakeRunner,
    });

    await expect(
      runtime.generateObject({
        role: 'default',
        prompt: 'json',
        schema: z.object({ answer: z.string() }),
      }),
    ).resolves.toEqual({ answer: 'yes' });
    expect(fakeRunner.runStreamed).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSchema: expect.objectContaining({ type: 'object' }),
      }),
    );
  });

  it('returns a structured-output error when Codex final text is invalid JSON', async () => {
    const fakeRunner = runner([
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'not json' } },
      { type: 'turn.completed' },
    ]);
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex' },
      runner: fakeRunner,
    });

    await expect(
      runtime.generateObject({
        role: 'default',
        prompt: 'json',
        schema: z.object({ answer: z.string() }),
      }),
    ).rejects.toThrow('Codex structured output failed validation');
  });

  it('starts and closes a temporary MCP server for tool-backed agent loops', async () => {
    const close = vi.fn(async () => undefined);
    const startMcpServer = vi.fn(async () => ({
      url: 'http://127.0.0.1:4321/mcp',
      bearerTokenEnvVar: 'KTX_CODEX_RUNTIME_MCP_TOKEN' as const,
      bearerToken: 'token',
      close,
    }));
    const fakeRunner = runner([
      { type: 'turn.started' },
      { type: 'item.started', item: { type: 'mcp_tool_call', name: 'wiki_search' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    ]);
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex' },
      runner: fakeRunner,
      startMcpServer,
    });
    const onStepFinish = vi.fn();

    const result = await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 5,
      telemetryTags: {},
      onStepFinish,
      toolSet: {
        aliased_wiki_tool: {
          name: 'wiki_search',
          description: 'Search wiki',
          inputSchema: z.object({ query: z.string() }),
          execute: vi.fn(),
        },
      },
    });

    expect(result.stopReason).toBe('natural');
    expect(result.metrics).toMatchObject({ stepCount: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    expect(onStepFinish).toHaveBeenCalledWith({ stepIndex: 1, stepBudget: 5 });
    expect(startMcpServer).toHaveBeenCalledWith({ projectDir: '/tmp/project', toolSet: expect.any(Object) });
    expect(fakeRunner.runStreamed).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { KTX_CODEX_RUNTIME_MCP_TOKEN: 'token' },
        configOverrides: expect.objectContaining({
          mcp_servers: expect.objectContaining({
            ktx: expect.objectContaining({
              url: 'http://127.0.0.1:4321/mcp',
              enabled_tools: ['wiki_search'],
              required: true,
            }),
          }),
        }),
      }),
    );
    expect(close).toHaveBeenCalled();
  });

  it('returns error stop reason on turn failure', async () => {
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex' },
      runner: runner([{ type: 'turn.failed', error: { message: 'boom' } }]),
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 5,
      telemetryTags: {},
      toolSet: {},
    });

    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toBe('boom');
  });

  it('surfaces failed MCP tool calls as agent-loop errors', async () => {
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex' },
      runner: runner([
        { type: 'turn.started' },
        { type: 'item.started', item: { type: 'mcp_tool_call', server: 'ktx', tool: 'search', status: 'in_progress' } },
        {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'ktx',
            tool: 'search',
            status: 'failed',
            error: { message: 'denied' },
          },
        },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]),
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 5,
      telemetryTags: {},
      toolSet: {},
    });

    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toBe('Codex runtime tool call failed: search: denied');
    expect(result.metrics).toMatchObject({
      stepCount: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  });

  it('returns budget and aborts the Codex stream when local MCP step budget is reached', async () => {
    const fakeRunner = budgetRunner();
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex' },
      runner: fakeRunner,
    });
    const onStepFinish = vi.fn();

    const result = await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 1,
      telemetryTags: {},
      onStepFinish,
      toolSet: {
        first: {
          name: 'first',
          description: 'First tool',
          inputSchema: z.object({}),
          execute: vi.fn(),
        },
      },
    });

    expect(result.stopReason).toBe('budget');
    expect(result.error).toBeUndefined();
    expect(result.metrics).toMatchObject({ stepCount: 1 });
    expect(onStepFinish).toHaveBeenCalledTimes(1);
    expect(onStepFinish).toHaveBeenCalledWith({ stepIndex: 1, stepBudget: 1 });
    expect(fakeRunner.observedSignal()?.aborted).toBe(true);
  });

  it('counts built-in command_execution steps against the budget and aborts the stream', async () => {
    let observedSignal: AbortSignal | undefined;
    const fakeRunner = {
      observedSignal: () => observedSignal,
      runStreamed: vi.fn(async (input: { signal?: AbortSignal }) => {
        observedSignal = input.signal;
        return events([
          { type: 'turn.started' },
          { type: 'item.started', item: { type: 'command_execution', command: 'ls', status: 'in_progress' } },
          { type: 'item.completed', item: { type: 'command_execution', command: 'ls', status: 'completed', exit_code: 0 } },
          { type: 'item.started', item: { type: 'command_execution', command: 'cat a', status: 'in_progress' } },
          { type: 'item.completed', item: { type: 'command_execution', command: 'cat a', status: 'completed', exit_code: 0 } },
          { type: 'item.completed', item: { type: 'command_execution', command: 'cat b', status: 'completed', exit_code: 0 } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
      }),
    };
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex' },
      runner: fakeRunner,
    });
    const onStepFinish = vi.fn();

    const result = await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 2,
      telemetryTags: {},
      onStepFinish,
      toolSet: {},
    });

    expect(result.stopReason).toBe('budget');
    expect(result.error).toBeUndefined();
    expect(result.metrics).toMatchObject({ stepCount: 2 });
    expect(onStepFinish).toHaveBeenCalledTimes(2);
    expect(onStepFinish).toHaveBeenLastCalledWith({ stepIndex: 2, stepBudget: 2 });
    expect(fakeRunner.observedSignal()?.aborted).toBe(true);
  });

  it('fires onStepFinish live as each step completes, before the stream drains', async () => {
    const order: string[] = [];
    async function* liveEvents() {
      yield { type: 'turn.started' };
      yield { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'ktx', tool: 'a', status: 'completed' } };
      order.push('yielded-after-step-1');
      yield { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'ktx', tool: 'b', status: 'completed' } };
      order.push('yielded-after-step-2');
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'done' } };
      yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    const fakeRunner = { runStreamed: vi.fn(async () => liveEvents()) };
    const runtime = new CodexKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'codex' },
      runner: fakeRunner,
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      stepBudget: 10,
      telemetryTags: {},
      onStepFinish: ({ stepIndex }) => {
        order.push(`step-${stepIndex}`);
      },
      toolSet: {},
    });

    expect(result.stopReason).toBe('natural');
    expect(result.metrics).toMatchObject({ stepCount: 2 });
    expect(order).toEqual(['step-1', 'yielded-after-step-1', 'step-2', 'yielded-after-step-2']);
  });

  it('probes Codex authentication through a minimal non-interactive turn', async () => {
    const fakeRunner = runner([
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed' },
    ]);

    await expect(
      runCodexAuthProbe({
        projectDir: '/tmp/project',
        model: 'codex',
        runner: fakeRunner,
      }),
    ).resolves.toEqual({ ok: true });
  });
});
