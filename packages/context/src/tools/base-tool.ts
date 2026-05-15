import { z, type ZodType } from 'zod';
import { createAgentTool, toAiSdkTool, type AgentToolDefinition } from '../agent/agent-tool.js';
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

  toAgentTool(context: ToolContext): AgentToolDefinition<any> {
    const toolName = this.name;

    return createAgentTool({
      name: toolName,
      description: this.description,
      inputSchema: this.inputSchema as any,
      execute: async (params, { toolCallId }) => {
        const callContext = { ...context, ...(toolCallId ? { toolCallId } : {}) };

        if (callContext.timingTracker && toolCallId) {
          callContext.timingTracker.recordToolExecutionStart(callContext.messageId, toolName, toolCallId);
        }

        let state = 'completed';
        try {
          if (!callContext.userId) {
            throw new Error('Authentication required: userId must be provided in ToolContext');
          }
          const parsedInput = this.parseInput(params as Record<string, any>);
          return await this.call(parsedInput, callContext);
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
    });
  }

  toAiSdkTool(context: ToolContext): any {
    return toAiSdkTool(this.toAgentTool(context));
  }

  parseInput(input: Record<string, any>): z.infer<TInput> {
    return this.inputSchema.parse(input);
  }

  protected getCurrentUserQuery(context: ToolContext): string | null {
    return context.currentUserMessage ?? null;
  }
}
