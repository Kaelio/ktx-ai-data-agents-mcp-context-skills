import type { SemanticLayerSource } from '../../../sl/index.js';
import type {
  ParsedCrossModelMetric,
  ParsedMetricflowRelationship,
  ParsedSemanticModel,
} from './deep-parse.js';

export interface MetricflowHostTable {
  id: string;
  name: string;
  catalog: string | null;
  db: string | null;
  columns: Array<{ id: string; name: string }>;
}

export interface MetricflowSemanticModelImportContext {
  model: ParsedSemanticModel;
  matchedTable: MetricflowHostTable | undefined;
  sourceName: string;
  manifestSource: SemanticLayerSource | null;
}

export type MetricflowSemanticModelJoin = SemanticLayerSource['joins'][number];

export type MetricflowWritableSemanticLayerSource = Pick<SemanticLayerSource, 'name'> &
  Partial<Omit<SemanticLayerSource, 'name'>>;

export function toKebabCaseMetricflowName(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function mapSemanticModelToSource(model: ParsedSemanticModel, tableRef?: string): SemanticLayerSource {
  return {
    name: toKebabCaseMetricflowName(model.modelRef),
    table: tableRef ?? model.modelRef,
    grain: model.dimensions.map((d) => d.column),
    columns: model.dimensions.map((d) => ({
      name: d.column,
      type: d.type,
      ...(d.description ? { description: d.description } : {}),
    })),
    measures: model.measures.map((m) => {
      if (m.type === 'simple') {
        return {
          name: m.name,
          expr: `${m.aggregation}(${m.column})`,
          ...(m.description ? { description: m.description } : {}),
          ...(m.filter ? { filter: m.filter } : {}),
        };
      }
      return {
        name: m.name,
        expr: m.expr,
        ...(m.description ? { description: m.description } : {}),
      };
    }),
    joins: [],
    descriptions: { dbt: model.description ?? model.modelRef },
  };
}

export function mapCrossModelMetricToSource(metric: ParsedCrossModelMetric): SemanticLayerSource {
  return {
    name: toKebabCaseMetricflowName(metric.name),
    sql: metric.expr,
    descriptions: { dbt: metric.description ?? metric.name },
    grain: [],
    columns: [],
    measures: [
      {
        name: metric.name,
        expr: metric.expr,
        ...(metric.description ? { description: metric.description } : {}),
        ...(metric.filter ? { filter: metric.filter } : {}),
      },
    ],
    joins: [],
  };
}

export function findMatchingMetricflowTable(
  modelRef: string,
  hostTables: MetricflowHostTable[],
  targetSchema?: string | null,
): MetricflowHostTable | undefined {
  const ref = modelRef.toLowerCase();

  if (targetSchema) {
    const schemaMatch = hostTables.find(
      (table) => table.name.toLowerCase() === ref && table.db?.toLowerCase() === targetSchema.toLowerCase(),
    );
    if (schemaMatch) {
      return schemaMatch;
    }
  }

  const nameMatches = hostTables.filter((table) => table.name.toLowerCase() === ref);
  if (nameMatches.length === 1) {
    return nameMatches[0];
  }

  const byTablePart = hostTables.filter((table) => {
    const parts = table.name.toLowerCase().split('.');
    return parts[parts.length - 1] === ref;
  });
  if (byTablePart.length === 1) {
    return byTablePart[0];
  }

  const suffixMatches = hostTables.filter(
    (table) => table.name.toLowerCase().endsWith(`.${ref}`) || table.name.toLowerCase().endsWith(`_${ref}`),
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }

  return undefined;
}

export function resolveMetricflowSemanticModelSourceName(
  model: ParsedSemanticModel,
  matchedTable: MetricflowHostTable | undefined,
): string {
  const candidate = matchedTable?.name ?? model.modelRef;
  const bare = candidate.includes('.') ? (candidate.split('.').pop() ?? candidate) : candidate;
  return toSnakeCaseIdentifier(bare) || toSnakeCaseIdentifier(model.modelRef);
}

export function buildMetricflowJoinsForModel(
  model: ParsedSemanticModel,
  relationships: ParsedMetricflowRelationship[],
  sourceNameByModelRef: Map<string, string>,
  availableTargetModelRefs?: Set<string>,
): MetricflowSemanticModelJoin[] {
  const fromSourceName = sourceNameByModelRef.get(model.modelRef);
  if (!fromSourceName) {
    return [];
  }

  const joins: MetricflowSemanticModelJoin[] = [];
  for (const relationship of relationships) {
    if (relationship.fromTable !== model.modelRef) {
      continue;
    }
    if (availableTargetModelRefs && !availableTargetModelRefs.has(relationship.toTable)) {
      continue;
    }
    const toSourceName = sourceNameByModelRef.get(relationship.toTable);
    if (!toSourceName) {
      continue;
    }
    joins.push({
      to: toSourceName,
      on: `${fromSourceName}.${relationship.fromColumn} = ${toSourceName}.${relationship.toColumn}`,
      relationship: 'many_to_one',
    });
  }
  return joins;
}

export function buildMetricflowSemanticModelSource(
  context: MetricflowSemanticModelImportContext,
  joins: MetricflowSemanticModelJoin[],
  sourceNameByManifestName: Map<string, string>,
): MetricflowWritableSemanticLayerSource {
  const { model, sourceName, manifestSource, matchedTable } = context;

  if (manifestSource?.name === sourceName) {
    return mapMetricflowSemanticModelToOverlay(model, sourceName, joins);
  }
  if (manifestSource) {
    return mapMetricflowSemanticModelToMergedStandalone(model, sourceName, manifestSource, joins, sourceNameByManifestName);
  }
  return mapMetricflowSemanticModelToStandalone(model, sourceName, matchedTable?.name ?? model.modelRef, joins);
}

export function buildMetricflowMeasures(model: ParsedSemanticModel): SemanticLayerSource['measures'] {
  return model.measures.map((measure) => {
    if (measure.type === 'simple') {
      return {
        name: measure.name,
        expr: `${measure.aggregation}(${measure.column})`,
        ...(measure.description ? { description: measure.description } : {}),
        ...(measure.filter ? { filter: measure.filter } : {}),
      };
    }
    return {
      name: measure.name,
      expr: measure.expr,
      ...(measure.description ? { description: measure.description } : {}),
    };
  });
}

export function buildMetricflowColumns(model: ParsedSemanticModel): SemanticLayerSource['columns'] {
  const columns: SemanticLayerSource['columns'] = model.dimensions.map((dimension) => ({
    name: dimension.column,
    type: dimension.type,
    ...(dimension.description ? { description: dimension.description } : {}),
  }));
  const existingNames = new Set(columns.map((column) => column.name.toLowerCase()));

  for (const entity of model.entities) {
    const columnName = (entity.expr ?? entity.name)?.trim();
    if (!columnName) {
      continue;
    }
    const normalizedName = columnName.toLowerCase();
    if (existingNames.has(normalizedName)) {
      continue;
    }
    columns.push({
      name: columnName,
      type: 'string',
      visibility: 'hidden',
      ...(entity.description ? { description: entity.description } : {}),
    });
    existingNames.add(normalizedName);
  }

  return columns;
}

export function filterValidMetricflowRelationships(
  relationships: ParsedMetricflowRelationship[],
  availableColumnNamesByModelRef: Map<string, Set<string>>,
): ParsedMetricflowRelationship[] {
  return relationships.filter((relationship) => {
    const fromColumns = availableColumnNamesByModelRef.get(relationship.fromTable);
    const toColumns = availableColumnNamesByModelRef.get(relationship.toTable);
    if (!fromColumns || !toColumns) {
      return false;
    }
    return fromColumns.has(relationship.fromColumn.toLowerCase()) && toColumns.has(relationship.toColumn.toLowerCase());
  });
}

export function getMetricflowAvailableColumnNames(context: MetricflowSemanticModelImportContext): Set<string> {
  const columns = context.manifestSource?.columns ?? buildMetricflowColumns(context.model);
  return new Set(columns.map((column) => column.name.toLowerCase()));
}

export function countImportableMetricflowRelationships(
  relationships: ParsedMetricflowRelationship[],
  hostTables: MetricflowHostTable[],
): number {
  const tablesByName = new Map<string, MetricflowHostTable>();
  for (const table of hostTables) {
    tablesByName.set(table.name.toLowerCase(), table);
  }

  let validCount = 0;
  for (const relationship of relationships) {
    const fromTable = tablesByName.get(relationship.fromTable.toLowerCase());
    const toTable = tablesByName.get(relationship.toTable.toLowerCase());
    if (!fromTable || !toTable) {
      continue;
    }
    const fromColumn = fromTable.columns.find(
      (column) => column.name.toLowerCase() === relationship.fromColumn.toLowerCase(),
    );
    const toColumn = toTable.columns.find(
      (column) => column.name.toLowerCase() === relationship.toColumn.toLowerCase(),
    );
    if (!fromColumn || !toColumn) {
      continue;
    }
    validCount++;
  }

  return validCount;
}

function mapMetricflowSemanticModelToStandalone(
  model: ParsedSemanticModel,
  sourceName: string,
  tableRef: string,
  joins: MetricflowSemanticModelJoin[],
): MetricflowWritableSemanticLayerSource {
  return {
    name: sourceName,
    table: tableRef,
    grain: model.dimensions.map((dimension) => dimension.column),
    columns: buildMetricflowColumns(model),
    measures: buildMetricflowMeasures(model),
    joins,
    descriptions: { dbt: model.description ?? model.modelRef },
  };
}

function mapMetricflowSemanticModelToMergedStandalone(
  model: ParsedSemanticModel,
  sourceName: string,
  manifestSource: SemanticLayerSource,
  joins: MetricflowSemanticModelJoin[],
  sourceNameByManifestName: Map<string, string>,
): MetricflowWritableSemanticLayerSource {
  const rewrittenManifestJoins = rewriteMetricflowManifestJoins(manifestSource.joins, sourceNameByManifestName);
  return {
    ...manifestSource,
    name: sourceName,
    measures: buildMetricflowMeasures(model),
    joins: mergeMetricflowJoins(rewrittenManifestJoins, joins),
    descriptions: {
      ...(manifestSource.descriptions ?? {}),
      dbt: model.description ?? model.modelRef,
    },
  };
}

function mapMetricflowSemanticModelToOverlay(
  model: ParsedSemanticModel,
  sourceName: string,
  joins: MetricflowSemanticModelJoin[],
): MetricflowWritableSemanticLayerSource {
  const overlay: MetricflowWritableSemanticLayerSource = {
    name: sourceName,
    descriptions: { dbt: model.description ?? model.modelRef },
    measures: buildMetricflowMeasures(model),
  };
  if (joins.length > 0) {
    overlay.joins = joins;
  }
  return overlay;
}

function mergeMetricflowJoins(
  baseJoins: SemanticLayerSource['joins'],
  overlayJoins: MetricflowSemanticModelJoin[],
): SemanticLayerSource['joins'] {
  const existingKeys = new Set(baseJoins.map((join) => `${join.to}::${normalizeMetricflowJoinOn(join.on)}`));
  const newJoins = overlayJoins.filter((join) => !existingKeys.has(`${join.to}::${normalizeMetricflowJoinOn(join.on)}`));
  return [...baseJoins, ...newJoins];
}

export function normalizeMetricflowJoinOn(on: string): string {
  return on.replace(/\s+/g, ' ').trim();
}

export function rewriteMetricflowManifestJoins(
  joins: SemanticLayerSource['joins'],
  sourceNameByManifestName: Map<string, string>,
): SemanticLayerSource['joins'] {
  return joins.map((join) => ({
    ...join,
    to: sourceNameByManifestName.get(join.to) ?? join.to,
    on: rewriteMetricflowJoinOn(join.on, sourceNameByManifestName),
  }));
}

export function rewriteMetricflowJoinOn(on: string, sourceNameByManifestName: Map<string, string>): string {
  const parts = on.split('=');
  if (parts.length !== 2) {
    return on;
  }
  const left = parseMetricflowJoinReference(parts[0].trim());
  const right = parseMetricflowJoinReference(parts[1].trim());
  if (!left || !right) {
    return on;
  }
  const leftTable = sourceNameByManifestName.get(left.table) ?? left.table;
  const rightTable = sourceNameByManifestName.get(right.table) ?? right.table;
  return `${leftTable}.${left.column} = ${rightTable}.${right.column}`;
}

export function parseMetricflowJoinReference(ref: string): { table: string; column: string } | null {
  const lastDot = ref.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === ref.length - 1) {
    return null;
  }
  return {
    table: ref.slice(0, lastDot).trim(),
    column: ref.slice(lastDot + 1).trim(),
  };
}

function toSnakeCaseIdentifier(str: string): string {
  return str
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}
