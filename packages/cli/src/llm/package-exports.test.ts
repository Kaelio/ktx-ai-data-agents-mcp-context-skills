import { describe, expect, it } from 'vitest';

describe('@ktx/llm package exports', () => {
  it('exports the canonical LLM and embedding surfaces', async () => {
    const llm = await import('./index.js');

    expect(llm.KTX_MODEL_ROLES).toEqual([
      'default',
      'triage',
      'candidateExtraction',
      'curator',
      'reconcile',
      'repair',
    ]);
    expect(llm.createKtxLlmProvider).toBeTypeOf('function');
    expect(llm.KtxMessageBuilder).toBeTypeOf('function');
    expect(llm.createKtxEmbeddingProvider).toBeTypeOf('function');
  });
});
