import { KtxMessageBuilder, splitKtxSystemMessages } from '../../llm/message-builder.js';
import type { KtxLlmProvider } from '../../llm/types.js';
import { generateText, Output, stepCountIs, type FlexibleSchema, type TelemetrySettings, type ToolSet } from 'ai';
import type { z } from 'zod';
import { noopLogger, type KtxLogger } from '../../context/core/config.js';
import { summarizeKtxLlmDebugRequest, type KtxLlmDebugRequestRecorder } from './debug-request-recorder.js';
import type { RateLimitGovernor, RateLimitProvider } from './rate-limit-governor.js';
import { createAiSdkToolSet } from './runtime-tools.js';
import type {
  KtxGenerateObjectInput,
  KtxGenerateTextInput,
  KtxLlmRuntimePort,
  LlmTokenUsage,
  RunLoopParams,
  RunLoopResult,
} from './runtime-port.js';

interface AgentTelemetryPort {
  createTelemetry(tags: Record<string, string>): TelemetrySettings;
}

interface MaybeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function toLlmTokenUsage(usage: MaybeUsage | undefined): LlmTokenUsage {
  if (!usage) {
    return {};
  }
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  };
}

export interface AiSdkKtxLlmRuntimeDeps {
  llmProvider: KtxLlmProvider;
  telemetry?: AgentTelemetryPort;
  logger?: KtxLogger;
  debugRequestRecorder?: KtxLlmDebugRequestRecorder;
  rateLimitGovernor?: Pick<RateLimitGovernor, 'waitForReady' | 'report'>;
}

function hasTools(tools: Record<string, unknown>): boolean {
  return Object.keys(tools).length > 0;
}

function modelProviderName(model: unknown): RateLimitProvider {
  const provider = (model as { provider?: string }).provider ?? '';
  return provider.includes('vertex') || provider.includes('google') ? 'vertex' : 'anthropic-api';
}

function retryAfterMs(error: unknown): number | undefined {
  const value = (error as { retryAfter?: unknown }).retryAfter;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000 ? value * 1_000 : value;
  }
  return undefined;
}

function isAiSdkRateLimitError(error: unknown): boolean {
  const record = error as { name?: string; statusCode?: number; status?: number };
  return record.name === 'TooManyRequestsError' || record.statusCode === 429 || record.status === 429;
}

