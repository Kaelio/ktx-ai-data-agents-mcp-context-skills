export const ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS = [
  'metabase',
  'notion',
  'lookml',
  'looker',
  'dbt',
  'metricflow',
] as const;

export type IsolatedDiffDirectWriteSourceKey = (typeof ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS)[number];

const ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEY_SET = new Set<string>(ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS);

export function defaultIsolatedDiffSourceKeys(): string[] {
  return [...ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS];
}

export function isIsolatedDiffDirectWriteSourceKey(
  sourceKey: string,
): sourceKey is IsolatedDiffDirectWriteSourceKey {
  return ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEY_SET.has(sourceKey);
}
