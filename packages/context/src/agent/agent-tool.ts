import { tool as aiTool, type Tool, type ToolSet } from 'ai';
import { z, type ZodObject, type ZodRawShape } from 'zod';

export interface AgentToolCallOptions {
  toolCallId?: string;
}

export type AgentToolOutput = string | { markdown: string; structured?: unknown } | Record<string, unknown>;

export interface AgentToolDefinition<TInputSchema extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>> {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  execute(input: z.infer<TInputSchema>, options: AgentToolCallOptions): Promise<AgentToolOutput>;
}

export type AgentToolSet = Record<string, AgentToolDefinition>;

export function createAgentTool<TInputSchema extends ZodObject<ZodRawShape>>(
  definition: AgentToolDefinition<TInputSchema>,
): AgentToolDefinition<TInputSchema> {
  return definition;
}

export function assertAgentToolSet(toolSet: AgentToolSet): void {
  for (const [name, definition] of Object.entries(toolSet)) {
    if (definition.name !== name) {
      throw new Error(`Agent tool map key "${name}" does not match definition name "${definition.name}"`);
    }
    if (!(definition.inputSchema instanceof z.ZodObject)) {
      throw new Error(`Agent tool "${name}" must use a Zod object input schema`);
    }
  }
}

export function agentToolOutputToText(output: AgentToolOutput): string {
  if (output && typeof output === 'object' && 'markdown' in output) {
    const markdown = output.markdown;
    if (typeof markdown === 'string') {
      return markdown;
    }
  }
  if (output && typeof output === 'object') {
    return JSON.stringify(output);
  }
  return String(output);
}

export function toAiSdkTool(definition: AgentToolDefinition): Tool {
  return aiTool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: async (params, options) =>
      definition.execute(definition.inputSchema.parse(params), {
        ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      }),
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [{ type: 'text', text: agentToolOutputToText(output as AgentToolOutput) }],
    }),
  });
}

export function toAiSdkToolSet(toolSet: AgentToolSet): ToolSet {
  assertAgentToolSet(toolSet);
  return Object.fromEntries(Object.entries(toolSet).map(([name, definition]) => [name, toAiSdkTool(definition)]));
}
