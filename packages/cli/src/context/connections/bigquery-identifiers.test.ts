import { describe, expect, it } from 'vitest';
import { normalizeBigQueryProjectId, normalizeBigQueryRegion } from './bigquery-identifiers.js';

describe('BigQuery identifier normalization', () => {
  it('normalizes project ids and regions for information schema paths', () => {
    expect(normalizeBigQueryProjectId('project-1')).toBe('project-1');
    expect(normalizeBigQueryRegion('US')).toBe('us');
    expect(normalizeBigQueryRegion('region-eu')).toBe('eu');
  });

  it('rejects malformed project ids and regions with caller-specific context', () => {
    expect(() => normalizeBigQueryProjectId('project`1', 'table discovery')).toThrow(
      'Invalid BigQuery project id for table discovery: project`1',
    );
    expect(() => normalizeBigQueryRegion('US;DROP', 'table discovery')).toThrow(
      'Invalid BigQuery region for table discovery: US;DROP',
    );
  });
});
