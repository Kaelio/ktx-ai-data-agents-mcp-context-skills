import { describe, expect, it } from 'vitest';
import { inferKtxDimensionType, ktxColumnTypeMappingFromNative, normalizeKtxNativeType } from '../../../src/context/scan/type-normalization.js';

describe('KTX scan type normalization', () => {
  it('normalizes native database type strings', () => {
    expect(normalizeKtxNativeType(' NUMERIC(12, 2) ')).toBe('numeric');
    expect(normalizeKtxNativeType('TIMESTAMP WITH TIME ZONE')).toBe('timestamp with time zone');
    expect(normalizeKtxNativeType('')).toBe('unknown');
  });

  it('infers dimension types from native types', () => {
    expect(inferKtxDimensionType('BOOLEAN')).toBe('boolean');
    expect(inferKtxDimensionType('timestamp with time zone')).toBe('time');
    expect(inferKtxDimensionType('decimal(10,2)')).toBe('number');
    expect(inferKtxDimensionType('varchar(255)')).toBe('string');
  });

  it('builds a complete column type mapping', () => {
    expect(ktxColumnTypeMappingFromNative('BIGINT')).toEqual({
      normalizedType: 'bigint',
      dimensionType: 'number',
    });
  });
});
