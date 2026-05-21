import type { LiveDatabaseExtractedSchema, LiveDatabaseExtractedTable } from './extracted-schema.js';
import { buildLiveDatabaseTableNaturalKey } from './extracted-schema.js';

export interface LiveDatabaseSyncedColumn {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  parentColumnId: string | null;
  descriptions: Record<string, string>;
  embedding: number[] | null;
  sampleValues: string[] | null;
  cardinality: number | null;
}

export interface LiveDatabaseSyncedTable {
  id: string;
  name: string;
  catalog: string | null;
  db: string | null;
  enabled: boolean;
  descriptions: Record<string, string>;
  columns: LiveDatabaseSyncedColumn[];
}

export interface LiveDatabaseSyncedLink {
  id: string;
  fromTableId: string;
  fromColumnId: string;
  toTableId: string;
  toColumnId: string;
  source: 'formal' | 'inferred' | 'manual';
  confidence: number;
  relationshipType: string;
  isPrimaryKeyReference: boolean;
}

export interface LiveDatabaseSyncedSchema {
  connectionId: string;
  tables: LiveDatabaseSyncedTable[];
  links: LiveDatabaseSyncedLink[];
}

export interface LiveDatabaseStructuralChanges {
  newTableIds: string[];
  newColumnIds: string[];
  tablesWithStructuralChanges: string[];
  columnsWithTypeChange: string[];
  columnsWithDescriptionChange: string[];
  tablesWithDescriptionChange: string[];
}

export interface LiveDatabaseStructuralSyncStats {
  tablesCreated: number;
  tablesDeleted: number;
  columnsCreated: number;
  columnsDeleted: number;
  columnsModified: number;
  formalLinksCreated: number;
  formalLinksDeleted: number;
}

export interface LiveDatabaseStructuralSyncOperations {
  deleteTableIds: string[];
  deleteColumnIds: string[];
  insertTables: Array<{
    id: string;
    connectionId: string;
    name: string;
    catalog: string | null;
    db: string | null;
    enabled: boolean;
  }>;
  insertColumns: Array<{
    id: string;
    tableId: string;
    name: string;
    parentColumnId: string | null;
  }>;
  touchColumnIds: string[];
  invalidateColumnEmbeddingIds: string[];
}

export interface LiveDatabaseStructuralSyncPlan {
  schema: LiveDatabaseSyncedSchema;
  inferredLinksToValidate: string[];
  stats: LiveDatabaseStructuralSyncStats;
  changes: LiveDatabaseStructuralChanges;
  operations: LiveDatabaseStructuralSyncOperations;
}

export interface PlanLiveDatabaseStructuralSyncInput {
  connectionId: string;
  current: LiveDatabaseSyncedSchema | null;
  extracted: LiveDatabaseExtractedSchema;
  idFactory: () => string;
}

interface UpdatedTableResult {
  table: LiveDatabaseSyncedTable;
  columnsCreated: number;
  columnsDeleted: number;
  columnsModified: number;
  newColumnIds: string[];
  columnsWithTypeChange: string[];
  columnsWithDescriptionChange: string[];
  tableDescriptionChanged: boolean;
}

function updateDescription(
  descriptions: Record<string, string>,
  dbComment: string | null | undefined,
  changed: boolean,
): Record<string, string> {
  const updated = { ...descriptions };
  if (dbComment) {
    updated.db = dbComment;
  } else {
    delete updated.db;
  }
  if (changed) {
    delete updated.ai;
  }
  return updated;
}

function descriptionFromDbComment(dbComment: string | null | undefined): Record<string, string> {
  return dbComment ? { db: dbComment } : {};
}

