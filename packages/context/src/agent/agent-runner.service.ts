import type { KtxLlmProvider } from '@ktx/llm';
import type { KtxLogger } from '../core/index.js';
import { AiSdkKtxLlmRuntime, type AgentTelemetryPort } from '../llm/ai-sdk-runtime.js';
import type { KtxLlmDebugRequestRecorder } from '../llm/debug-request-recorder.js';
import type { AgentRunnerPort, RunLoopParams, RunLoopResult } from '../llm/runtime-port.js';
export type {
  AgentRunnerPort,
  RunLoopParams,
  RunLoopResult,
  RunLoopStepInfo,
  RunLoopStopReason,
} from '../llm/runtime-port.js';
export type { AgentTelemetryPort } from '../llm/ai-sdk-runtime.js';

export interface AgentRunnerServiceDeps {
  llmProvider: KtxLlmProvider;
  telemetry?: AgentTelemetryPort;
  debugRequestRecorder?: KtxLlmDebugRequestRecorder;
  logger?: KtxLogger;
}

export class AgentRunnerService implements AgentRunnerPort {
  private readonly runtime: AiSdkKtxLlmRuntime;

  constructor(deps: AgentRunnerServiceDeps) {
    this.runtime = new AiSdkKtxLlmRuntime(deps);
  }

  runLoop(params: RunLoopParams): Promise<RunLoopResult> {
    return this.runtime.runAgentLoop(params);
  }
}
