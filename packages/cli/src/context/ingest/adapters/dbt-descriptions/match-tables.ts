import type { DbtParsedTable } from './parse-schema.js';

export interface DbtHostTableLite {
  id: string;
  name: string;
  catalog: string | null;
  db: string | null;
  columns: Array<{ id: string; name: string }>;
}

export interface DbtTableMatch {
  dbtTable: string;
  dbtSchema: string | null;
  dbtDatabase: string | null;
  hostTableId: string | null;
  hostTableName: string | null;
  matched: boolean;
  tableDescriptionAction: 'skip' | 'import';
  tableDescriptionFound: boolean;
  columnsToImport: number;
  columnsMatched: number;
  columnsTotal: number;
  columnDescriptionsFound: number;
}

export function matchDbtTables(
  dbtTables: DbtParsedTable[],
  hostTables: DbtHostTableLite[],
  targetSchema?: string | null,
): DbtTableMatch[] {
  return dbtTables.map((dbtTable) => {
    const hostTable = findMatchingKtxTable(dbtTable, hostTables, targetSchema);

    if (!hostTable) {
      return {
        dbtTable: dbtTable.name,
        dbtSchema: dbtTable.schema,
        dbtDatabase: dbtTable.database,
        hostTableId: null,
        hostTableName: null,
        matched: false,
        tableDescriptionAction: 'skip',
        tableDescriptionFound: Boolean(dbtTable.description),
        columnsToImport: 0,
        columnsMatched: 0,
        columnsTotal: dbtTable.columns.length,
        columnDescriptionsFound: dbtTable.columns.filter((column) => Boolean(column.description)).length,
      };
    }

    const analysis = analyzeColumns(dbtTable, hostTable);
    return {
      dbtTable: dbtTable.name,
      dbtSchema: dbtTable.schema,
      dbtDatabase: dbtTable.database,
      hostTableId: hostTable.id,
      hostTableName: hostTable.name,
      matched: true,
      tableDescriptionAction: dbtTable.description ? 'import' : 'skip',
      tableDescriptionFound: Boolean(dbtTable.description),
      ...analysis,
    };
  });
}

export function findMatchingKtxTable(
  dbtTable: DbtParsedTable,
  hostTables: DbtHostTableLite[],
  targetSchema?: string | null,
): DbtHostTableLite | undefined {
  const dbtName = dbtTable.name.toLowerCase();
  const effectiveSchema = dbtTable.schema ?? targetSchema ?? null;

  if (effectiveSchema) {
    const strictMatch = hostTables.find((table) => {
      const nameMatches = table.name.toLowerCase() === dbtName;
      const schemaMatches = table.db?.toLowerCase() === effectiveSchema.toLowerCase();
      if (!nameMatches || !schemaMatches) {
        return false;
      }
      if (dbtTable.database && table.catalog) {
        return table.catalog.toLowerCase() === dbtTable.database.toLowerCase();
      }
      return true;
    });
    if (strictMatch) {
      return strictMatch;
    }
  }

  if (dbtTable.resourceType === 'source') {
    return undefined;
  }

  const nameMatches = hostTables.filter((table) => table.name.toLowerCase() === dbtName);
  return nameMatches.length === 1 ? nameMatches[0] : undefined;
}

function analyzeColumns(
  dbtTable: DbtParsedTable,
  hostTable: DbtHostTableLite,
): Pick<DbtTableMatch, 'columnsToImport' | 'columnsMatched' | 'columnsTotal' | 'columnDescriptionsFound'> {
  let columnsToImport = 0;
  let columnsMatched = 0;
  let columnDescriptionsFound = 0;

  for (const dbtColumn of dbtTable.columns) {
    const hostColumn = hostTable.columns.find(
      (column) => column.name.toLowerCase() === dbtColumn.name.toLowerCase(),
    );
    if (!hostColumn) {
      continue;
    }
    columnsMatched++;
    if (dbtColumn.description) {
      columnDescriptionsFound++;
      columnsToImport++;
    }
  }

  return {
    columnsToImport,
    columnsMatched,
    columnsTotal: dbtTable.columns.length,
    columnDescriptionsFound,
  };
}
