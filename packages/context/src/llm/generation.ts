import { KtxMessageBuilder, type KtxLlmProvider, type KtxModelRole } from '@ktx/llm';
import { generateText, Output, type FlexibleSchema, type ToolSet } from 'ai';

type GenerateTextInput = Parameters<typeof generateText>[0];
type GenerateTextFn = (input: GenerateTextInput) => Promise<{ text?: string; output?: unknown }>;

function hasTools(tools: ToolSet): boolean {
  return Object.keys(tools).length > 0;
}

interface GenerateKtxTextInput {
  llmProvider: KtxLlmProvider;
  role: KtxModelRole;
  prompt: string;
  system?: string;
  tools?: ToolSet;
  temperature?: number;
  generateText?: GenerateTextFn;
}

export async function generateKtxText(input: GenerateKtxTextInput): Promise<string> {
  const model = input.llmProvider.getModel(input.role);
  if ((model as { provider?: string }).provider === 'deterministic') {
    return `Deterministic description for ${input.prompt.slice(0, 64).trim() || 'data source'}`;
  }
  const built = new KtxMessageBuilder(input.llmProvider).wrapSimple({
    system: input.system,
    messages: [{ role: 'user', content: input.prompt }],
    tools: input.tools ?? {},
    model,
  });
  const result = await (input.generateText ?? generateText)({
    model,
    temperature: input.temperature ?? 0,
    messages: built.messages,
    tools: built.tools as ToolSet,
    ...(hasTools(built.tools as ToolSet)
      ? {
          experimental_repairToolCall: input.llmProvider.repairToolCallHandler({
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

export async function generateKtxObject<TOutput, TSchema>(
  input: GenerateKtxTextInput & { schema: TSchema },
): Promise<TOutput> {
  const model = input.llmProvider.getModel(input.role);
  const built = new KtxMessageBuilder(input.llmProvider).wrapSimple({
    system: input.system,
    messages: [{ role: 'user', content: input.prompt }],
    tools: input.tools ?? {},
    model,
  });
  const result = await (input.generateText ?? generateText)({
    model,
    temperature: input.temperature ?? 0,
    messages: built.messages,
    tools: built.tools as ToolSet,
    ...(hasTools(built.tools as ToolSet)
      ? {
          experimental_repairToolCall: input.llmProvider.repairToolCallHandler({
            source: `ktx-${input.role}`,
          }),
        }
      : {}),
    output: Output.object({
      schema: input.schema as FlexibleSchema<TOutput>,
    }),
  });
  if (result.output == null) {
    throw new Error('KTX LLM object generation returned no output');
  }
  return result.output as TOutput;
}
