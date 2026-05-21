import type { KtxJoinUpdate } from '../../../scan/enrichment-types.js';
import type { DbtHostTableLite } from './match-tables.js';
import type { DbtSchemaParseResult } from './parse-schema.js';

export interface DbtRelationshipUpdates {
  joins: KtxJoinUpdate[];
  skippedNoMatch: number;
}

const DBT_SYSTEM_EMAIL = ['system@kae', 'lio.dev'].join('');

export function toRelationshipUpdates(input: {
  connectionId: string;
  parseResult: DbtSchemaParseResult;
  hostTables: DbtHostTableLite[];
}): DbtRelationshipUpdates {
  const tablesByName = new Map<string, DbtHostTableLite>();
  for (const table of input.hostTables) {
    tablesByName.set(table.name.toLowerCase(), table);
  }

  const joins: KtxJoinUpdate[] = [];
  let skippedNoMatch = 0;

  for (const relationship of input.parseResult.relationships) {
    const fromTable = tablesByName.get(relationship.fromTable.toLowerCase());
    const toTable = tablesByName.get(relationship.toTable.toLowerCase());
    if (!fromTable || !toTable) {
      skippedNoMatch++;
      continue;
    }

    const fromColumn = fromTable.columns.find(
      (column) => column.name.toLowerCase() === relationship.fromColumn.toLowerCase(),
    );
    const toColumn = toTable.columns.find(
      (column) => column.name.toLowerCase() === relationship.toColumn.toLowerCase(),
    );
    if (!fromColumn || !toColumn) {
      skippedNoMatch++;
      continue;
    }

    joins.push({
      connectionId: input.connectionId,
      fromTable: fromTable.name,
      fromColumns: [fromColumn.name],
      toTable: toTable.name,
      toColumns: [toColumn.name],
      relationship: 'many_to_one',
      author: 'dbt',
      authorEmail: DBT_SYSTEM_EMAIL,
    });
  }

  return { joins, skippedNoMatch };
}
