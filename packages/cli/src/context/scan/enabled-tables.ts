import { hasTableRef, tableRefSet, type KtxTableRefKey } from './table-ref.js';
import type { KtxSchemaSnapshot, KtxTableRef } from './types.js';

/**
 * Parses the `enabled_tables` field on a connection into a scope of
 * fully-qualified table refs. Returns `null` when the field is absent or
 * empty (meaning "no scope — include every table in the resolved schemas").
 *
 * Accepted entry forms:
 *   "catalog.db.name"  — fully qualified
 *   "db.name"          — schema-qualified (catalog = null; legacy / Postgres-shape)
 *   "name"             — bare (catalog = db = null; SQLite-shape)
 *   { catalog?, db?, name }  — escape hatch for identifiers containing dots
 *
 * The setup wizard writes the fully-qualified form going forward; the lenient
 * parser keeps existing project configs working.
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
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entry = value as { catalog?: unknown; db?: unknown; name?: unknown };
    const name = typeof entry.name === 'string' ? entry.name : null;
    if (!name) return null;
    return {
      catalog: typeof entry.catalog === 'string' ? entry.catalog : null,
      db: typeof entry.db === 'string' ? entry.db : null,
      name,
    };
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

/** @internal — kept as a defensive backstop for the live-database adapter and tests. */
export function filterSnapshotTables(
  snapshot: KtxSchemaSnapshot,
  enabledTables: ReadonlySet<KtxTableRefKey>,
): KtxSchemaSnapshot {
  return {
    ...snapshot,
    tables: snapshot.tables.filter((table) =>
      hasTableRef(enabledTables, { catalog: table.catalog, db: table.db, name: table.name }),
    ),
  };
}
