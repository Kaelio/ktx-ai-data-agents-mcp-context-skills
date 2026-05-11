import { createHash } from 'node:crypto';
import type { StagedSyncConfig } from './types.js';

export type FetchScope =
  | { kind: 'all' }
  | { kind: 'all-except'; excludeCardIds: Set<number>; excludeCollectionIds: Set<number> }
  | { kind: 'explicit'; includeCardIds: Set<number>; includeCollectionIds: Set<number> };

/**
 * Collapse the staged sync-config's `syncMode` + `selections` into the discriminated
 * union the fetcher switches on. Pure function; no I/O, no side effects.
 */
export function computeFetchScope(syncConfig: StagedSyncConfig): FetchScope {
  if (syncConfig.syncMode === 'ALL' || (syncConfig.syncMode === 'ONLY' && syncConfig.selections.length === 0)) {
    return { kind: 'all' };
  }
  const cardIds = new Set<number>();
  const collectionIds = new Set<number>();
  for (const sel of syncConfig.selections) {
    if (sel.selectionType === 'item') {
      cardIds.add(sel.metabaseObjectId);
    } else {
      collectionIds.add(sel.metabaseObjectId);
    }
  }
  if (syncConfig.syncMode === 'EXCEPT') {
    return { kind: 'all-except', excludeCardIds: cardIds, excludeCollectionIds: collectionIds };
  }
  return { kind: 'explicit', includeCardIds: cardIds, includeCollectionIds: collectionIds };
}

/**
 * Stable SHA-256 hex fingerprint of the scope. Order-insensitive (sets are
 * sorted before serialization) so that two scopes with the same membership
 * hash identically.
 */
export function hashScope(scope: FetchScope): string {
  const canonical = canonicalize(scope);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(scope: FetchScope): string {
  if (scope.kind === 'all') {
    return JSON.stringify({ kind: 'all' });
  }
  if (scope.kind === 'all-except') {
    return JSON.stringify({
      kind: 'all-except',
      excludeCardIds: [...scope.excludeCardIds].sort((a, b) => a - b),
      excludeCollectionIds: [...scope.excludeCollectionIds].sort((a, b) => a - b),
    });
  }
  return JSON.stringify({
    kind: 'explicit',
    includeCardIds: [...scope.includeCardIds].sort((a, b) => a - b),
    includeCollectionIds: [...scope.includeCollectionIds].sort((a, b) => a - b),
  });
}

const CARD_PATH_RE = /^cards\/(\d+)\.json$/;

/**
 * Decide whether a staged-dir-relative path falls inside the given scope.
 * `sync-config.json`, `collections/*`, and `databases/*` are always in-scope
 * (they're global files the chunker always needs). Only `cards/<id>.json`
 * paths are scope-checked — unknown path shapes default to true so we don't
 * silently drop metadata files a future adapter variant might introduce.
 */
export function isPathInMetabaseScope(rawPath: string, scope: FetchScope): boolean {
  const match = CARD_PATH_RE.exec(rawPath);
  if (!match) {
    return true;
  }
  const cardId = Number(match[1]);
  if (scope.kind === 'all') {
    return true;
  }
  if (scope.kind === 'all-except') {
    return !scope.excludeCardIds.has(cardId);
  }
  return scope.includeCardIds.has(cardId);
}
