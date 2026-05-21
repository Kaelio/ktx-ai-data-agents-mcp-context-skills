import type { ParsedSemanticModel } from '../metricflow/deep-parse.js';
import type { DbtSchemaParseResult } from './parse-schema.js';

export function mergeSemanticModelTables(
  parseResult: DbtSchemaParseResult,
  semanticModels: ParsedSemanticModel[],
): DbtSchemaParseResult {
  const merged: DbtSchemaParseResult = {
    ...parseResult,
    tables: [...parseResult.tables],
    relationships: [...parseResult.relationships],
  };
  const existingTableNames = new Set(merged.tables.map((table) => table.name.toLowerCase()));

  for (const model of semanticModels) {
    const tableName = model.modelRef;
    if (existingTableNames.has(tableName.toLowerCase())) {
      continue;
    }

    merged.tables.push({
      name: tableName,
      description: model.description,
      database: null,
      schema: null,
      columns: model.dimensions.map((dimension) => ({
        name: dimension.column,
        description: dimension.description ?? null,
        dataType: dimension.type === 'time' ? 'TIMESTAMP' : null,
      })),
      resourceType: 'model',
    });
    existingTableNames.add(tableName.toLowerCase());
  }

  return merged;
}
