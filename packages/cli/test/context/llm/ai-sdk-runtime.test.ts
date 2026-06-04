import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  stepCountIs: (n: number) => n,
  tool: (def: unknown) => def,
}));

import { generateText } from 'ai';
import { AiSdkKtxLlmRuntime } from '../../../src/context/llm/ai-sdk-runtime.js';
import type { RunLoopStepInfo } from '../../../src/context/llm/runtime-port.js';

describe('AiSdkKtxLlmRuntime.runAgentLoop', () => {
  let runtime: AiSdkKtxLlmRuntime;
  const llmProvider = {
    getModel: vi.fn().mockReturnValue({ modelId: 'claude-sonnet-4-6', provider: 'anthropic' }),
    getModelByName: vi.fn(),
    cacheMarker: vi.fn(),
    repairToolCallHandler: vi.fn(),
    thinkingProviderOptions: vi.fn(),
    telemetryConfig: vi.fn(),
    promptCachingConfig: vi.fn(() => ({
      enabled: false,
      systemTtl: '1h',
      toolsTtl: '1h',
      historyTtl: '5m',
      cacheSystem: true,
      cacheTools: true,
      cacheHistory: true,
      vertexFallbackTo5m: false,
    })),
    activeBackend: vi.fn(() => 'anthropic'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new AiSdkKtxLlmRuntime({ llmProvider: llmProvider as any });
  });

  afterEach(() => vi.clearAllMocks());

  it('passes systemPrompt, userPrompt, tools, and step budget through to generateText', async () => {
    (generateText as any).mockResolvedValue({ text: 'ok', toolCalls: [], steps: [] });
    const repairHandler = vi.fn();
    llmProvider.repairToolCallHandler.mockReturnValueOnce(repairHandler);
    const tools = { noop: { description: 'noop', inputSchema: {}, execute: vi.fn() } };
    await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: 'SYS',
      userPrompt: 'USR',
      toolSet: tools as any,
      stepBudget: 17,
      telemetryTags: { source: 'test' },
    });
    const call = (generateText as any).mock.calls[0][0];
    expect(call.system).toEqual({ role: 'system', content: 'SYS' });
    expect(call.messages).toEqual([{ role: 'user', content: 'USR' }]);
    expect(call.prompt).toBeUndefined();
    expect(call.tools.noop).toEqual(
      expect.objectContaining({
        description: 'noop',
        inputSchema: {},
        execute: expect.any(Function),
        toModelOutput: expect.any(Function),
      }),
    );
    expect(call.stopWhen).toBe(17);
    expect(call.temperature).toBe(0);
    expect(call.experimental_repairToolCall).toBe(repairHandler);
    expect(llmProvider.getModel).toHaveBeenCalledWith('candidateExtraction');
    expect(llmProvider.repairToolCallHandler).toHaveBeenCalledWith({ source: 'ktx-agent-runner' });
  });

  it('returns stopReason=natural when the loop completes without error', async () => {
    (generateText as any).mockResolvedValue({ text: 'done', toolCalls: [], steps: [] });
    const result = await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: 'system',
      userPrompt: 'user',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
    });
    expect(result.stopReason).toBe('natural');
    expect(result.error).toBeUndefined();
    expect(llmProvider.getModel).toHaveBeenCalledWith('candidateExtraction');
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: { role: 'system', content: 'system' },
        messages: [{ role: 'user', content: 'user' }],
      }),
    );
  });

  it('returns stopReason=error with the error on generateText failure', async () => {
    const err = new Error('LLM unavailable');
    (generateText as any).mockRejectedValue(err);
    const result = await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
    });
    expect(result.stopReason).toBe('error');
    expect(result.error).toBe(err);
  });

  it('reports AI SDK retry-after rate limits and retries through the governor', async () => {
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const rateLimitError = Object.assign(new Error('too many requests'), {
      name: 'TooManyRequestsError',
      retryAfter: 2,
      statusCode: 429,
    });
    (generateText as any).mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({
      text: 'done',
      toolCalls: [],
      steps: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const runtime = new AiSdkKtxLlmRuntime({
      llmProvider: llmProvider as any,
      rateLimitGovernor: { waitForReady, report } as never,
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
    });

    expect(result.stopReason).toBe('natural');
    expect(report).toHaveBeenCalledWith({
      provider: 'anthropic-api',
      status: 'rejected',
      retryAfterMs: 2_000,
      rateLimitType: 'http_429',
    });
    expect(waitForReady).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('passes abort signals into governor waits and AI SDK generateText calls', async () => {
    const controller = new AbortController();
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    (generateText as any).mockResolvedValue({ text: 'done', toolCalls: [], steps: [] });
    const runtime = new AiSdkKtxLlmRuntime({
      llmProvider: llmProvider as any,
      rateLimitGovernor: { waitForReady, report: vi.fn() } as never,
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
      abortSignal: controller.signal,
    });

    expect(result.stopReason).toBe('natural');
    expect(waitForReady).toHaveBeenCalledWith(controller.signal);
    expect((generateText as any).mock.calls[0][0].abortSignal).toBe(controller.signal);
  });

  it('returns metrics with stepCount, per-step boundaries, and aggregate token usage', async () => {
    (generateText as any).mockImplementation(async (opts: any) => {
      await opts.onStepFinish({});
      await opts.onStepFinish({});
      return {
        text: 'ok',
        toolCalls: [],
        steps: [],
        totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      };
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
    });

    expect(result.metrics).toBeDefined();
    expect(result.metrics?.stepCount).toBe(2);
    expect(result.metrics?.stepBoundariesMs).toHaveLength(2);
    expect(result.metrics?.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics?.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  });

  it('falls back to result.usage when totalUsage is absent', async () => {
    (generateText as any).mockResolvedValue({
      text: 'ok',
      toolCalls: [],
      steps: [],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
    });

    expect(result.metrics?.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect(result.metrics?.stepCount).toBe(0);
  });

  it('returns partial metrics even when the loop errors', async () => {
    (generateText as any).mockRejectedValue(new Error('boom'));

    const result = await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
    });

    expect(result.stopReason).toBe('error');
    expect(result.metrics).toBeDefined();
    expect(result.metrics?.stepCount).toBe(0);
    expect(result.metrics?.usage).toEqual({});
  });

  it('invokes caller onStepFinish with incrementing stepIndex and total budget', async () => {
    const calls: RunLoopStepInfo[] = [];
    (generateText as any).mockImplementation(async (opts: any) => {
      for (let i = 0; i < 3; i++) {
        await opts.onStepFinish({});
      }
      return { text: 'ok', toolCalls: [], steps: [] };
    });

    await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
      onStepFinish: (info) => {
        calls.push(info);
      },
    });

    expect(calls).toEqual([
      { stepIndex: 1, stepBudget: 10 },
      { stepIndex: 2, stepBudget: 10 },
      { stepIndex: 3, stepBudget: 10 },
    ]);
  });

  it('swallows errors thrown from caller onStepFinish without aborting the loop', async () => {
    (generateText as any).mockImplementation(async (opts: any) => {
      await opts.onStepFinish({});
      return { text: 'ok', toolCalls: [], steps: [] };
    });

    const result = await runtime.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: {},
      onStepFinish: () => {
        throw new Error('boom');
      },
    });

    expect(result.stopReason).toBe('natural');
  });

  it('forwards telemetryTags.source through experimental_telemetry metadata', async () => {
    (generateText as any).mockResolvedValue({ text: 'ok', toolCalls: [], steps: [] });
    const telemetryConfigEnabled = {
      isEnabled: () => true,
      devtoolsEnabled: false,
      appSettingsService: {
        settings: { telemetry: { recordInputs: false, recordOutputs: false } },
      },
      systemConfigService: {
        config: { instance: { name: 'test-instance' } },
      },
    } as any;
    const runtimeWithTelemetry = new AiSdkKtxLlmRuntime({
      llmProvider: llmProvider as any,
      telemetry: {
        createTelemetry: (tags) => ({
          isEnabled: telemetryConfigEnabled.isEnabled(),
          metadata: {
            source: tags.source ?? 'RESEARCH',
            jobId: tags.jobId,
            unitKey: tags.unitKey,
          },
        }),
      },
    });
    await runtimeWithTelemetry.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: { source: 'metabase', jobId: 'job-123', unitKey: 'u/1' },
    });
    const call = (generateText as any).mock.calls[0][0];
    expect(call.experimental_telemetry.metadata.source).toBe('metabase');
  });

  it('defaults to source=RESEARCH when telemetryTags omits source', async () => {
    (generateText as any).mockResolvedValue({ text: 'ok', toolCalls: [], steps: [] });
    const telemetryConfigEnabled = {
      isEnabled: () => true,
      devtoolsEnabled: false,
      appSettingsService: {
        settings: { telemetry: { recordInputs: false, recordOutputs: false } },
      },
      systemConfigService: {
        config: { instance: { name: 'test-instance' } },
      },
    } as any;
    const runtimeWithTelemetry = new AiSdkKtxLlmRuntime({
      llmProvider: llmProvider as any,
      telemetry: {
        createTelemetry: (tags) => ({
          isEnabled: telemetryConfigEnabled.isEnabled(),
          metadata: {
            source: tags.source ?? 'RESEARCH',
            jobId: tags.jobId,
            unitKey: tags.unitKey,
          },
        }),
      },
    });
    await runtimeWithTelemetry.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: { operationName: 'memory-agent-ingest' },
    });
    const call = (generateText as any).mock.calls[0][0];
    expect(call.experimental_telemetry.metadata.source).toBe('RESEARCH');
  });

  it('forwards jobId and unitKey through experimental_telemetry metadata', async () => {
    (generateText as any).mockResolvedValue({ text: 'ok', toolCalls: [], steps: [] });
    const telemetryConfigEnabled = {
      isEnabled: () => true,
      devtoolsEnabled: false,
      appSettingsService: {
        settings: { telemetry: { recordInputs: false, recordOutputs: false } },
      },
      systemConfigService: {
        config: { instance: { name: 'test-instance' } },
      },
    } as any;
    const runtimeWithTelemetry = new AiSdkKtxLlmRuntime({
      llmProvider: llmProvider as any,
      telemetry: {
        createTelemetry: (tags) => ({
          isEnabled: telemetryConfigEnabled.isEnabled(),
          metadata: {
            source: tags.source ?? 'RESEARCH',
            jobId: tags.jobId,
            unitKey: tags.unitKey,
          },
        }),
      },
    });
    await runtimeWithTelemetry.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: '',
      userPrompt: '',
      toolSet: {},
      stepBudget: 10,
      telemetryTags: { source: 'metabase', jobId: 'job-777', unitKey: 'sources/users' },
    });
    const call = (generateText as any).mock.calls[0][0];
    expect(call.experimental_telemetry.metadata.jobId).toBe('job-777');
    expect(call.experimental_telemetry.metadata.unitKey).toBe('sources/users');
  });

  it('records a sanitized LLM debug request when a recorder is injected', async () => {
    (generateText as any).mockResolvedValue({ text: 'ok', toolCalls: [], steps: [] });
    const record = vi.fn();
    const provider = {
      ...llmProvider,
      cacheMarker: vi.fn((ttl: '5m' | '1h') => ({
        anthropic: { cacheControl: { type: 'ephemeral' as const, ttl } },
      })),
      promptCachingConfig: vi.fn(() => ({
        enabled: true,
        systemTtl: '1h',
        toolsTtl: '1h',
        historyTtl: '5m',
        cacheSystem: true,
        cacheTools: true,
        cacheHistory: true,
        vertexFallbackTo5m: false,
      })),
    };
    const runtimeWithDebug = new AiSdkKtxLlmRuntime({
      llmProvider: provider as any,
      debugRequestRecorder: { record },
    });

    await runtimeWithDebug.runAgentLoop({
      modelRole: 'candidateExtraction',
      systemPrompt: 'SECRET SYSTEM PROMPT',
      userPrompt: 'SECRET USER PROMPT',
      toolSet: {
        emit_candidate: {
          description: 'SECRET TOOL DESCRIPTION',
          inputSchema: {},
          execute: vi.fn(),
        } as any,
      },
      stepBudget: 10,
      telemetryTags: { operationName: 'ingest-bundle-wu', source: 'metabase', jobId: 'job-1', unitKey: 'cards/1' },
    });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: 'ingest-bundle-wu',
        source: 'metabase',
        jobId: 'job-1',
        unitKey: 'cards/1',
        modelRole: 'candidateExtraction',
        modelId: 'claude-sonnet-4-6',
        messageCount: 2,
        toolNames: ['emit_candidate'],
      }),
    );
    const providerOptions = record.mock.calls[0][0].providerOptions;
    expect(providerOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'message', index: 0, role: 'system' }),
        expect.objectContaining({ target: 'message-part', index: 1, role: 'user', partIndex: 0 }),
        expect.objectContaining({ target: 'tool', name: 'emit_candidate' }),
      ]),
    );
    expect(providerOptions).toHaveLength(3);
    const serialized = JSON.stringify(record.mock.calls[0][0]);
    expect(serialized).not.toContain('SECRET SYSTEM PROMPT');
    expect(serialized).not.toContain('SECRET USER PROMPT');
    expect(serialized).not.toContain('SECRET TOOL DESCRIPTION');
  });
});
