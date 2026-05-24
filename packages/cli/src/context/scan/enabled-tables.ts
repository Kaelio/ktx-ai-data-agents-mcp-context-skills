import { tableRefSet, type KtxTableRefKey } from './table-ref.js';
import type { KtxTableRef } from './types.js';

/**
 * Parses the `enabled_tables` field on a connection into a scope of
 * fully-qualified table refs. Returns `null` when the field is absent or
 * empty (meaning "no scope — include every table in the resolved schemas").
 *
 * Accepted entry forms:
 *   "catalog.db.name"  — fully qualified
 *   "db.name"          — schema-qualified (catalog = null)
 *   "name"             — bare (catalog = db = null; SQLite-shape)
 */
export function resolveEnabledTables(
  connection: Record<string, unknown> | undefined,
): ReadonlySet<KtxTableRefKey> | null {
  const raw = connection?.enabled_tables;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const refs: KtxTableRef[] = [];
  for (const value of raw) {
    const parsed = parseEnabledTableEntry(value);
    if (parsed) refs.push(parsed);
  }
  if (refs.length === 0) return null;
  return tableRefSet(refs);
}

function parseEnabledTableEntry(value: unknown): KtxTableRef | null {
  if (typeof value === 'string') {
    return parseDottedEntry(value);
  }
  return null;
}

function parseDottedEntry(value: string): KtxTableRef | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('.');
  if (parts.length === 3) {
    return { catalog: parts[0]!, db: parts[1]!, name: parts[2]! };
  }
  if (parts.length === 2) {
    return { catalog: null, db: parts[0]!, name: parts[1]! };
  }
  if (parts.length === 1) {
    return { catalog: null, db: null, name: parts[0]! };
  }
  return null;
}
