import { describe, expect, it } from 'vitest';
import { defaultSharedWorktreeSourceKeys, isSharedWorktreeFallbackSourceKey } from './source-routing.js';

describe('isolated-diff source routing', () => {
  it('defaults every non-override source to isolated diffs', () => {
    expect(defaultSharedWorktreeSourceKeys()).toEqual([]);
  });

  it('returns a mutable copy for runtime settings', () => {
    const keys = defaultSharedWorktreeSourceKeys();
    keys.push('legacy-source');

    expect(defaultSharedWorktreeSourceKeys()).toEqual([]);
  });

  it('recognizes only explicitly configured shared-worktree fallback sources', () => {
    expect(isSharedWorktreeFallbackSourceKey('notion', [])).toBe(false);
    expect(isSharedWorktreeFallbackSourceKey('metricflow', [])).toBe(false);
    expect(isSharedWorktreeFallbackSourceKey('legacy-source', ['legacy-source'])).toBe(true);
    expect(isSharedWorktreeFallbackSourceKey('other-source', ['legacy-source'])).toBe(false);
  });
});
