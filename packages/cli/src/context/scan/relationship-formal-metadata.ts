import type { KtxEnrichedRelationship, KtxEnrichedSchema, KtxSkippedRelationship } from './enrichment-types.js';

export interface KtxFormalMetadataRelationshipCollection {
  accepted: KtxEnrichedRelationship[];
  skipped: KtxSkippedRelationship[];
  acceptedIds: Set<string>;
}

function relationshipEndpointExists(schema: KtxEnrichedSchema, relationship: KtxEnrichedRelationship): boolean {
  const fromTable = schema.tables.find((table) => table.id === relationship.from.tableId && table.enabled);
  const toTable = schema.tables.find((table) => table.id === relationship.to.tableId && table.enabled);
  const fromColumn = fromTable?.columns.some(
    (column) => relationship.from.columnIds.includes(column.id) && relationship.from.columns.includes(column.name),
  );
  const toColumn = toTable?.columns.some(
    (column) => relationship.to.columnIds.includes(column.id) && relationship.to.columns.includes(column.name),
  );
  return Boolean(fromTable && toTable && fromColumn && toColumn);
}

export function collectKtxFormalMetadataRelationships(
  schema: KtxEnrichedSchema,
): KtxFormalMetadataRelationshipCollection {
  const accepted: KtxEnrichedRelationship[] = [];
  const skipped: KtxSkippedRelationship[] = [];
  const acceptedIds = new Set<string>();

  for (const relationship of schema.relationships) {
    if (relationship.source !== 'formal') {
      continue;
    }
    if (acceptedIds.has(relationship.id)) {
      skipped.push({
        relationshipId: relationship.id,
        reason: 'formal_metadata_duplicate',
      });
      continue;
    }
    if (!relationshipEndpointExists(schema, relationship)) {
      skipped.push({
        relationshipId: relationship.id,
        reason: 'formal_metadata_endpoint_not_found',
      });
      continue;
    }

    acceptedIds.add(relationship.id);
    accepted.push({
      ...relationship,
      source: 'formal',
      confidence: 1,
      isPrimaryKeyReference: true,
    });
  }

  return {
    accepted: accepted.sort((left, right) => left.id.localeCompare(right.id)),
    skipped,
    acceptedIds,
  };
}
