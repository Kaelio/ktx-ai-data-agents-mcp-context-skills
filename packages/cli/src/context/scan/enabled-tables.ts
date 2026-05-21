import type { KtxSchemaSnapshot } from './types.js';

export function resolveEnabledTables(connection: Record<string, unknown> | undefined): Set<string> | null {
  const raw = connection?.enabled_tables;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return new Set(raw.filter((v): v is string => typeof v === 'string'));
}

export function filterSnapshotTables(snapshot: KtxSchemaSnapshot, enabledTables: Set<string>): KtxSchemaSnapshot {
  return {
    ...snapshot,
    tables: snapshot.tables.filter((table) => {
      const key = table.db ? `${table.db}.${table.name}` : table.name;
      return enabledTables.has(key);
    }),
  };
}
