import type { KtxSchemaSnapshot, KtxSchemaTable } from '../../../scan/types.js';

export interface LiveDatabaseExtractedForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  constraintName?: string;
}

export interface LiveDatabaseExtractedColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  dbComment: string | null;
}

export interface LiveDatabaseExtractedTable {
  name: string;
  catalog: string | null;
  db: string | null;
  dbComment: string | null;
  columns: LiveDatabaseExtractedColumn[];
  foreignKeys: LiveDatabaseExtractedForeignKey[];
}

export interface LiveDatabaseExtractedSchema {
  connectionId?: string;
  tables: LiveDatabaseExtractedTable[];
}

export function buildLiveDatabaseTableNaturalKey(table: Pick<KtxSchemaTable, 'catalog' | 'db' | 'name'>): string {
  return `${table.catalog ?? ''}|${table.db ?? ''}|${table.name}`;
}

export function ktxSchemaSnapshotToExtractedSchema(snapshot: KtxSchemaSnapshot): LiveDatabaseExtractedSchema {
  return {
    connectionId: snapshot.connectionId,
    tables: snapshot.tables.map((table) => ({
      name: table.name,
      catalog: table.catalog ?? null,
      db: table.db ?? null,
      dbComment: table.comment ?? null,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.nativeType,
        nullable: column.nullable,
        primaryKey: column.primaryKey,
        dbComment: column.comment ?? null,
      })),
      foreignKeys: table.foreignKeys.map((foreignKey) => ({
        fromTable: table.name,
        fromColumn: foreignKey.fromColumn,
        toTable: foreignKey.toTable,
        toColumn: foreignKey.toColumn,
        ...(foreignKey.constraintName ? { constraintName: foreignKey.constraintName } : {}),
      })),
    })),
  };
}
