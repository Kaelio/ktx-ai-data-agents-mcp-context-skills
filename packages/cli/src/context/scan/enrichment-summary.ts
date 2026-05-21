import type { KtxScanEnrichmentSummary, KtxScanMode } from './types.js';

export const skippedKtxScanEnrichmentSummary: KtxScanEnrichmentSummary = {
  dataDictionary: 'skipped',
  tableDescriptions: 'skipped',
  columnDescriptions: 'skipped',
  embeddings: 'skipped',
  deterministicRelationships: 'skipped',
  llmRelationshipValidation: 'skipped',
  statisticalValidation: 'skipped',
};

export function failedKtxScanEnrichmentSummary(
  mode: KtxScanMode,
  detectRelationships = false,
): KtxScanEnrichmentSummary {
  if (mode === 'enriched') {
    return {
      dataDictionary: 'failed',
      tableDescriptions: 'failed',
      columnDescriptions: 'failed',
      embeddings: 'failed',
      deterministicRelationships: 'failed',
      llmRelationshipValidation: 'failed',
      statisticalValidation: 'failed',
    };
  }

  if (mode === 'relationships' || detectRelationships) {
    return {
      ...skippedKtxScanEnrichmentSummary,
      deterministicRelationships: 'failed',
      statisticalValidation: 'failed',
    };
  }

  return skippedKtxScanEnrichmentSummary;
}

export function ktxScanErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
