import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeKtxLlmRuntime, mapClaudeCodeStopReason, runClaudeCodeAuthProbe } from '../../../src/context/llm/claude-code-runtime.js';

async function* stream(messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const message of messages) {
    yield message;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function initMessage(overrides: Partial<Extract<SDKMessage, { type: 'system'; subtype: 'init' }>> = {}): Extract<
  SDKMessage,
  { type: 'system'; subtype: 'init' }
> {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none' as never, // pragma: allowlist secret
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
    uuid: '00000000-0000-4000-8000-000000000001',
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
    uuid: '00000000-0000-4000-8000-000000000002',
    session_id: 'session-id',
    ...overrides,
  } as Extract<SDKMessage, { type: 'result' }>;
}

describe('ClaudeCodeKtxLlmRuntime', () => {
  it('passes isolation options and scrubbed env to text generation', async () => {
    const query = vi.fn((_input: any) => stream([initMessage(), resultMessage({ result: 'hello' })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', PATH: '/usr/bin' }, // pragma: allowlist secret
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
        managedSettings: {
          allowManagedMcpServersOnly: true,
          allowedMcpServers: [],
        },
        strictMcpConfig: true,
        allowedTools: [],
        permissionMode: 'dontAsk',
        persistSession: false,
        env: expect.not.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
      }),
    });
  });

  it('waits before Claude Code text generation and reports rate-limit events', async () => {
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const query = vi.fn((_input: any) =>
      stream([
        {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed_warning',
            resetsAt: new Date(2_000).toISOString(),
            rateLimitType: 'five_hour',
            utilization: 0.91,
          },
        } as unknown as SDKMessage,
        resultMessage({ result: 'ok' }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      rateLimitGovernor: { waitForReady, report, maxRetryAttempts: () => 6 } as never,
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'hello' })).resolves.toBe('ok');
    expect(waitForReady).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      provider: 'claude-subscription',
      status: 'warning',
      resetAtMs: 2_000,
      rateLimitType: 'five_hour',
      utilization: 0.91,
    });
  });

  it('maps numeric Claude Code reset times from SDK rate-limit events', async () => {
    const report = vi.fn();
    const resetAtMs = 1_700_000_000_000;
    const query = vi.fn((_input: any) =>
      stream([
        {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            resetsAt: resetAtMs,
            rateLimitType: 'five_hour',
            utilization: 1,
          },
        } as unknown as SDKMessage,
        resultMessage({ result: 'ok' }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      rateLimitGovernor: { waitForReady: vi.fn().mockResolvedValue(undefined), report, maxRetryAttempts: () => 6 } as never,
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'hello' })).resolves.toBe('ok');

    expect(report).toHaveBeenCalledWith({
      provider: 'claude-subscription',
      status: 'rejected',
      resetAtMs,
      rateLimitType: 'five_hour',
      utilization: 1,
    });
  });

  it('retries a Claude Code query after an SDK rate-limit result error', async () => {
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const resetAtMs = 1_700_000_000_000;
    const query = vi
      .fn()
      .mockReturnValueOnce(
        stream([
          {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'rejected',
              resetsAt: resetAtMs,
              rateLimitType: 'five_hour',
              utilization: 1,
            },
          } as unknown as SDKMessage,
          resultMessage({
            subtype: 'error_during_execution',
            is_error: true,
            result: '',
            errors: ['rate limit retry budget exhausted'],
            terminal_reason: 'model_error',
          } as never),
        ]),
      )
      .mockReturnValueOnce(stream([resultMessage({ result: 'ok' })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      rateLimitGovernor: { waitForReady, report, maxRetryAttempts: () => 6 } as never,
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'hello' })).resolves.toBe('ok');

    expect(query).toHaveBeenCalledTimes(2);
    expect(waitForReady).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith({
      provider: 'claude-subscription',
      status: 'rejected',
      resetAtMs,
      rateLimitType: 'five_hour',
      utilization: 1,
    });
  });

  it('reports Claude Code api retry messages as warning signals', async () => {
    const report = vi.fn();
    const query = vi.fn((_input: any) =>
      stream([
        {
          type: 'system',
          subtype: 'api_retry',
          retry_delay_ms: 12_000,
        } as unknown as SDKMessage,
        resultMessage({ result: 'ok' }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      rateLimitGovernor: { waitForReady: vi.fn().mockResolvedValue(undefined), report, maxRetryAttempts: () => 6 } as never,
    });

    await runtime.generateText({ role: 'default', prompt: 'hello' });
    expect(report).toHaveBeenCalledWith({
      provider: 'claude-subscription',
      status: 'warning',
      retryAfterMs: 12_000,
      rateLimitType: 'api_retry',
    });
  });

  it('passes abort signals into Claude Code governor waits', async () => {
    const controller = new AbortController();
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn((_input: any) => stream([resultMessage({ result: 'ok' })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      rateLimitGovernor: { waitForReady, report: vi.fn(), maxRetryAttempts: () => 6 } as never,
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'hello', abortSignal: controller.signal })).resolves.toBe('ok');

    expect(waitForReady).toHaveBeenCalledWith(controller.signal);
  });

  it('interrupts an active Claude Code query when the abort signal fires', async () => {
    const controller = new AbortController();
    const streamStarted = deferred<void>();
    const releaseStream = deferred<void>();
    const interrupt = vi.fn(() => releaseStream.resolve());
    const queryResult = {
      async *[Symbol.asyncIterator]() {
        streamStarted.resolve();
        await releaseStream.promise;
        yield resultMessage({ result: 'ok' });
      },
      interrupt,
    };
    const query = vi.fn(() => queryResult as never);
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      rateLimitGovernor: { waitForReady: vi.fn().mockResolvedValue(undefined), report: vi.fn(), maxRetryAttempts: () => 6 } as never,
    });

    const pending = runtime.generateText({ role: 'default', prompt: 'hello', abortSignal: controller.signal });
    await streamStarted.promise;
    controller.abort();

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('throws abort before starting Claude Code query when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const query = vi.fn((_input: any) => stream([resultMessage({ result: 'ok' })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      rateLimitGovernor: { waitForReady: vi.fn().mockResolvedValue(undefined), report: vi.fn(), maxRetryAttempts: () => 6 } as never,
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'hello', abortSignal: controller.signal })).rejects.toThrow(/Aborted/);
    expect(query).not.toHaveBeenCalled();
  });

  it('treats an interrupted Claude Code stream with no result as abort', async () => {
    const controller = new AbortController();
    const streamStarted = deferred<void>();
    const releaseStream = deferred<void>();
    const interrupt = vi.fn(() => releaseStream.resolve());
    const queryResult = {
      async *[Symbol.asyncIterator]() {
        streamStarted.resolve();
        await releaseStream.promise;
      },
      interrupt,
    };
    const query = vi.fn(() => queryResult as never);
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      rateLimitGovernor: { waitForReady: vi.fn().mockResolvedValue(undefined), report: vi.fn(), maxRetryAttempts: () => 6 } as never,
    });

    const pending = runtime.generateText({ role: 'default', prompt: 'hello', abortSignal: controller.signal });
    await streamStarted.promise;
    controller.abort();

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('validates structured output with the caller schema and whitelists the SDK StructuredOutput tool', async () => {
    const schema = z.object({ answer: z.string() });
    const query = vi.fn((_input: any) =>
      stream([
        initMessage({ tools: ['StructuredOutput'] }),
        resultMessage({ structured_output: { answer: 'yes' } }),
      ]),
    );
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
    const query = vi.fn((_input: any) =>
      stream([
        initMessage({ tools: ['mcp__ktx__load_skill'], mcp_servers: [{ name: 'ktx', status: 'connected' }] }),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: '00000000-0000-4000-8000-000000000003',
          session_id: 'session-id',
        } as unknown as SDKMessage,
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
    expect(options.managedSettings).toEqual({
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverName: 'ktx' }],
    });
    expect(options.strictMcpConfig).toBe(true);
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

  it('treats host-discovered commands skills and agents as non-fatal init metadata for text and auth probe', async () => {
    const hostDiscoveredInit = initMessage({
      slash_commands: ['/help', '/compact', '/clear', '/user-command'],
      skills: ['pdf', 'docx'],
      agents: ['claude', 'Explore', 'general-purpose'],
    });
    const textQuery = vi.fn((_input: any) => stream([hostDiscoveredInit, resultMessage({ result: 'hello' })]));
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query: textQuery,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', PATH: '/usr/bin' }, // pragma: allowlist secret
    });

    await expect(runtime.generateText({ role: 'default', prompt: 'say hello' })).resolves.toBe('hello');
    const textOptions = textQuery.mock.calls[0][0].options;
    expect(textOptions).toMatchObject({
      settingSources: [],
      skills: [],
      plugins: [],
      tools: [],
      managedSettings: {
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [],
      },
      strictMcpConfig: true,
      allowedTools: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      env: expect.not.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
    });
    expect(textOptions.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task', 'Bash']));
    expect(await textOptions.canUseTool('Agent', {}, { signal: new AbortController().signal, toolUseID: 'agent' })).toMatchObject({
      behavior: 'deny',
      toolUseID: 'agent',
    });
    expect(await textOptions.canUseTool('Skill', {}, { signal: new AbortController().signal, toolUseID: 'skill' })).toMatchObject({
      behavior: 'deny',
      toolUseID: 'skill',
    });
    expect(
      await textOptions.canUseTool('SlashCommand', {}, { signal: new AbortController().signal, toolUseID: 'slash' }),
    ).toMatchObject({
      behavior: 'deny',
      toolUseID: 'slash',
    });

    const probeQuery = vi.fn((_input: any) => stream([hostDiscoveredInit, resultMessage({ result: 'ok' })]));
    await expect(
      runClaudeCodeAuthProbe({
        projectDir: '/tmp/project',
        model: 'sonnet',
        query: probeQuery,
        env: { ANTHROPIC_AUTH_TOKEN: 'token', HOME: '/Users/test' },
      }),
    ).resolves.toEqual({ ok: true });
    expect(probeQuery.mock.calls[0][0].options).toMatchObject({
      settingSources: [],
      skills: [],
      plugins: [],
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      env: expect.objectContaining({ HOME: '/Users/test' }),
    });
    expect(probeQuery.mock.calls[0][0].options.env).not.toEqual(
      expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'token' }),
    );
  });

  it('allows host-discovered context during agent loops while requiring exact KTX MCP tools and servers', async () => {
    const query = vi.fn((_input: any) =>
      stream([
        initMessage({
          tools: ['mcp__ktx__load_skill'],
          mcp_servers: [{ name: 'ktx', status: 'connected' }],
          slash_commands: ['/help', '/compact', '/clear'],
          skills: ['memory-agent', 'doc-reader'],
          agents: ['claude', 'Plan', 'Explore'],
        }),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: '00000000-0000-4000-8000-000000000006',
          session_id: 'session-id',
        } as unknown as SDKMessage,
        resultMessage({ subtype: 'error_max_turns', is_error: true }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });

    await expect(
      runtime.runAgentLoop({
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
      }),
    ).resolves.toMatchObject({ stopReason: 'budget' });

    const options = query.mock.calls[0][0].options;
    expect(options.allowedTools).toEqual(['mcp__ktx__load_skill']);
    expect(options.managedSettings).toEqual({
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverName: 'ktx' }],
    });
    expect(options.strictMcpConfig).toBe(true);
    expect(await options.canUseTool('mcp__ktx__load_skill', {}, { signal: new AbortController().signal, toolUseID: '1' })).toEqual({
      behavior: 'allow',
      toolUseID: '1',
    });
    expect(await options.canUseTool('Task', {}, { signal: new AbortController().signal, toolUseID: '2' })).toMatchObject({
      behavior: 'deny',
      toolUseID: '2',
    });
    expect(await options.canUseTool('Skill', {}, { signal: new AbortController().signal, toolUseID: '3' })).toMatchObject({
      behavior: 'deny',
      toolUseID: '3',
    });
  });

  it('still rejects unexpected tools, missing KTX tools, plugins, and non-KTX MCP servers from init messages', async () => {
    const query = vi.fn((_input: any) =>
      stream([
        initMessage({
          tools: ['Bash'],
          mcp_servers: [{ name: 'filesystem', status: 'connected' }],
          plugins: [{ name: 'host-plugin', path: '/tmp/plugin' }],
        }),
        resultMessage({ result: 'hello' }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });

    await expect(
      runtime.generateText({
        role: 'default',
        prompt: 'say hello',
        tools: {
          load_skill: {
            name: 'load_skill',
            description: 'Load skill.',
            inputSchema: z.object({ name: z.string() }),
            execute: async () => ({ markdown: 'loaded' }),
          },
        },
      }),
    ).rejects.toThrow(
      /Claude Code runtime isolation failed: .*tools=Bash.*missing_tools=mcp__ktx__load_skill.*mcp_servers=filesystem.*plugins=host-plugin/,
    );
  });

  it('passes scrubbed env to object generation and agent loops', async () => {
    const schema = z.object({ answer: z.string() });
    const objectQuery = vi.fn((_input: any) =>
      stream([
        initMessage({ tools: ['StructuredOutput'] }),
        resultMessage({ structured_output: { answer: 'yes' } }),
      ]),
    );
    const objectRuntime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query: objectQuery,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test', AWS_PROFILE: 'prod', PATH: '/usr/bin' }, // pragma: allowlist secret
    });

    await expect(objectRuntime.generateObject({ role: 'default', prompt: 'json', schema })).resolves.toEqual({
      answer: 'yes',
    });
    expect(objectQuery.mock.calls[0][0].options.env).toEqual(expect.objectContaining({ PATH: '/usr/bin' }));
    expect(objectQuery.mock.calls[0][0].options.managedSettings).toEqual({
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [],
    });
    expect(objectQuery.mock.calls[0][0].options.env).not.toEqual(
      expect.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test', AWS_PROFILE: 'prod' }), // pragma: allowlist secret
    );

    const agentQuery = vi.fn((_input: any) =>
      stream([
        initMessage({ tools: ['mcp__ktx__load_skill'], mcp_servers: [{ name: 'ktx', status: 'connected' }] }),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: '00000000-0000-4000-8000-000000000004',
          session_id: 'session-id',
        } as unknown as SDKMessage,
        resultMessage({ subtype: 'error_max_turns', is_error: true }),
      ]),
    );
    const agentRuntime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query: agentQuery,
      env: { ANTHROPIC_AUTH_TOKEN: 'token', CLAUDE_CODE_USE_VERTEX: '1', HOME: '/Users/test' },
    });

    await agentRuntime.runAgentLoop({
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
    });
    expect(agentQuery.mock.calls[0][0].options.env).toEqual(expect.objectContaining({ HOME: '/Users/test' }));
    expect(agentQuery.mock.calls[0][0].options.managedSettings).toEqual({
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverName: 'ktx' }],
    });
    expect(agentQuery.mock.calls[0][0].options.env).not.toEqual(
      expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'token', CLAUDE_CODE_USE_VERTEX: '1' }),
    );
  });

  it('counts only assistant turns the SDK counts toward num_turns', async () => {
    const assistantMessage = (
      overrides: Partial<Extract<SDKMessage, { type: 'assistant' }>> & { uuid: string },
    ): SDKMessage =>
      ({
        type: 'assistant',
        message: { role: 'assistant', content: [], stop_reason: 'end_turn' },
        parent_tool_use_id: null,
        session_id: 'session-id',
        ...overrides,
      }) as unknown as SDKMessage;

    const query = vi.fn((_input: any) =>
      stream([
        initMessage(),
        assistantMessage({
          uuid: '00000000-0000-4000-8000-0000000000a1',
          error: 'max_output_tokens',
        }),
        assistantMessage({
          uuid: '00000000-0000-4000-8000-0000000000a2',
          message: { role: 'assistant', content: [], stop_reason: 'pause_turn' } as never,
        }),
        assistantMessage({ uuid: '00000000-0000-4000-8000-0000000000a3' }),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [], stop_reason: 'end_turn' },
          parent_tool_use_id: 'tool-use-1',
          uuid: '00000000-0000-4000-8000-0000000000a4',
          session_id: 'session-id',
        } as unknown as SDKMessage,
        resultMessage({ subtype: 'success', terminal_reason: 'completed' }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });
    const onStepFinish = vi.fn();

    await expect(
      runtime.runAgentLoop({
        modelRole: 'default',
        systemPrompt: 'system',
        userPrompt: 'user',
        toolSet: {},
        stepBudget: 40,
        telemetryTags: { operationName: 'test' },
        onStepFinish,
      }),
    ).resolves.toMatchObject({ stopReason: 'natural' });

    expect(onStepFinish).toHaveBeenCalledTimes(1);
    expect(onStepFinish).toHaveBeenCalledWith({ stepIndex: 1, stepBudget: 40 });
  });

  it('logs and ignores onStepFinish callback errors', async () => {
    const query = vi.fn((_input: any) =>
      stream([
        initMessage(),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: '00000000-0000-4000-8000-000000000005',
          session_id: 'session-id',
        } as unknown as SDKMessage,
        resultMessage({ subtype: 'success', terminal_reason: 'completed' }),
      ]),
    );
    const logger = {
      debug: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
      logger,
    });

    await expect(
      runtime.runAgentLoop({
        modelRole: 'default',
        systemPrompt: 'system',
        userPrompt: 'user',
        toolSet: {},
        stepBudget: 1,
        telemetryTags: { operationName: 'test' },
        onStepFinish: async () => {
          throw new Error('callback exploded');
        },
      }),
    ).resolves.toMatchObject({ stopReason: 'natural' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('callback exploded'));
  });

  it('maps max-turn terminal reasons to budget', () => {
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'error_max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ terminal_reason: 'max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ stop_reason: 'max_turns' }))).toBe('budget');
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'success', terminal_reason: 'completed' }))).toBe('natural');
    expect(mapClaudeCodeStopReason(resultMessage({ subtype: 'error_during_execution' }))).toBe('error');
  });

  it('returns loop metrics including step count and mapped token usage', async () => {
    const query = vi.fn((_input: any) =>
      stream([
        initMessage(),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
          uuid: '00000000-0000-4000-8000-000000000006',
          session_id: 'session-id',
        } as unknown as SDKMessage,
        resultMessage({
          subtype: 'success',
          terminal_reason: 'completed',
          usage: { input_tokens: 50, output_tokens: 10 } as never,
        }),
      ]),
    );
    const runtime = new ClaudeCodeKtxLlmRuntime({
      projectDir: '/tmp/project',
      modelSlots: { default: 'sonnet' },
      query,
      env: {},
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'default',
      systemPrompt: 'system',
      userPrompt: 'user',
      toolSet: {},
      stepBudget: 40,
      telemetryTags: { operationName: 'test' },
    });

    expect(result.metrics?.stepCount).toBe(1);
    expect(result.metrics?.stepBoundariesMs).toHaveLength(1);
    expect(result.metrics?.usage).toEqual({ inputTokens: 50, outputTokens: 10, totalTokens: 60 });
  });

  it('auth probe uses isolation options and a scrubbed env', async () => {
    const query = vi.fn((_input: any) => stream([initMessage(), resultMessage({ result: 'ok' })]));

    await expect(
      runClaudeCodeAuthProbe({ projectDir: '/tmp/project', model: 'sonnet', query, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } }), // pragma: allowlist secret
    ).resolves.toEqual({ ok: true });
    expect(query.mock.calls[0][0].options).toMatchObject({
      settingSources: [],
      skills: [],
      plugins: [],
      tools: [],
      managedSettings: {
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [],
      },
      strictMcpConfig: true,
      allowedTools: [],
      persistSession: false,
      env: expect.not.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
    });
  });

  it('reports unsupported Claude Code models without framing them as auth failures', async () => {
    await expect(
      runClaudeCodeAuthProbe({
        projectDir: '/tmp/project',
        model: 'gpt-5',
        query: vi.fn(),
        env: {},
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Unsupported Claude Code model "gpt-5". Use sonnet, opus, haiku, or a claude-* model id.',
    });
  });
});
