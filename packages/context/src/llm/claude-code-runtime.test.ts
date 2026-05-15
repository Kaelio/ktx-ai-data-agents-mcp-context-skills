import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeKtxLlmRuntime, mapClaudeCodeStopReason, runClaudeCodeAuthProbe } from './claude-code-runtime.js';

async function* stream(messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const message of messages) {
    yield message;
  }
}

function initMessage(overrides: Partial<Extract<SDKMessage, { type: 'system'; subtype: 'init' }>> = {}): Extract<
  SDKMessage,
  { type: 'system'; subtype: 'init' }
> {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '0.3.142',
    cwd: '/tmp/project',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-6',
    permissionMode: 'dontAsk',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'init-id',
    session_id: 'session-id',
    ...overrides,
  };
}

function resultMessage(overrides: Partial<Extract<SDKMessage, { type: 'result' }>> = {}): Extract<
  SDKMessage,
  { type: 'result' }
> {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: null,
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: 'result-id',
    session_id: 'session-id',
    ...overrides,
  } as Extract<SDKMessage, { type: 'result' }>;
}

describe('ClaudeCodeKtxLlmRuntime', () => {
  it('passes isolation options and scrubbed env to text generation', async () => {
    const query = vi.fn(() => stream([initMessage(), resultMessage({ result: 'hello' })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', PATH: '/usr/bin' },
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'say hello' })).resolves.toBe('hello');
    expect(query).toHaveBeenCalledWith({
      prompt: 'say hello',
      options: expect.objectContaining({
        cwd: '/tmp/project',
        model: 'claude-sonnet-4-6',
        maxTurns: 1,
        settingSources: [],
        skills: [],
        plugins: [],
        tools: [],
        allowedTools: [],
        permissionMode: 'dontAsk',
        persistSession: false,
        env: expect.not.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
      }),
    });
  });

  it('validates structured output with the caller schema', async () => {
    const schema = z.object({ answer: z.string() });
    const query = vi.fn(() => stream([initMessage(), resultMessage({ structured_output: { answer: 'yes' } })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });

    await expect(runtime.generateObject({ role: 'default', prompt: 'json', schema })).resolves.toEqual({ answer: 'yes' });
    expect(query.mock.calls[0][0].options.outputFormat).toMatchObject({
      type: 'json_schema',
      schema: expect.objectContaining({ type: 'object' }),
    });
  });

  it('registers only exact KTX MCP tool ids and denies non-KTX tools', async () => {
    const query = vi.fn(() =>
      stream([
        initMessage({ tools: ['mcp__ktx__load_skill'], mcp_servers: [{ name: 'ktx', status: 'connected' }] }),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: 'assistant-1',
          session_id: 'session-id',
        } as SDKMessage,
        resultMessage({ subtype: 'error_max_turns', is_error: true }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });
    const onStepFinish = vi.fn();

    await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      toolSet: {
        load_skill: {
          name: 'load_skill',
          description: 'Load skill.',
          inputSchema: z.object({ name: z.string() }),
          execute: async () => ({ markdown: 'loaded' }),
        },
      },
      stepBudget: 1,
      telemetryTags: { operationName: 'test' },
      onStepFinish,
    });

    const options = query.mock.calls[0][0].options;
    expect(options.allowedTools).toEqual(['mcp__ktx__load_skill']);
    expect(await options.canUseTool('mcp__ktx__load_skill', {}, { signal: new AbortController().signal, toolUseID: '1' })).toEqual({
      behavior: 'allow',
      toolUseID: '1',
    });
    expect(await options.canUseTool('Bash', {}, { signal: new AbortController().signal, toolUseID: '2' })).toMatchObject({
      behavior: 'deny',
      toolUseID: '2',
    });
    expect(onStepFinish).toHaveBeenCalledWith({ stepIndex: 1, stepBudget: 1 });
  });

  it('maps max-turn terminal reasons to budget', () => {
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'error_max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ terminal_reason: 'max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ stop_reason: 'max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'success', terminal_reason: 'completed' }))).toBe('natural');
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'error_during_execution' }))).toBe('error');
  });

  it('auth probe uses isolation options and a scrubbed env', async () => {
    const query = vi.fn(() => stream([initMessage(), resultMessage({ result: 'ok' })]));

    await expect(
      runClaudeCodeAuthProbe({ projectDir: '/tmp/project', model: 'sonnet', query, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } }),
    ).resolves.toEqual({ ok: true });
    expect(query.mock.calls[0][0].options).toMatchObject({
      settingSources: [],
      skills: [],
      plugins: [],
      tools: [],
      allowedTools: [],
      persistSession: false,
      env: expect.not.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
    });
  });
});