function planUpdatedTable(args: {
  currentTable: LiveDatabaseSyncedTable;
  extractedTable: LiveDatabaseExtractedTable;
  currentLinks: LiveDatabaseSyncedLink[];
  inferredLinksToValidate: string[];
  operations: LiveDatabaseStructuralSyncOperations;
  idFactory: () => string;
}): UpdatedTableResult {
  const { currentTable, extractedTable, currentLinks, inferredLinksToValidate, operations, idFactory } = args;

  let columnsCreated = 0;
  let columnsDeleted = 0;
  let columnsModified = 0;
  const newColumnIds: string[] = [];
  const columnsWithTypeChange: string[] = [];
  const columnsWithDescriptionChange: string[] = [];
  const updatedColumns: LiveDatabaseSyncedColumn[] = [];

  const tableDescriptionChanged = (currentTable.descriptions.db ?? null) !== (extractedTable.dbComment ?? null);
  const currentColumnsByName = new Map(currentTable.columns.map((column) => [column.name, column]));
  const extractedColumnsByName = new Map(extractedTable.columns.map((column) => [column.name, column]));

  for (const [name, currentColumn] of currentColumnsByName) {
    if (!extractedColumnsByName.has(name)) {
      operations.deleteColumnIds.push(currentColumn.id);
      columnsDeleted++;
    }
  }

  for (const [name, extractedColumn] of extractedColumnsByName) {
    const currentColumn = currentColumnsByName.get(name);
    if (!currentColumn) {
      const columnId = idFactory();
      operations.insertColumns.push({
        id: columnId,
        tableId: currentTable.id,
        name: extractedColumn.name,
        parentColumnId: null,
      });
      columnsCreated++;
      newColumnIds.push(columnId);
      updatedColumns.push({
        id: columnId,
        name: extractedColumn.name,
        type: extractedColumn.type,
        nullable: extractedColumn.nullable,
        primaryKey: extractedColumn.primaryKey,
        descriptions: descriptionFromDbComment(extractedColumn.dbComment),
        parentColumnId: null,
        embedding: null,
        sampleValues: null,
        cardinality: null,
      });
      continue;
    }

    const typeChanged = currentColumn.type !== extractedColumn.type;
    const nullableChanged = currentColumn.nullable !== extractedColumn.nullable;
    const primaryKeyChanged = currentColumn.primaryKey !== extractedColumn.primaryKey;
    const dbDescriptionChanged = (currentColumn.descriptions.db ?? null) !== (extractedColumn.dbComment ?? null);

    if (typeChanged || nullableChanged || primaryKeyChanged || dbDescriptionChanged) {
      operations.touchColumnIds.push(currentColumn.id);
      columnsModified++;

      if (typeChanged || dbDescriptionChanged) {
        operations.invalidateColumnEmbeddingIds.push(currentColumn.id);
      }

      if (typeChanged) {
        columnsWithTypeChange.push(currentColumn.id);
        const affectedLinks = currentLinks.filter(
          (link) =>
            link.source === 'inferred' &&
            (link.fromColumnId === currentColumn.id || link.toColumnId === currentColumn.id),
        );
        for (const link of affectedLinks) {
          if (!inferredLinksToValidate.includes(link.id)) {
            inferredLinksToValidate.push(link.id);
          }
        }
      }

      if (dbDescriptionChanged) {
        columnsWithDescriptionChange.push(currentColumn.id);
      }
    }

    updatedColumns.push({
      ...currentColumn,
      type: extractedColumn.type,
      nullable: extractedColumn.nullable,
      primaryKey: extractedColumn.primaryKey,
      descriptions: updateDescription(currentColumn.descriptions, extractedColumn.dbComment, dbDescriptionChanged),
      embedding: typeChanged ? null : currentColumn.embedding,
    });
  }

  return {
    table: {
      ...currentTable,
      descriptions: updateDescription(currentTable.descriptions, extractedTable.dbComment, tableDescriptionChanged),
      columns: updatedColumns,
    },
    columnsCreated,
    columnsDeleted,
    columnsModified,
    newColumnIds,
    columnsWithTypeChange,
    columnsWithDescriptionChange,
    tableDescriptionChanged,
  };
}

function planCreatedTable(args: {
  connectionId: string;
  extractedTable: LiveDatabaseExtractedTable;
  operations: LiveDatabaseStructuralSyncOperations;
  idFactory: () => string;
}): LiveDatabaseSyncedTable {
  const { connectionId, extractedTable, operations, idFactory } = args;
  const tableId = idFactory();
  operations.insertTables.push({
    id: tableId,
    connectionId,
    name: extractedTable.name,
    catalog: extractedTable.catalog,
    db: extractedTable.db,
    enabled: true,
  });

  const columns: LiveDatabaseSyncedColumn[] = extractedTable.columns.map((extractedColumn) => {
    const columnId = idFactory();
    operations.insertColumns.push({
      id: columnId,
      tableId,
      name: extractedColumn.name,
      parentColumnId: null,
    });
    return {
      id: columnId,
      name: extractedColumn.name,
      type: extractedColumn.type,
      nullable: extractedColumn.nullable,
      primaryKey: extractedColumn.primaryKey,
      descriptions: descriptionFromDbComment(extractedColumn.dbComment),
      parentColumnId: null,
      embedding: null,
      sampleValues: null,
      cardinality: null,
    };
  });

  return {
    id: tableId,
    name: extractedTable.name,
    catalog: extractedTable.catalog,
    db: extractedTable.db,
    enabled: true,
    descriptions: descriptionFromDbComment(extractedTable.dbComment),
    columns,
  };
}