export class AiSdkKtxLlmRuntime implements KtxLlmRuntimePort {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: AiSdkKtxLlmRuntimeDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  private async generateTextWithRateLimitRetry<T>(provider: RateLimitProvider, run: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      await this.deps.rateLimitGovernor?.waitForReady();
      try {
        return await run();
      } catch (error) {
        if (!isAiSdkRateLimitError(error) || attempt >= 5) {
          throw error;
        }
        attempt += 1;
        const retryAfter = retryAfterMs(error);
        this.deps.rateLimitGovernor?.report({
          provider,
          status: 'rejected',
          rateLimitType: 'http_429',
          ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
        });
      }
    }
  }

  async generateText(input: KtxGenerateTextInput): Promise<string> {
    const model = this.deps.llmProvider.getModel(input.role);
    if ((model as { provider?: string }).provider === 'deterministic') {
      return `Deterministic description for ${input.prompt.slice(0, 64).trim() || 'data source'}`;
    }
    const tools = createAiSdkToolSet(input.tools ?? {});
    const built = new KtxMessageBuilder(this.deps.llmProvider).wrapSimple({
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
      tools,
      model,
    });
    const split = splitKtxSystemMessages(built.messages);
    const startedAt = Date.now();
    const request = {
      model,
      temperature: input.temperature ?? 0,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages,
      tools: built.tools as ToolSet,
      ...(hasTools(tools)
        ? {
            experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
              source: `ktx-${input.role}`,
            }),
          }
        : {}),
    };
    const result = await this.generateTextWithRateLimitRetry(modelProviderName(model), () => generateText(request));
    input.onMetrics?.({ totalMs: Date.now() - startedAt, usage: toLlmTokenUsage(result.totalUsage ?? result.usage) });
    if (typeof result.text !== 'string') {
      throw new Error('KTX LLM text generation returned no text');
    }
    return result.text;
  }

  async generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput> {
    const model = this.deps.llmProvider.getModel(input.role);
    const tools = createAiSdkToolSet(input.tools ?? {});
    const built = new KtxMessageBuilder(this.deps.llmProvider).wrapSimple({
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
      tools,
      model,
    });
    const split = splitKtxSystemMessages(built.messages);
    const startedAt = Date.now();
    const request = {
      model,
      temperature: input.temperature ?? 0,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages,
      tools: built.tools as ToolSet,
      ...(hasTools(tools)
        ? {
            experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
              source: `ktx-${input.role}`,
            }),
          }
        : {}),
      output: Output.object({ schema: input.schema as unknown as FlexibleSchema<TOutput> }),
    };
    const result = await this.generateTextWithRateLimitRetry(modelProviderName(model), () => generateText(request));
    input.onMetrics?.({ totalMs: Date.now() - startedAt, usage: toLlmTokenUsage(result.totalUsage ?? result.usage) });
    if (result.output == null) {
      throw new Error('KTX LLM object generation returned no output');
    }
    return result.output as TOutput;
  }

  async runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
    let stepIndex = 0;
    const startedAt = Date.now();
    const stepBoundariesMs: number[] = [];
    try {
      const model = this.deps.llmProvider.getModel(params.modelRole);
      const tools = createAiSdkToolSet(params.toolSet);
      const builder = new KtxMessageBuilder(this.deps.llmProvider);
      const built = builder.wrapSimple({
        system: params.systemPrompt,
        messages: [{ role: 'user', content: params.userPrompt }],
        tools,
        model,
      });
      const promptMessages = splitKtxSystemMessages(built.messages);

      await this.deps.debugRequestRecorder?.record(
        summarizeKtxLlmDebugRequest({
          operationName: params.telemetryTags.operationName ?? 'ktx-agent-runner',
          source: params.telemetryTags.source,
          jobId: params.telemetryTags.jobId,
          unitKey: params.telemetryTags.unitKey,
          modelRole: params.modelRole,
          modelId: (model as { modelId?: string }).modelId ?? params.modelRole,
          messages: built.messages,
          tools: built.tools as Record<string, { providerOptions?: unknown }>,
        }),
      );

      const request = {
        model,
        temperature: 0,
        stopWhen: stepCountIs(params.stepBudget),
        experimental_telemetry: this.deps.telemetry?.createTelemetry(params.telemetryTags) ?? this.deps.llmProvider.telemetryConfig(),
        experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
          source: params.telemetryTags.operationName ?? 'ktx-agent-runner',
        }),
        ...(promptMessages.system ? { system: promptMessages.system } : {}),
        messages: promptMessages.messages,
        tools: built.tools as ToolSet,
        onStepFinish: async () => {
          stepIndex += 1;
          stepBoundariesMs.push(Date.now() - startedAt);
          if (!params.onStepFinish) {
            return;
          }
          try {
            await params.onStepFinish({ stepIndex, stepBudget: params.stepBudget });
          } catch (err) {
            this.logger.warn(
              `[agent-runner] onStepFinish callback threw; ignoring: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        },
      };
      const result = await this.generateTextWithRateLimitRetry(modelProviderName(model), () => generateText(request));
      return {
        stopReason: 'natural',
        metrics: {
          totalMs: Date.now() - startedAt,
          stepCount: stepIndex,
          stepBoundariesMs,
          usage: toLlmTokenUsage(result.totalUsage ?? result.usage),
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`[agent-runner] loop failed: ${err.message}`);
      return {
        stopReason: 'error',
        error: err,
        metrics: { totalMs: Date.now() - startedAt, stepCount: stepIndex, stepBoundariesMs, usage: {} },
      };
    }
  }
}
