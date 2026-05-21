import type { KtxDescriptionUpdate } from '../../../scan/enrichment-types.js';
import { findMatchingKtxTable, type DbtHostTableLite } from './match-tables.js';
import type { DbtSchemaParseResult } from './parse-schema.js';

export interface DbtDescriptionUpdates {
  dbt: KtxDescriptionUpdate[];
  aiInvalidations: KtxDescriptionUpdate[];
}

export function toDescriptionUpdates(input: {
  connectionId: string;
  parseResult: DbtSchemaParseResult;
  hostTables: DbtHostTableLite[];
  targetSchema: string | null;
}): DbtDescriptionUpdates {
  const dbt: KtxDescriptionUpdate[] = [];
  const aiInvalidations: KtxDescriptionUpdate[] = [];

  for (const dbtTable of input.parseResult.tables) {
    const hostTable = findMatchingKtxTable(dbtTable, input.hostTables, input.targetSchema);
    if (!hostTable) {
      continue;
    }

    const tableDescription = dbtTable.description ?? undefined;
    const columnDescriptions: Record<string, string | null> = {};

    for (const dbtColumn of dbtTable.columns) {
      if (!dbtColumn.description) {
        continue;
      }
      const hostColumn = hostTable.columns.find(
        (column) => column.name.toLowerCase() === dbtColumn.name.toLowerCase(),
      );
      if (hostColumn) {
        columnDescriptions[hostColumn.name] = dbtColumn.description;
      }
    }

    const hasColumnDescriptions = Object.keys(columnDescriptions).length > 0;
    const hasDescriptionChange = tableDescription !== undefined || hasColumnDescriptions;
    const hasMetadataChange =
      !!dbtTable.tagsDbt?.length ||
      dbtTable.freshnessDbt !== undefined ||
      dbtTable.columns.some(
        (column) => column.constraints !== undefined || !!column.enumValuesDbt?.length || !!column.dataTests?.length,
      );
    if (!hasDescriptionChange && !hasMetadataChange) {
      continue;
    }

    const tableRef = { catalog: hostTable.catalog, db: hostTable.db, name: hostTable.name };
    if (hasDescriptionChange) {
      dbt.push({
        connectionId: input.connectionId,
        table: tableRef,
        source: 'dbt',
        ...(tableDescription !== undefined ? { tableDescription } : {}),
        ...(hasColumnDescriptions ? { columnDescriptions } : {}),
      });
    }
    aiInvalidations.push({
      connectionId: input.connectionId,
      table: tableRef,
      source: 'ai',
    });
  }

  return { dbt, aiInvalidations };
}
