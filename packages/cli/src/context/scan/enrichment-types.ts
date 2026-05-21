import type { KtxSchemaDimensionType, KtxTableRef } from './types.js';

type KtxDescriptionSource = 'ai' | 'db' | 'dbt' | 'user' | (string & {});

type KtxRelationshipSource = 'formal' | 'inferred' | 'manual';

export type KtxRelationshipType = 'many_to_one' | 'one_to_many' | 'one_to_one';

export interface KtxEnrichedColumn {
  id: string;
  tableId: string;
  tableRef: KtxTableRef;
  name: string;
  nativeType: string;
  normalizedType: string;
  dimensionType: KtxSchemaDimensionType;
  nullable: boolean;
  primaryKey: boolean;
  parentColumnId: string | null;
  descriptions: Partial<Record<KtxDescriptionSource, string>>;
  embedding: number[] | null;
  sampleValues: string[] | null;
  cardinality: number | null;
}

export interface KtxEnrichedTable {
  id: string;
  ref: KtxTableRef;
  enabled: boolean;
  descriptions: Partial<Record<KtxDescriptionSource, string>>;
  columns: KtxEnrichedColumn[];
}

export interface KtxRelationshipEndpoint {
  tableId: string;
  columnIds: string[];
  table: KtxTableRef;
  columns: string[];
}

export interface KtxEnrichedRelationship {
  id: string;
  source: KtxRelationshipSource;
  from: KtxRelationshipEndpoint;
  to: KtxRelationshipEndpoint;
  relationshipType: KtxRelationshipType;
  confidence: number;
  isPrimaryKeyReference: boolean;
}

export interface KtxEnrichedSchema {
  connectionId: string;
  tables: KtxEnrichedTable[];
  relationships: KtxEnrichedRelationship[];
}

/** @internal */
export interface KtxStructuralSyncPlan {
  connectionId: string;
  snapshotId: string;
  operations: Array<Record<string, unknown>>;
}

/** @internal */
export interface KtxDescriptionUpdate {
  connectionId: string;
  table: KtxTableRef;
  source: KtxDescriptionSource;
  tableDescription?: string;
  columnDescriptions?: Record<string, string | null>;
}


/** @internal */
export interface KtxJoinUpdate {
  connectionId: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  relationship: KtxRelationshipType;
  author: string;
  authorEmail: string;
}

/** @internal */
export interface KtxColumnSampleUpdate {
  columnId: string;
  sampleValues: string[] | null;
  cardinality: number | null;
}

export interface KtxEmbeddingUpdate {
  columnId: string;
  text: string;
  embedding: number[];
}

export interface KtxSkippedRelationship {
  relationshipId: string;
  reason: string;
}

export interface KtxRelationshipUpdate {
  connectionId: string;
  accepted: KtxEnrichedRelationship[];
  rejected: KtxEnrichedRelationship[];
  skipped: KtxSkippedRelationship[];
}

/** @internal */
export interface KtxScanMetadataStore {
  loadSchema(connectionId: string): Promise<KtxEnrichedSchema | null>;
  applyStructuralPlan(plan: KtxStructuralSyncPlan): Promise<KtxEnrichedSchema>;
  updateDescriptions(input: KtxDescriptionUpdate): Promise<void>;
  updateColumnSamples(input: KtxColumnSampleUpdate[]): Promise<void>;
  updateColumnEmbeddings(input: KtxEmbeddingUpdate[]): Promise<void>;
  updateInferredRelationships(input: KtxRelationshipUpdate): Promise<void>;
}
