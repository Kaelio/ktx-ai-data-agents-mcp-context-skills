import { describe, expect, it } from 'vitest';
import {
  failedKtxScanEnrichmentSummary,
  ktxScanErrorMessage,
  skippedKtxScanEnrichmentSummary,
} from './enrichment-summary.js';

describe('KTX scan enrichment summaries', () => {
  it('keeps structural scans skipped when no enrichment was requested', () => {
    expect(failedKtxScanEnrichmentSummary('structural', false)).toEqual(skippedKtxScanEnrichmentSummary);
  });

  it('marks relationship stages failed when relationship detection fails', () => {
    expect(failedKtxScanEnrichmentSummary('relationships', true)).toEqual({
      dataDictionary: 'skipped',
      tableDescriptions: 'skipped',
      columnDescriptions: 'skipped',
      embeddings: 'skipped',
      deterministicRelationships: 'failed',
      llmRelationshipValidation: 'skipped',
      statisticalValidation: 'failed',
    });
  });

  it('marks every enriched-only stage failed when full enrichment fails', () => {
    expect(failedKtxScanEnrichmentSummary('enriched', true)).toEqual({
      dataDictionary: 'failed',
      tableDescriptions: 'failed',
      columnDescriptions: 'failed',
      embeddings: 'failed',
      deterministicRelationships: 'failed',
      llmRelationshipValidation: 'failed',
      statisticalValidation: 'failed',
    });
  });

  it('formats unknown thrown values for scan warnings', () => {
    expect(ktxScanErrorMessage(new Error('gateway timeout'))).toBe('gateway timeout');
    expect(ktxScanErrorMessage('plain failure')).toBe('plain failure');
    expect(ktxScanErrorMessage({ code: 'E_SCAN' })).toBe('{"code":"E_SCAN"}');
  });
});