function syncFormalLinks(args: {
  extracted: LiveDatabaseExtractedSchema;
  tables: LiveDatabaseSyncedTable[];
  tableNaturalKeyToId: Map<string, string>;
  currentLinks: LiveDatabaseSyncedLink[];
  idFactory: () => string;
}): { links: LiveDatabaseSyncedLink[]; created: number; deleted: number } {
  const { extracted, tables, tableNaturalKeyToId, currentLinks, idFactory } = args;
  const columnKeyToId = new Map<string, string>();

  for (const table of tables) {
    const tableKey = buildLiveDatabaseTableNaturalKey(table);
    for (const column of table.columns) {
      columnKeyToId.set(`${tableKey}.${column.name}`, column.id);
    }
  }

  const extractedFormalLinks: Array<{
    fromTableId: string;
    fromColumnId: string;
    toTableId: string;
    toColumnId: string;
  }> = [];

  for (const table of extracted.tables) {
    const fromTableKey = buildLiveDatabaseTableNaturalKey(table);
    const fromTableId = tableNaturalKeyToId.get(fromTableKey);
    if (!fromTableId) {
      continue;
    }

    for (const foreignKey of table.foreignKeys) {
      const toTableKey = buildLiveDatabaseTableNaturalKey({
        catalog: table.catalog,
        db: table.db,
        name: foreignKey.toTable,
      });
      const toTableId = tableNaturalKeyToId.get(toTableKey);
      if (!toTableId) {
        continue;
      }

      const fromColumnId = columnKeyToId.get(`${fromTableKey}.${foreignKey.fromColumn}`);
      const toColumnId = columnKeyToId.get(`${toTableKey}.${foreignKey.toColumn}`);
      if (!fromColumnId || !toColumnId) {
        continue;
      }

      extractedFormalLinks.push({ fromTableId, fromColumnId, toTableId, toColumnId });
    }
  }

  const currentFormalLinks = currentLinks.filter((link) => link.source === 'formal');
  const extractedLinkKeys = new Set(extractedFormalLinks.map((link) => `${link.fromColumnId}->${link.toColumnId}`));
  const linksToDelete = currentFormalLinks.filter(
    (link) => !extractedLinkKeys.has(`${link.fromColumnId}->${link.toColumnId}`),
  );

  const currentLinkKeys = new Set(currentFormalLinks.map((link) => `${link.fromColumnId}->${link.toColumnId}`));
  const linksToCreate = extractedFormalLinks.filter(
    (link) => !currentLinkKeys.has(`${link.fromColumnId}->${link.toColumnId}`),
  );

  const newLinks = linksToCreate.map((linkData) => ({
    id: idFactory(),
    fromTableId: linkData.fromTableId,
    fromColumnId: linkData.fromColumnId,
    toTableId: linkData.toTableId,
    toColumnId: linkData.toColumnId,
    source: 'formal' as const,
    confidence: 1,
    relationshipType: 'MANY_TO_ONE',
    isPrimaryKeyReference: true,
  }));

  const deletedLinkIds = new Set(linksToDelete.map((link) => link.id));
  const preservedFormalLinks = currentFormalLinks.filter((link) => !deletedLinkIds.has(link.id));

  return {
    links: [...preservedFormalLinks, ...newLinks],
    created: linksToCreate.length,
    deleted: linksToDelete.length,
  };
}

