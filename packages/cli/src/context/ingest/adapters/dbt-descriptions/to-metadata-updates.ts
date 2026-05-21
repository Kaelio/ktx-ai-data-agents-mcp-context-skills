import type { KtxMetadataUpdate } from '../../../scan/enrichment-types.js';
import { findMatchingKtxTable, type DbtHostTableLite } from './match-tables.js';
import type { DbtSchemaParseResult } from './parse-schema.js';

export function toMetadataUpdates(input: {
  connectionId: string;
  parseResult: DbtSchemaParseResult;
  hostTables: DbtHostTableLite[];
  targetSchema: string | null;
}): KtxMetadataUpdate[] {
  const updates: KtxMetadataUpdate[] = [];

  for (const dbtTable of input.parseResult.tables) {
    const hostTable = findMatchingKtxTable(dbtTable, input.hostTables, input.targetSchema);
    if (!hostTable) {
      continue;
    }

    const tableFields: Record<string, unknown> = {};
    if (dbtTable.tagsDbt?.length) {
      tableFields.tags = dbtTable.tagsDbt;
    }
    if (dbtTable.freshnessDbt) {
      tableFields.freshness = {
        ...(dbtTable.freshnessDbt.raw !== undefined ? { raw: dbtTable.freshnessDbt.raw } : {}),
        ...(dbtTable.freshnessDbt.loadedAtField !== undefined
          ? { loaded_at_field: dbtTable.freshnessDbt.loadedAtField }
          : {}),
      };
    }

    const columnFields: Record<string, Record<string, unknown>> = {};
    for (const dbtColumn of dbtTable.columns) {
      const hostColumn = hostTable.columns.find(
        (column) => column.name.toLowerCase() === dbtColumn.name.toLowerCase(),
      );
      if (!hostColumn) {
        continue;
      }

      const fields: Record<string, unknown> = {};
      if (dbtColumn.constraints) {
        fields.constraints = dbtColumn.constraints.dbt;
      }
      if (dbtColumn.enumValuesDbt?.length) {
        fields.enum_values = dbtColumn.enumValuesDbt;
      }
      if (dbtColumn.dataTests?.length) {
        fields.tests = dbtColumn.dataTests.map((test) => ({
          name: test.name,
          package: test.package,
          ...(test.kwargs ? { kwargs: test.kwargs } : {}),
        }));
      }
      if (Object.keys(fields).length > 0) {
        columnFields[hostColumn.name] = fields;
      }
    }

    if (Object.keys(tableFields).length === 0 && Object.keys(columnFields).length === 0) {
      continue;
    }

    updates.push({
      connectionId: input.connectionId,
      table: { catalog: hostTable.catalog, db: hostTable.db, name: hostTable.name },
      source: 'dbt',
      ...(Object.keys(tableFields).length > 0 ? { tableFields } : {}),
      ...(Object.keys(columnFields).length > 0 ? { columnFields } : {}),
    });
  }

  return updates;
}
