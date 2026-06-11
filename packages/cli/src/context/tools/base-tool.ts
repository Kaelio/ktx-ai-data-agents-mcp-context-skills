import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { noopLogger, type KtxLogger } from '../../context/core/config.js';
import type { KtxRuntimeToolDescriptor } from '../llm/runtime-port.js';
import { normalizeKtxRuntimeToolOutput } from '../llm/runtime-tools.js';
import type { IngestToolMetadata, ToolSession } from './tool-session.js';

export interface ToolOutput<T = unknown> {
  markdown: string;
  structured: T;
}

interface ToolTimingTrackerPort {
  recordToolExecutionStart(messageId: string, toolName: string, toolCallId: string): void;
  recordToolExecutionEnd(messageId: string, toolName: string, toolCallId: string, state: string): void;
}

interface ToolProgressRelayPort {
  emit(event: unknown): void;
}

type ChatSource =
  | 'RESEARCH'
  | 'DASHBOARD'
  | 'WIDGET_CONFIG'
  | 'EVALUATION'
  | 'METRIC_WORKSHOP'
  | 'INPUT_CONFIG'
  | 'SCHEDULED_RESEARCH'
  | 'DASHBOARD_GENERATION';

export interface ToolContext {
  sourceId: string;
  messageId: string;
  userId: string;
  userRoles?: string[];
  authToken?: string;
  currentUserMessage?: string;
  toolCallId?: string;
  toolCallHistory?: string[];
  timingTracker?: ToolTimingTrackerPort;
  source?: ChatSource;
  dashboardId?: string;
  methodologyEntries?: MethodologyEntry[];
  progressRelay?: ToolProgressRelayPort;
  connectionId?: string;
  ingest?: IngestToolMetadata;
  /**
   * Per-session state (ingest WU, memory-agent post-turn). When present, SL/wiki
   * tools use session-scoped services and emit touched-set entries instead of
   * writing to shared indexes immediately. Non-session callers leave this unset.
   */
  session?: ToolSession;
  currentDefinition?: {
    sql: string;
    measures: unknown[];
    dimensions: unknown[];
    parameters: unknown[];
    segments: unknown[];
    name?: string;
    description?: string;
  };
}

interface MethodologyEntry {
  key: string;
  toolName: string;
  label: string;
  args: Record<string, unknown>;
  result?: unknown;
}

/**
 * SECURITY: All tools require authentication. userId must always be provided in ToolContext.
 */
export abstract class BaseTool<TInput extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  protected readonly logger: KtxLogger;

  abstract readonly name: string;

  constructor(logger: KtxLogger = noopLogger) {
    this.logger = logger;
  }

  abstract get description(): string;

  abstract get inputSchema(): TInput;

  abstract call(input: z.infer<TInput>, context: ToolContext): Promise<unknown>;

  toAiSdkTool(context: ToolContext): Tool {
    const toolName = this.name;
    const logger = this.logger;

    return tool({
      description: this.description,
      inputSchema: this.inputSchema,
      execute: async (params, { toolCallId }) => {
        // Create context copy with current toolCallId (safe for parallel execution)
        const callContext = { ...context, toolCallId };

        // Record tool execution start (input generation has already been tracked via onChunk)
        if (callContext.timingTracker && toolCallId) {
          callContext.timingTracker.recordToolExecutionStart(callContext.messageId, toolName, toolCallId);
        }

        let state = 'completed';
        try {
          if (!callContext.userId) {
            throw new Error('Authentication required: userId must be provided in ToolContext');
          }
          const parsedInput = this.parseInput(params as Record<string, unknown>);
          const result = await this.call(parsedInput, callContext);
          return result;
        } catch (error) {
          state = 'error';
          this.logger.error(
            `Tool ${this.name} execution failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        } finally {
          // Record tool execution end
          if (callContext.timingTracker && toolCallId) {
            callContext.timingTracker.recordToolExecutionEnd(callContext.messageId, toolName, toolCallId, state);
          }
        }
      },
      // Send only markdown to the LLM; tool callers still receive the structured output.
      toModelOutput: ({ output }) => {
        if (output && typeof output === 'object' && 'markdown' in output) {
          return { type: 'content', value: [{ type: 'text', text: output.markdown as string }] };
        }
        if (typeof output !== 'string') {
          logger.warn(`Tool ${toolName} returned unexpected output type: ${typeof output}. Coercing to string.`);
        }
        return { type: 'content', value: [{ type: 'text', text: String(output) }] };
      },
    });
  }

  toRuntimeTool(context: ToolContext): KtxRuntimeToolDescriptor {
    const toolName = this.name;
    return {
      name: toolName,
      description: this.description,
      inputSchema: this.inputSchema,
      execute: async (params) => {
        const callContext = { ...context };
        if (!callContext.userId) {
          throw new Error('Authentication required: userId must be provided in ToolContext');
        }
        const parsedInput = this.parseInput(params as Record<string, unknown>);
        return normalizeKtxRuntimeToolOutput(await this.call(parsedInput, callContext));
      },
    };
  }

  parseInput(input: Record<string, unknown>): z.infer<TInput> {
    return this.inputSchema.parse(input);
  }

  protected getCurrentUserQuery(context: ToolContext): string | null {
    return context.currentUserMessage ?? null;
  }
}
