import { tool } from 'ai';
import { z, type ZodType } from 'zod';
import { noopLogger, type KtxLogger } from '../core/index.js';
import type { IngestToolMetadata, ToolSession } from './tool-session.js';

export interface ToolOutput<T = unknown> {
  markdown: string;
  structured: T;
}

export interface ToolTimingTrackerPort {
  recordToolExecutionStart(messageId: string, toolName: string, toolCallId: string): void;
  recordToolExecutionEnd(messageId: string, toolName: string, toolCallId: string, state: string): void;
}

export interface ToolProgressRelayPort {
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

export interface MethodologyEntry {
  key: string;
  toolName: string;
  label: string;
  args: Record<string, unknown>;
  result?: unknown;
}

/**
 * SECURITY: All tools require authentication. userId must always be provided in ToolContext.
 */
export abstract class BaseTool<TInput extends ZodType = ZodType> {
  protected readonly logger: KtxLogger;

  abstract readonly name: string;

  constructor(logger: KtxLogger = noopLogger) {
    this.logger = logger;
  }

  abstract get description(): string;

  abstract get inputSchema(): TInput;

  abstract call(input: z.infer<TInput>, context: ToolContext): Promise<any>;

  getParametersSchema(): {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  } {
    const jsonSchema = z.toJSONSchema(this.inputSchema, {
      target: 'draft-7',
    });

    return jsonSchema as any;
  }

  toAnthropicFormat(): {
    name: string;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  } {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.getParametersSchema(),
    };
  }

  toAiSdkTool(context: ToolContext): any {
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
          const parsedInput = this.parseInput(params as Record<string, any>);
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

  parseInput(input: Record<string, any>): z.infer<TInput> {
    return this.inputSchema.parse(input);
  }

  protected getCurrentUserQuery(context: ToolContext): string | null {
    return context.currentUserMessage ?? null;
  }
}
