import type { KtxSchemaDimensionType } from './types.js';

/** @internal */
export interface KtxColumnTypeMapping {
  normalizedType: string;
  dimensionType: KtxSchemaDimensionType;
}

export function normalizeKtxNativeType(nativeType: string): string {
  const normalized = nativeType.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : 'unknown';
}

export function inferKtxDimensionType(nativeType: string): KtxSchemaDimensionType {
  const normalized = normalizeKtxNativeType(nativeType);
  if (/\b(bool|boolean)\b/.test(normalized)) {
    return 'boolean';
  }
  if (/\b(date|datetime|time|timestamp)\b/.test(normalized)) {
    return 'time';
  }
  if (/\b(int|integer|bigint|smallint|decimal|numeric|number|float|double|real)\b/.test(normalized)) {
    return 'number';
  }
  return 'string';
}

/** @internal */
export function ktxColumnTypeMappingFromNative(nativeType: string): KtxColumnTypeMapping {
  return {
    normalizedType: normalizeKtxNativeType(nativeType),
    dimensionType: inferKtxDimensionType(nativeType),
  };
}
