import { describe, expect, it } from 'vitest';
import {
  defaultIsolatedDiffSourceKeys,
  isIsolatedDiffDirectWriteSourceKey,
  ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS,
} from './source-routing.js';

describe('isolated-diff source routing', () => {
  it('keeps the runner-owned direct-write connector list explicit', () => {
    expect(ISOLATED_DIFF_DIRECT_WRITE_SOURCE_KEYS).toEqual([
      'metabase',
      'notion',
      'lookml',
      'looker',
      'dbt',
      'metricflow',
    ]);
  });

  it('returns a mutable copy for runtime settings', () => {
    const keys = defaultIsolatedDiffSourceKeys();
    keys.push('fake');

    expect(defaultIsolatedDiffSourceKeys()).toEqual([
      'metabase',
      'notion',
      'lookml',
      'looker',
      'dbt',
      'metricflow',
    ]);
  });

  it('recognizes migrated connector source keys only', () => {
    expect(isIsolatedDiffDirectWriteSourceKey('notion')).toBe(true);
    expect(isIsolatedDiffDirectWriteSourceKey('metricflow')).toBe(true);
    expect(isIsolatedDiffDirectWriteSourceKey('historic-sql')).toBe(false);
    expect(isIsolatedDiffDirectWriteSourceKey('live-database')).toBe(false);
  });
});
