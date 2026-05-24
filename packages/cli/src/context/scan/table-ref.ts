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

/** @internal */
export function tableRefKey(ref: KtxTableRef): KtxTableRefKey {
  return `${ref.catalog ?? ''}${SEPARATOR}${ref.db ?? ''}${SEPARATOR}${ref.name}` as KtxTableRefKey;
}

/** @internal */
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

/**
 * Return the bare table names from a scope that fall within the given
 * (catalog, db) namespace.
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
    if (ref.catalog !== wantCatalog) continue;
    if (ref.db !== wantDb) continue;
    names.add(ref.name);
  }
  return [...names];
}
