const DEFAULT_SHARED_WORKTREE_SOURCE_KEYS: readonly string[] = [];

export function defaultSharedWorktreeSourceKeys(): string[] {
  return [...DEFAULT_SHARED_WORKTREE_SOURCE_KEYS];
}

export function isSharedWorktreeFallbackSourceKey(
  sourceKey: string,
  sharedWorktreeSourceKeys: readonly string[] = DEFAULT_SHARED_WORKTREE_SOURCE_KEYS,
): boolean {
  return sharedWorktreeSourceKeys.includes(sourceKey);
}
