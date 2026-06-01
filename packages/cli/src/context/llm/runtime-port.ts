import type { KtxModelRole } from '../../llm/types.js';
import type { z } from 'zod';

export interface KtxRuntimeToolOutput<TOutput = unknown> {
  markdown: string;
  structured?: TOutput;
}

export interface KtxRuntimeToolDescriptor<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  execute(input: TInput): Promise<KtxRuntimeToolOutput<TOutput>>;
}

export type KtxRuntimeToolSet = Record<string, KtxRuntimeToolDescriptor>;

export type RunLoopStopReason = 'budget' | 'natural' | 'error';

/** @internal */
export interface RunLoopStepInfo {
  stepIndex: number;
  stepBudget: number;
}

export interface LlmTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Timing and token metrics for a multi-step agent loop, used for ingest profiling. */
export interface RunLoopMetrics {
  /** Wall-clock time around the whole `generateText` call, in milliseconds. */
  totalMs: number;
  /** Aggregate token usage across all steps. */
  usage: LlmTokenUsage;
  /** Number of agent steps (model round-trips) that actually ran. */
  stepCount: number;
  /** Wall-clock offset (ms from loop start) at which each step finished. */
  stepBoundariesMs: number[];
}

export interface RunLoopParams {
  modelRole: KtxModelRole;
  systemPrompt: string;
  userPrompt: string;
  toolSet: KtxRuntimeToolSet;
  stepBudget: number;
  telemetryTags: Record<string, string>;
  onStepFinish?: (info: RunLoopStepInfo) => void | Promise<void>;
}

export interface RunLoopResult {
  stopReason: RunLoopStopReason;
  error?: Error;
  metrics?: RunLoopMetrics;
}

export interface KtxGenerateTextInput {
  role: KtxModelRole;
  prompt: string;
  system?: string;
  tools?: KtxRuntimeToolSet;
  temperature?: number;
  onMetrics?: (metrics: { totalMs: number; usage: LlmTokenUsage }) => void;
}

export interface KtxGenerateObjectInput<TOutput, TSchema extends z.ZodType<TOutput>> {
  role: KtxModelRole;
  prompt: string;
  system?: string;
  tools?: KtxRuntimeToolSet;
  temperature?: number;
  schema: TSchema;
  onMetrics?: (metrics: { totalMs: number; usage: LlmTokenUsage }) => void;
}

export interface KtxLlmRuntimePort {
  generateText(input: KtxGenerateTextInput): Promise<string>;
  generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput>;
  runAgentLoop(params: RunLoopParams): Promise<RunLoopResult>;
}

export interface AgentRunnerPort {
  runLoop(params: RunLoopParams): Promise<RunLoopResult>;
}

export class RuntimeAgentRunner implements AgentRunnerPort {
  constructor(private readonly runtime: KtxLlmRuntimePort) {}

  runLoop(params: RunLoopParams): Promise<RunLoopResult> {
    return this.runtime.runAgentLoop(params);
  }
}
