import { KtxMessageBuilder, splitKtxSystemMessages } from '../../llm/message-builder.js';
import type { KtxLlmProvider } from '../../llm/types.js';
import { generateText, Output, stepCountIs, type FlexibleSchema, type TelemetrySettings, type ToolSet } from 'ai';
import type { z } from 'zod';
import { noopLogger, type KtxLogger } from '../../context/core/config.js';
import { summarizeKtxLlmDebugRequest, type KtxLlmDebugRequestRecorder } from './debug-request-recorder.js';
import { createAiSdkToolSet } from './runtime-tools.js';
import type {
  KtxGenerateObjectInput,
  KtxGenerateTextInput,
  KtxLlmRuntimePort,
  RunLoopParams,
  RunLoopResult,
} from './runtime-port.js';

interface AgentTelemetryPort {
  createTelemetry(tags: Record<string, string>): TelemetrySettings;
}

export interface AiSdkKtxLlmRuntimeDeps {
  llmProvider: KtxLlmProvider;
  telemetry?: AgentTelemetryPort;
  logger?: KtxLogger;
  debugRequestRecorder?: KtxLlmDebugRequestRecorder;
}

function hasTools(tools: Record<string, unknown>): boolean {
  return Object.keys(tools).length > 0;
}

export class AiSdkKtxLlmRuntime implements KtxLlmRuntimePort {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: AiSdkKtxLlmRuntimeDeps) {
    this.logger = deps.logger ?? noopLogger;
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
    const result = await generateText({
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
    });
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
    const result = await generateText({
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
    });
    if (result.output == null) {
      throw new Error('KTX LLM object generation returned no output');
    }
    return result.output as TOutput;
  }

  async runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
    let stepIndex = 0;
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

      await generateText({
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
      });
      return { stopReason: 'natural' };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`[agent-runner] loop failed: ${err.message}`);
      return { stopReason: 'error', error: err };
    }
  }
}
