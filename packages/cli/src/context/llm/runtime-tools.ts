import { tool as aiTool, type Tool, type ToolSet } from 'ai';
import { tool as claudeTool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { KtxRuntimeToolDescriptor, KtxRuntimeToolOutput, KtxRuntimeToolSet } from './runtime-port.js';

function isRuntimeOutput(value: unknown): value is KtxRuntimeToolOutput {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'markdown' in value &&
      typeof (value as { markdown?: unknown }).markdown === 'string',
  );
}

export function normalizeKtxRuntimeToolOutput(value: unknown): KtxRuntimeToolOutput {
  if (isRuntimeOutput(value)) {
    return 'structured' in value ? { markdown: value.markdown, structured: value.structured } : { markdown: value.markdown };
  }
  if (typeof value === 'string') {
    return { markdown: value };
  }
  return {
    markdown: `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
    structured: value,
  };
}

function assertObjectSchema(name: string, schema: z.ZodType): asserts schema is z.ZodObject<z.ZodRawShape> {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`ktx runtime tool "${name}" must use z.object input schema for claude-code`);
  }
}

export function createAiSdkToolSet(tools: KtxRuntimeToolSet = {}): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, descriptor]) => [
      name,
      aiTool({
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        execute: async (input) => descriptor.execute(input),
        toModelOutput: ({ output }) => {
          const normalized = normalizeKtxRuntimeToolOutput(output);
          return { type: 'text', value: normalized.markdown };
        },
      }),
    ]),
  );
}

export function createClaudeSdkTools(tools: KtxRuntimeToolSet = {}): Array<SdkMcpToolDefinition<z.ZodRawShape>> {
  return Object.values(tools).map((descriptor) => {
    assertObjectSchema(descriptor.name, descriptor.inputSchema);
    return claudeTool(
      descriptor.name,
      descriptor.description,
      descriptor.inputSchema.shape,
      async (input): Promise<CallToolResult> => {
        const normalized = normalizeKtxRuntimeToolOutput(await descriptor.execute(input));
        return { content: [{ type: 'text', text: normalized.markdown }] };
      },
    );
  });
}

export function mcpToolIds(tools: KtxRuntimeToolSet = {}): string[] {
  return Object.keys(tools).map((name) => `mcp__ktx__${name}`);
}

export function createRuntimeToolDescriptorFromAiTool(name: string, aiSdkTool: Tool): KtxRuntimeToolDescriptor {
  return {
    name,
    description: aiSdkTool.description ?? '',
    inputSchema: aiSdkTool.inputSchema as KtxRuntimeToolDescriptor['inputSchema'],
    execute: async (input) => {
      if (typeof aiSdkTool.execute !== 'function') {
        throw new Error(`ktx runtime tool "${name}" has no execute function`);
      }
      return normalizeKtxRuntimeToolOutput(
        await aiSdkTool.execute(input as never, { toolCallId: `runtime-${name}` } as never),
      );
    },
  };
}