export function planLiveDatabaseStructuralSync(
  input: PlanLiveDatabaseStructuralSyncInput,
): LiveDatabaseStructuralSyncPlan {
  const operations: LiveDatabaseStructuralSyncOperations = {
    deleteTableIds: [],
    deleteColumnIds: [],
    insertTables: [],
    insertColumns: [],
    touchColumnIds: [],
    invalidateColumnEmbeddingIds: [],
  };
  const stats: LiveDatabaseStructuralSyncStats = {
    tablesCreated: 0,
    tablesDeleted: 0,
    columnsCreated: 0,
    columnsDeleted: 0,
    columnsModified: 0,
    formalLinksCreated: 0,
    formalLinksDeleted: 0,
  };
  const changes: LiveDatabaseStructuralChanges = {
    newTableIds: [],
    newColumnIds: [],
    tablesWithStructuralChanges: [],
    columnsWithTypeChange: [],
    columnsWithDescriptionChange: [],
    tablesWithDescriptionChange: [],
  };
  const inferredLinksToValidate: string[] = [];

  const currentTablesByKey = new Map<string, LiveDatabaseSyncedTable>();
  const extractedTablesByKey = new Map<string, LiveDatabaseExtractedTable>();

  if (input.current) {
    for (const table of input.current.tables) {
      currentTablesByKey.set(buildLiveDatabaseTableNaturalKey(table), table);
    }
  }
  for (const table of input.extracted.tables) {
    extractedTablesByKey.set(buildLiveDatabaseTableNaturalKey(table), table);
  }

  const tablesToDelete: LiveDatabaseSyncedTable[] = [];
  const tablesToUpdate: Array<{
    current: LiveDatabaseSyncedTable;
    extracted: LiveDatabaseExtractedTable;
  }> = [];
  const tablesToCreate: LiveDatabaseExtractedTable[] = [];

  for (const [key, table] of currentTablesByKey) {
    const extractedTable = extractedTablesByKey.get(key);
    if (!extractedTable) {
      tablesToDelete.push(table);
    } else {
      tablesToUpdate.push({ current: table, extracted: extractedTable });
    }
  }

  for (const [key, table] of extractedTablesByKey) {
    if (!currentTablesByKey.has(key)) {
      tablesToCreate.push(table);
    }
  }

  for (const table of tablesToDelete) {
    operations.deleteTableIds.push(table.id);
    stats.tablesDeleted++;
    stats.columnsDeleted += table.columns.length;
  }

  const updatedTables: LiveDatabaseSyncedTable[] = [];
  for (const { current, extracted } of tablesToUpdate) {
    const result = planUpdatedTable({
      currentTable: current,
      extractedTable: extracted,
      currentLinks: input.current?.links ?? [],
      inferredLinksToValidate,
      operations,
      idFactory: input.idFactory,
    });
    updatedTables.push(result.table);
    stats.columnsCreated += result.columnsCreated;
    stats.columnsDeleted += result.columnsDeleted;
    stats.columnsModified += result.columnsModified;
    changes.newColumnIds.push(...result.newColumnIds);
    changes.columnsWithTypeChange.push(...result.columnsWithTypeChange);
    changes.columnsWithDescriptionChange.push(...result.columnsWithDescriptionChange);
    if (result.tableDescriptionChanged) {
      changes.tablesWithDescriptionChange.push(current.id);
    }
    if (result.columnsCreated > 0 || result.columnsDeleted > 0 || result.columnsWithTypeChange.length > 0) {
      changes.tablesWithStructuralChanges.push(current.id);
    }
  }

  const createdTables: LiveDatabaseSyncedTable[] = [];
  for (const extractedTable of tablesToCreate) {
    const table = planCreatedTable({
      connectionId: input.connectionId,
      extractedTable,
      operations,
      idFactory: input.idFactory,
    });
    createdTables.push(table);
    stats.tablesCreated++;
    stats.columnsCreated += table.columns.length;
    changes.newTableIds.push(table.id);
    changes.newColumnIds.push(...table.columns.map((column) => column.id));
    changes.tablesWithStructuralChanges.push(table.id);
  }

  const allTables = [...updatedTables, ...createdTables];
  const tableNaturalKeyToId = new Map<string, string>();
  for (const table of allTables) {
    tableNaturalKeyToId.set(buildLiveDatabaseTableNaturalKey(table), table.id);
  }

  const formalLinkResult = syncFormalLinks({
    extracted: input.extracted,
    tables: allTables,
    tableNaturalKeyToId,
    currentLinks: input.current?.links ?? [],
    idFactory: input.idFactory,
  });
  stats.formalLinksCreated = formalLinkResult.created;
  stats.formalLinksDeleted = formalLinkResult.deleted;

  const deletedTableIds = new Set(tablesToDelete.map((table) => table.id));
  const preservedInferredLinks = (input.current?.links ?? []).filter(
    (link) =>
      link.source === 'inferred' && !deletedTableIds.has(link.fromTableId) && !deletedTableIds.has(link.toTableId),
  );

  return {
    schema: {
      connectionId: input.connectionId,
      tables: allTables,
      links: [...formalLinkResult.links, ...preservedInferredLinks],
    },
    inferredLinksToValidate,
    stats,
    changes,
    operations,
  };
}
