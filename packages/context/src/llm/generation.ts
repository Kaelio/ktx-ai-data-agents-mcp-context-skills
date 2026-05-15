import type { z } from 'zod';
import type { KtxGenerateObjectInput, KtxGenerateTextInput, KtxLlmRuntimePort } from './runtime-port.js';

export async function generateKtxText(input: KtxGenerateTextInput & { runtime: KtxLlmRuntimePort }): Promise<string> {
  return input.runtime.generateText(input);
}

export async function generateKtxObject<TOutput, TSchema extends z.ZodType<TOutput>>(
  input: KtxGenerateObjectInput<TOutput, TSchema> & { runtime: KtxLlmRuntimePort },
): Promise<TOutput> {
  return input.runtime.generateObject(input);
}
