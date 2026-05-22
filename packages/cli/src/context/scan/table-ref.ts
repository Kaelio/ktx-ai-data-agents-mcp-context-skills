import type { KtxTableRef } from './types.js';

/**
 * Branded canonical string representation of a {@link KtxTableRef}.
 *
 * Connectors compare scopes for set membership via these keys instead of the
 * raw object (JS `Set<object>` uses identity equality, which would be useless
 * here). Build a key with {@link tableRefKey} and decode with
 * {@link tableRefFromKey}.
 */
export type KtxTableRefKey = string & { readonly __brand: 'KtxTableRefKey' };

const SEPARATOR = '\x1f';

export function tableRefKey(ref: KtxTableRef): KtxTableRefKey {
  return `${ref.catalog ?? ''}${SEPARATOR}${ref.db ?? ''}${SEPARATOR}${ref.name}` as KtxTableRefKey;
}

export function tableRefFromKey(key: KtxTableRefKey): KtxTableRef {
  const [catalog = '', db = '', name = ''] = key.split(SEPARATOR);
  return {
    catalog: catalog.length > 0 ? catalog : null,
    db: db.length > 0 ? db : null,
    name,
  };
}

export function tableRefSet(refs: readonly KtxTableRef[]): ReadonlySet<KtxTableRefKey> {
  return new Set(refs.map(tableRefKey));
}

export function hasTableRef(scope: ReadonlySet<KtxTableRefKey>, ref: KtxTableRef): boolean {
  if (scope.has(tableRefKey(ref))) return true;
  if (ref.catalog !== null) {
    if (scope.has(tableRefKey({ ...ref, catalog: null }))) return true;
  }
  if (ref.db !== null) {
    if (scope.has(tableRefKey({ ...ref, db: null }))) return true;
  }
  return false;
}

/**
 * Return the bare table names from a scope that fall within the given
 * (catalog, db) namespace. `catalog: null` is treated as a wildcard so that
 * legacy 2-part `"db.name"` entries continue to match. Same for `db: null`.
 */
export function scopedTableNames(
  scope: ReadonlySet<KtxTableRefKey>,
  namespace: { catalog?: string | null; db?: string | null },
): string[] {
  const names = new Set<string>();
  const wantCatalog = namespace.catalog ?? null;
  const wantDb = namespace.db ?? null;
  for (const key of scope) {
    const ref = tableRefFromKey(key);
    if (wantCatalog !== null && ref.catalog !== null && ref.catalog !== wantCatalog) continue;
    if (wantDb !== null && ref.db !== null && ref.db !== wantDb) continue;
    names.add(ref.name);
  }
  return [...names];
}
