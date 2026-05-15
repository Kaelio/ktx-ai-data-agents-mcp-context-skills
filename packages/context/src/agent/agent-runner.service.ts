import { KtxMessageBuilder, splitKtxSystemMessages, type KtxLlmProvider, type KtxModelRole } from '@ktx/llm';
import { generateText, stepCountIs, type TelemetrySettings, type Tool } from 'ai';
import { noopLogger, type KtxLogger } from '../core/index.js';
import { summarizeKtxLlmDebugRequest, type KtxLlmDebugRequestRecorder } from '../llm/index.js';

export type RunLoopStopReason = 'budget' | 'natural' | 'error';

export interface RunLoopStepInfo {
  stepIndex: number;
  stepBudget: number;
}

export interface RunLoopParams {
  modelRole: KtxModelRole;
  systemPrompt: string;
  userPrompt: string;
  toolSet: Record<string, Tool>;
  stepBudget: number;
  telemetryTags: Record<string, string>;
  onStepFinish?: (info: RunLoopStepInfo) => void | Promise<void>;
}

export interface RunLoopResult {
  stopReason: RunLoopStopReason;
  error?: Error;
}

export interface AgentTelemetryPort {
  createTelemetry(tags: Record<string, string>): TelemetrySettings;
}

export interface AgentRunnerServiceDeps {
  llmProvider: KtxLlmProvider;
  telemetry?: AgentTelemetryPort;
  debugRequestRecorder?: KtxLlmDebugRequestRecorder;
  logger?: KtxLogger;
}

export class AgentRunnerService {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: AgentRunnerServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async runLoop(params: RunLoopParams): Promise<RunLoopResult> {
    let stepIndex = 0;
    try {
      const model = this.deps.llmProvider.getModel(params.modelRole);
      const builder = new KtxMessageBuilder(this.deps.llmProvider);
      const built = builder.wrapSimple({
        system: params.systemPrompt,
        messages: [{ role: 'user', content: params.userPrompt }],
        tools: params.toolSet,
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
        experimental_telemetry: this.deps.telemetry?.createTelemetry(params.telemetryTags),
        experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
          source: params.telemetryTags.operationName ?? 'ktx-agent-runner',
        }),
        ...(promptMessages.system ? { system: promptMessages.system } : {}),
        messages: promptMessages.messages,
        tools: built.tools as Record<string, Tool>,
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
