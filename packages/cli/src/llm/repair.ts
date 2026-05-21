import { NoSuchToolError, type LanguageModel, type ToolCallRepairFunction, type ToolSet, generateText } from 'ai';

interface KtxToolCallRepairHandlerInput {
  source: string;
  getRepairModel: () => LanguageModel;
  generateText?: typeof generateText;
}

function extractJsonFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {}

  let start = trimmed.indexOf('{');
  while (start >= 0) {
    let end = trimmed.lastIndexOf('}');
    while (end > start) {
      const candidate = trimmed.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {}
      end = trimmed.lastIndexOf('}', end - 1);
    }
    start = trimmed.indexOf('{', start + 1);
  }
  return null;
}

export function createKtxToolCallRepairHandler(
  input: KtxToolCallRepairHandlerInput,
): ToolCallRepairFunction<ToolSet> {
  const runGenerateText = input.generateText ?? generateText;

  return async ({ toolCall, tools, inputSchema, error }) => {
    if (NoSuchToolError.isInstance(error)) {
      return null;
    }

    if (typeof toolCall.input === 'string') {
      const extracted = extractJsonFromText(toolCall.input);
      if (extracted) {
        return {
          type: 'tool-call',
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          input: extracted,
        };
      }
    }

    if (!(toolCall.toolName in tools)) {
      return null;
    }

    try {
      const schema = await inputSchema({ toolName: toolCall.toolName });
      const { text } = await runGenerateText({
        model: input.getRepairModel(),
        prompt: `The model tried to call the tool "${toolCall.toolName}" with the following inputs:
${JSON.stringify(toolCall.input)}

However, this caused a validation error: ${error.message}

The tool accepts the following schema:
${JSON.stringify(schema)}

Please generate corrected inputs that match the schema. Return ONLY valid JSON, no explanation or markdown formatting.`,
      });

      const cleaned = extractJsonFromText(text) ?? text.trim();
      const parsed = JSON.parse(cleaned);
      return {
        type: 'tool-call',
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        input: JSON.stringify(parsed),
      };
    } catch {
      return null;
    }
  };
}
