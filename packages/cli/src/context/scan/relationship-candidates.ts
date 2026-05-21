import type {
  KtxEnrichedColumn,
  KtxEnrichedSchema,
  KtxEnrichedTable,
  KtxRelationshipEndpoint,
  KtxRelationshipType,
} from './enrichment-types.js';
import { localCandidateTables } from './relationship-locality.js';
import {
  type KtxRelationshipNormalizedName,
  normalizeKtxRelationshipName,
  pluralizeKtxRelationshipToken,
  singularizeKtxRelationshipToken,
} from './relationship-name-similarity.js';
export type { KtxRelationshipNormalizedName } from './relationship-name-similarity.js';
export { normalizeKtxRelationshipName } from './relationship-name-similarity.js';
import type { KtxRelationshipProfileArtifact } from './relationship-profiling.js';
import {
  scoreKtxRelationshipCandidate,
  type KtxRelationshipScoreBreakdown,
  type KtxRelationshipSignalVector,
} from './relationship-scoring.js';

export type KtxRelationshipDiscoveryCandidateSource =
  | 'exact_column_match'
  | 'normalized_table_match'
  | 'parent_table_name_match'
  | 'inflection'
  | 'self_reference'
  | 'profile_match'
  | 'column_suffix_match'
  | 'embedding_similarity'
  | 'llm_proposal';

export type KtxRelationshipDiscoveryCandidateStatus = 'review';

export interface KtxRelationshipDiscoveryCandidateEvidence {
  sourceColumnBase: string;
  targetTableBase: string;
  targetColumnBase: string;
  targetKeyScore: number;
  nameScore: number;
  reasons: string[];
  signalVector?: KtxRelationshipSignalVector;
  scoreBreakdown?: KtxRelationshipScoreBreakdown;
  embeddingSimilarity?: number;
  llmConfidence?: number;
  llmRationale?: string;
}

export interface KtxRelationshipDiscoveryCandidate {
  id: string;
  from: KtxRelationshipEndpoint;
  to: KtxRelationshipEndpoint;
  relationshipType: KtxRelationshipType;
  confidence: number;
  source: KtxRelationshipDiscoveryCandidateSource;
  status: KtxRelationshipDiscoveryCandidateStatus;
  evidence: KtxRelationshipDiscoveryCandidateEvidence;
}

export interface KtxRelationshipDiscoveryCandidateOptions {
  maxCandidatesPerColumn?: number;
  maxCandidateParentTables?: number;
  maxEmbeddingCandidatesPerColumn?: number;
  minConfidence?: number;
  embeddingSimilarityThreshold?: number;
  useEmbeddings?: boolean;
  profiles?: KtxRelationshipProfileArtifact;
}

export interface KtxRelationshipInferredTargetPk {
  table: string;
  columns: string[];
  score: number;
  status: 'review';
  incomingCandidateCount: number;
}

interface KtxRelationshipSourceColumnReference {
  base: string;
  reason: string;
}

interface KtxRelationshipTargetKeyEvidence {
  score: number;
  reasons: string[];
}

const INTEGER_TYPES = new Set(['integer', 'int', 'bigint', 'smallint', 'tinyint', 'int4', 'int8', 'number']);
const STRING_TYPES = new Set(['text', 'varchar', 'character varying', 'char', 'character', 'string']);
const UUID_TYPES = new Set(['uuid', 'uniqueidentifier']);
const SELF_REFERENCE_NAMES = new Set(['parent_id', 'manager_id', 'reported_to_id', 'supervisor_id', 'reports_to_id']);
const REFERENCE_SUFFIXES: Array<{ suffix: string; reason: string }> = [
  { suffix: '_id', reason: 'foreign_key_suffix' },
  { suffix: '_key', reason: 'foreign_key_key_suffix' },
  { suffix: '_code', reason: 'foreign_key_code_suffix' },
  { suffix: '_uuid', reason: 'foreign_key_uuid_suffix' },
];
const RELATIONSHIP_KEY_TARGET_SUFFIXES = ['_id', '_key', '_code', '_uuid'] as const;
const tableAliasesCache = new WeakMap<KtxEnrichedTable, Set<string>>();
const parentTableNameAliasesCache = new WeakMap<KtxEnrichedTable, Set<string>>();
const normalizedColumnNameCache = new WeakMap<KtxEnrichedColumn, KtxRelationshipNormalizedName>();

function normalizedColumnName(column: KtxEnrichedColumn): KtxRelationshipNormalizedName {
  const cached = normalizedColumnNameCache.get(column);
  if (cached) {
    return cached;
  }
  const normalized = normalizeKtxRelationshipName(column.name);
  normalizedColumnNameCache.set(column, normalized);
  return normalized;
}

function isRelationshipKeyShapedTarget(column: KtxEnrichedColumn): boolean {
  const normalized = normalizedColumnName(column);
  return (
    normalized.tokens.length >= 2 &&
    RELATIONSHIP_KEY_TARGET_SUFFIXES.some((suffix) => normalized.normalized.endsWith(suffix))
  );
}

function columnSuffixMatchesTarget(input: { fromColumn: KtxEnrichedColumn; toColumn: KtxEnrichedColumn }): boolean {
  const source = normalizedColumnName(input.fromColumn).normalized;
  const target = normalizedColumnName(input.toColumn).normalized;
  return source !== target && target.length > 0 && source.endsWith(`_${target}`);
}

function normalizeType(column: KtxEnrichedColumn): string {
  const rawType = (column.normalizedType || column.nativeType || '').toLowerCase().trim();
  return rawType.includes('(') ? (rawType.split('(')[0] ?? '') : rawType;
}

function typesCompatible(left: KtxEnrichedColumn, right: KtxEnrichedColumn): boolean {
  const leftType = normalizeType(left);
  const rightType = normalizeType(right);
  if (leftType === rightType) {
    return true;
  }
  if (INTEGER_TYPES.has(leftType) && INTEGER_TYPES.has(rightType)) {
    return true;
  }
  if (STRING_TYPES.has(leftType) && STRING_TYPES.has(rightType)) {
    return true;
  }
  return UUID_TYPES.has(leftType) && UUID_TYPES.has(rightType);
}

function cosineSimilarity(left: readonly number[] | null, right: readonly number[] | null): number {
  if (!left || !right || left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function hasUsableEmbedding(column: KtxEnrichedColumn): boolean {
  return Array.isArray(column.embedding) && column.embedding.length > 0;
}

function sourceColumnReference(column: KtxEnrichedColumn): KtxRelationshipSourceColumnReference | null {
  const normalized = normalizedColumnName(column);
  if (SELF_REFERENCE_NAMES.has(normalized.normalized)) {
    return { base: normalized.normalized.replace(/_id$/u, ''), reason: 'foreign_key_suffix' };
  }

  for (const item of REFERENCE_SUFFIXES) {
    if (!normalized.normalized.endsWith(item.suffix)) {
      continue;
    }
    const base = normalized.normalized.slice(0, -item.suffix.length);
    if (base.length > 1) {
      return { base: singularizeKtxRelationshipToken(base), reason: item.reason };
    }
  }

  return null;
}

function addNormalizedTableAlias(aliases: Set<string>, name: string): void {
  const normalized = normalizeKtxRelationshipName(name);
  if (normalized.normalized.length > 0) {
    aliases.add(normalized.normalized);
  }
  if (normalized.singular.length > 0) {
    aliases.add(normalized.singular);
  }
  if (normalized.plural.length > 0) {
    aliases.add(normalized.plural);
  }
}

function tableAliases(table: KtxEnrichedTable): Set<string> {
  const cached = tableAliasesCache.get(table);
  if (cached) {
    return cached;
  }

  const normalized = normalizeKtxRelationshipName(table.ref.name);
  const aliases = new Set([normalized.normalized, normalized.singular, normalized.plural]);
  if (normalized.tokens.length > 1) {
    const lastToken = normalized.tokens[normalized.tokens.length - 1];
    if (lastToken) {
      aliases.add(lastToken);
      const singularLastToken = singularizeKtxRelationshipToken(lastToken);
      aliases.add(singularLastToken);
      aliases.add(pluralizeKtxRelationshipToken(singularLastToken));
    }
  }
  tableAliasesCache.set(table, aliases);
  return aliases;
}

function finalTableNamePart(table: KtxEnrichedTable): string {
  const parts = table.ref.name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return parts[parts.length - 1] ?? table.ref.name;
}

function parentTableNameAliases(table: KtxEnrichedTable): Set<string> {
  const cached = parentTableNameAliasesCache.get(table);
  if (cached) {
    return cached;
  }

  const aliases = new Set(tableAliases(table));
  addNormalizedTableAlias(aliases, finalTableNamePart(table));
  parentTableNameAliasesCache.set(table, aliases);
  return aliases;
}

function targetKeyScore(table: KtxEnrichedTable, column: KtxEnrichedColumn): number {
  const columnName = normalizedColumnName(column).normalized;
  const tableKeyBases = parentTableNameAliases(table);
  if (column.primaryKey) {
    return 1;
  }
  if (columnName === 'id') {
    return 0.92;
  }
  if (Array.from(tableKeyBases).some((tableKeyBase) => columnName === `${tableKeyBase}_id`)) {
    return 0.9;
  }
  if (Array.from(tableKeyBases).some((tableKeyBase) => columnName === `${tableKeyBase}_key`)) {
    return 0.82;
  }
  if (columnName === 'key' || columnName === 'uuid') {
    return 0.74;
  }
  return 0;
}

function profileColumn(
  profiles: KtxRelationshipProfileArtifact | undefined,
  tableName: string,
  columnName: string,
) {
  return profiles?.columns[`${tableName}.${columnName}`] ?? null;
}

function profileSampleOverlap(input: {
  profiles: KtxRelationshipProfileArtifact | undefined;
  fromTable: KtxEnrichedTable;
  fromColumn: KtxEnrichedColumn;
  toTable: KtxEnrichedTable;
  toColumn: KtxEnrichedColumn;
}): number {
  const source = profileColumn(input.profiles, input.fromTable.ref.name, input.fromColumn.name);
  const target = profileColumn(input.profiles, input.toTable.ref.name, input.toColumn.name);
  if (!source || !target || source.sampleValues.length === 0 || target.sampleValues.length === 0) {
    return 0;
  }
  const targetValues = new Set(target.sampleValues.map((value) => value.toLowerCase()));
  const overlap = source.sampleValues.filter((value) => targetValues.has(value.toLowerCase())).length;
  return overlap / source.sampleValues.length;
}

function tableProfileRowCount(profiles: KtxRelationshipProfileArtifact | undefined, tableName: string): number | null {
  return profiles?.tables.find((table) => table.table.name === tableName)?.rowCount ?? null;
}

function structuralPriorScore(input: {
  profiles: KtxRelationshipProfileArtifact | undefined;
  fromTable: KtxEnrichedTable;
  toTable: KtxEnrichedTable;
}): number {
  if (input.fromTable.id === input.toTable.id) {
    return 0.72;
  }

  const sourceRows = tableProfileRowCount(input.profiles, input.fromTable.ref.name);
  const targetRows = tableProfileRowCount(input.profiles, input.toTable.ref.name);
  if (sourceRows === null || targetRows === null || sourceRows <= 0 || targetRows <= 0) {
    return 0.5;
  }

  const ratio = targetRows / sourceRows;
  if (ratio >= 0.05 && ratio <= 20) {
    return 0.7;
  }
  return 0.4;
}

function candidateSignalVector(input: {
  profiles: KtxRelationshipProfileArtifact | undefined;
  fromTable: KtxEnrichedTable;
  fromColumn: KtxEnrichedColumn;
  toTable: KtxEnrichedTable;
  toColumn: KtxEnrichedColumn;
  targetKeyScore: number;
  nameScore: number;
  valueOverlap: number;
  embeddingSimilarity?: number;
}): KtxRelationshipSignalVector {
  const sourceProfile = profileColumn(input.profiles, input.fromTable.ref.name, input.fromColumn.name);
  const targetProfile = profileColumn(input.profiles, input.toTable.ref.name, input.toColumn.name);
  const targetUniqueness = targetProfile?.uniquenessRatio ?? input.targetKeyScore;
  const sourceNonNullness = sourceProfile ? 1 - sourceProfile.nullRate : 0.5;

  return {
    nameSimilarity: input.nameScore,
    typeCompatibility: typesCompatible(input.fromColumn, input.toColumn) ? 1 : 0,
    valueOverlap: input.valueOverlap,
    embeddingSimilarity: input.embeddingSimilarity ?? 0,
    profileUniqueness: targetUniqueness,
    profileNullRate: sourceNonNullness,
    structuralPrior: structuralPriorScore({
      profiles: input.profiles,
      fromTable: input.fromTable,
      toTable: input.toTable,
    }),
  };
}

function candidateParentTables(input: {
  tables: readonly KtxEnrichedTable[];
  fromTable: KtxEnrichedTable;
  fromColumn: KtxEnrichedColumn;
  options: KtxRelationshipDiscoveryCandidateOptions;
}): KtxEnrichedTable[] {
  const maxParentTables = input.options.maxCandidateParentTables ?? 20;
  if (maxParentTables <= 0) {
    return [];
  }

  const ranked = localCandidateTables({
    childTable: input.fromTable,
    childColumn: input.fromColumn,
    parentTables: input.tables,
    maxParentTables,
  }).map((item) => item.table);

  const normalizedColumn = normalizedColumnName(input.fromColumn).normalized;
  if (!SELF_REFERENCE_NAMES.has(normalizedColumn) || ranked.some((table) => table.id === input.fromTable.id)) {
    return ranked;
  }

  return [
    input.fromTable,
    ...ranked.filter((table) => table.id !== input.fromTable.id).slice(0, Math.max(0, maxParentTables - 1)),
  ];
}

function targetKeyEvidence(
  table: KtxEnrichedTable,
  column: KtxEnrichedColumn,
  profiles: KtxRelationshipProfileArtifact | undefined,
): KtxRelationshipTargetKeyEvidence {
  const deterministicScore = targetKeyScore(table, column);
  if (deterministicScore > 0) {
    return { score: deterministicScore, reasons: ['target_key_like'] };
  }

  const profile = profileColumn(profiles, table.ref.name, column.name);
  if (!profile || profile.uniquenessRatio < 0.98 || profile.nullRate > 0.05) {
    return { score: 0, reasons: [] };
  }

  const columnName = normalizedColumnName(column).normalized;
  if (columnName === 'code' || columnName.endsWith('_code') || columnName === 'key' || columnName.endsWith('_key')) {
    return { score: 0.86, reasons: ['profile_unique_target'] };
  }

  return { score: 0.78, reasons: ['profile_unique_target'] };
}

function endpoint(table: KtxEnrichedTable, column: KtxEnrichedColumn): KtxRelationshipEndpoint {
  return {
    tableId: table.id,
    columnIds: [column.id],
    table: table.ref,
    columns: [column.name],
  };
}

function relationshipId(from: KtxRelationshipEndpoint, to: KtxRelationshipEndpoint): string {
  return `${from.tableId}:(${from.columnIds.join(',')})->${to.tableId}:(${to.columnIds.join(',')})`;
}

function endpointsHaveSameOrderedColumns(left: KtxRelationshipEndpoint, right: KtxRelationshipEndpoint): boolean {
  if (left.columnIds.length !== right.columnIds.length || left.columns.length !== right.columns.length) {
    return false;
  }
  return left.columnIds.every(
    (columnId, index) => columnId === right.columnIds[index] && left.columns[index] === right.columns[index],
  );
}

function isDegenerateSameColumnSelfLink(candidate: Pick<KtxRelationshipDiscoveryCandidate, 'from' | 'to'>): boolean {
  return candidate.from.tableId === candidate.to.tableId && endpointsHaveSameOrderedColumns(candidate.from, candidate.to);
}

function singleRelationshipColumn(endpointValue: KtxRelationshipEndpoint): string {
  const column = endpointValue.columns[0];
  if (!column) {
    throw new Error(`Expected relationship endpoint ${endpointValue.table.name} to contain one column`);
  }
  return column;
}

function candidateSortKey(candidate: KtxRelationshipDiscoveryCandidate): string {
  return `${candidate.from.table.name}.${singleRelationshipColumn(candidate.from)}->${candidate.to.table.name}.${singleRelationshipColumn(candidate.to)}`;
}

function uniqueReasons(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function mergeCandidateEvidence(
  left: KtxRelationshipDiscoveryCandidate,
  right: KtxRelationshipDiscoveryCandidate,
): KtxRelationshipDiscoveryCandidate {
  const preferred = right.confidence > left.confidence && left.source === 'llm_proposal' ? right : left;
  const supplement = preferred === left ? right : left;
  return {
    ...preferred,
    confidence: Math.max(left.confidence, right.confidence),
    evidence: {
      ...preferred.evidence,
      llmConfidence: preferred.evidence.llmConfidence ?? supplement.evidence.llmConfidence,
      llmRationale: preferred.evidence.llmRationale ?? supplement.evidence.llmRationale,
      reasons: uniqueReasons([...preferred.evidence.reasons, ...supplement.evidence.reasons]),
    },
  };
}

function sourceForEvidence(reasons: string[]): KtxRelationshipDiscoveryCandidateSource {
  if (reasons.includes('self_reference')) {
    return 'self_reference';
  }
  if (reasons.includes('embedding_similarity')) {
    return 'embedding_similarity';
  }
  if (reasons.includes('column_suffix_match')) {
    return 'column_suffix_match';
  }
  if (reasons.includes('parent_table_name_match')) {
    return 'parent_table_name_match';
  }
  if (reasons.includes('profile_sample_overlap') || reasons.includes('profile_unique_target')) {
    return 'profile_match';
  }
  if (reasons.includes('normalized_table_name')) {
    return 'normalized_table_match';
  }
  if (reasons.includes('exact_column_name')) {
    return 'exact_column_match';
  }
  if (reasons.includes('inflection')) {
    return 'inflection';
  }
  return 'normalized_table_match';
}

function createCandidate(input: {
  fromTable: KtxEnrichedTable;
  fromColumn: KtxEnrichedColumn;
  toTable: KtxEnrichedTable;
  toColumn: KtxEnrichedColumn;
  sourceBase: string;
  targetBase: string;
  targetKeyScore: number;
  nameScore: number;
  reasons: string[];
  profiles: KtxRelationshipProfileArtifact | undefined;
  valueOverlap: number;
  embeddingSimilarity?: number;
}): KtxRelationshipDiscoveryCandidate {
  const from = endpoint(input.fromTable, input.fromColumn);
  const to = endpoint(input.toTable, input.toColumn);
  const signalVector = candidateSignalVector({
    profiles: input.profiles,
    fromTable: input.fromTable,
    fromColumn: input.fromColumn,
    toTable: input.toTable,
    toColumn: input.toColumn,
    targetKeyScore: input.targetKeyScore,
    nameScore: input.nameScore,
    valueOverlap: input.valueOverlap,
    embeddingSimilarity: input.embeddingSimilarity,
  });
  const scoreBreakdown = scoreKtxRelationshipCandidate(signalVector);

  return {
    id: relationshipId(from, to),
    from,
    to,
    relationshipType: 'many_to_one',
    confidence: scoreBreakdown.score,
    source: sourceForEvidence(input.reasons),
    status: 'review',
    evidence: {
      sourceColumnBase: input.sourceBase,
      targetTableBase: input.targetBase,
      targetColumnBase: normalizedColumnName(input.toColumn).normalized,
      targetKeyScore: input.targetKeyScore,
      nameScore: input.nameScore,
      reasons: input.reasons,
      signalVector,
      scoreBreakdown,
      ...(input.embeddingSimilarity === undefined
        ? {}
        : { embeddingSimilarity: Number(input.embeddingSimilarity.toFixed(3)) }),
    },
  };
}

function generateKtxEmbeddingRelationshipCandidates(
  schema: KtxEnrichedSchema,
  options: KtxRelationshipDiscoveryCandidateOptions,
): KtxRelationshipDiscoveryCandidate[] {
  if (options.useEmbeddings === false) {
    return [];
  }

  const threshold = options.embeddingSimilarityThreshold ?? 0.92;
  const maxCandidatesPerColumn = options.maxEmbeddingCandidatesPerColumn ?? options.maxCandidatesPerColumn ?? 25;
  const tables = schema.tables.filter((table) => table.enabled);
  const candidates: KtxRelationshipDiscoveryCandidate[] = [];

  for (const fromTable of tables) {
    for (const fromColumn of fromTable.columns) {
      if (fromColumn.primaryKey || !hasUsableEmbedding(fromColumn)) {
        continue;
      }

      const columnCandidates: KtxRelationshipDiscoveryCandidate[] = [];
      for (const toTable of candidateParentTables({ tables, fromTable, fromColumn, options })) {
        if (fromTable.id === toTable.id) {
          continue;
        }

        for (const toColumn of toTable.columns) {
          if (!hasUsableEmbedding(toColumn) || !typesCompatible(fromColumn, toColumn)) {
            continue;
          }

          const keyEvidence = targetKeyEvidence(toTable, toColumn, options.profiles);
          if (keyEvidence.score === 0) {
            continue;
          }

          const similarity = cosineSimilarity(fromColumn.embedding, toColumn.embedding);
          if (similarity < threshold) {
            continue;
          }

          const sourceBase = normalizedColumnName(fromColumn).normalized;
          const targetBase = normalizeKtxRelationshipName(toTable.ref.name).singular;
          const reasons = ['embedding_similarity', ...keyEvidence.reasons];
          const candidate = createCandidate({
            fromTable,
            fromColumn,
            toTable,
            toColumn,
            sourceBase,
            targetBase,
            targetKeyScore: keyEvidence.score,
            nameScore: similarity,
            reasons,
            profiles: options.profiles,
            valueOverlap: profileSampleOverlap({
              profiles: options.profiles,
              fromTable,
              fromColumn,
              toTable,
              toColumn,
            }),
            embeddingSimilarity: similarity,
          });
          if (candidate.confidence >= (options.minConfidence ?? 0.72) && !isDegenerateSameColumnSelfLink(candidate)) {
            columnCandidates.push(candidate);
          }
        }
      }

      columnCandidates.sort(
        (left, right) => right.confidence - left.confidence || candidateSortKey(left).localeCompare(candidateSortKey(right)),
      );
      candidates.push(...columnCandidates.slice(0, maxCandidatesPerColumn));
    }
  }

  return candidates;
}

export function generateKtxRelationshipDiscoveryCandidates(
  schema: KtxEnrichedSchema,
  options: KtxRelationshipDiscoveryCandidateOptions = {},
): KtxRelationshipDiscoveryCandidate[] {
  const maxCandidatesPerColumn = options.maxCandidatesPerColumn ?? 25;
  const minConfidence = options.minConfidence ?? 0.72;
  const tables = schema.tables.filter((table) => table.enabled);
  const candidates: KtxRelationshipDiscoveryCandidate[] = [];

  for (const fromTable of tables) {
    for (const fromColumn of fromTable.columns) {
      if (fromColumn.primaryKey) {
        continue;
      }
      const sourceReference = sourceColumnReference(fromColumn);
      if (!sourceReference) {
        continue;
      }
      const sourceBase = sourceReference.base;

      const columnCandidates: KtxRelationshipDiscoveryCandidate[] = [];
      for (const toTable of candidateParentTables({ tables, fromTable, fromColumn, options })) {
        const strictAliases = tableAliases(toTable);
        const parentAliases = parentTableNameAliases(toTable);
        const targetBase = normalizeKtxRelationshipName(toTable.ref.name).singular;
        const sameTable = fromTable.id === toTable.id;
        const nameMatchesTarget = strictAliases.has(sourceBase);
        const parentTableNameMatcher = !sameTable && !nameMatchesTarget && parentAliases.has(sourceBase);
        const selfReference = sameTable && SELF_REFERENCE_NAMES.has(normalizedColumnName(fromColumn).normalized);
        const strictTableMatcher = (!sameTable && nameMatchesTarget) || selfReference;

        for (const toColumn of toTable.columns) {
          const keyEvidence = targetKeyEvidence(toTable, toColumn, options.profiles);
          if (keyEvidence.score === 0 || !typesCompatible(fromColumn, toColumn)) {
            continue;
          }

          const suffixMatcher =
            !strictTableMatcher &&
            !parentTableNameMatcher &&
            columnSuffixMatchesTarget({ fromColumn, toColumn }) &&
            isRelationshipKeyShapedTarget(toColumn);
          if (!strictTableMatcher && !suffixMatcher && !parentTableNameMatcher) {
            continue;
          }

          const overlap = profileSampleOverlap({
            profiles: options.profiles,
            fromTable,
            fromColumn,
            toTable,
            toColumn,
          });
          if (
            (strictTableMatcher || parentTableNameMatcher) &&
            keyEvidence.reasons.includes('profile_unique_target') &&
            overlap === 0
          ) {
            continue;
          }
          const reasons = suffixMatcher
            ? ['column_suffix_match', ...keyEvidence.reasons]
            : [sourceReference.reason, ...keyEvidence.reasons];
          if (overlap > 0) {
            reasons.push('profile_sample_overlap');
          }
          let nameScore = suffixMatcher ? 0.78 : 0.88;
          if (parentTableNameMatcher) {
            reasons.push('parent_table_name_match');
            nameScore = 0.82;
          } else if (selfReference) {
            reasons.push('self_reference');
            nameScore = 0.82;
          } else if (!suffixMatcher && normalizeKtxRelationshipName(toTable.ref.name).singular === sourceBase) {
            reasons.push('normalized_table_name');
            nameScore = 0.92;
          } else if (!suffixMatcher && strictAliases.has(sourceBase)) {
            reasons.push('inflection');
            nameScore = 0.88;
          }
          if (
            !suffixMatcher &&
            !parentTableNameMatcher &&
            normalizedColumnName(fromColumn).normalized === normalizedColumnName(toColumn).normalized
          ) {
            reasons.push('exact_column_name');
            nameScore = Math.max(nameScore, 0.9);
          }

          const candidate = createCandidate({
            fromTable,
            fromColumn,
            toTable,
            toColumn,
            sourceBase,
            targetBase,
            targetKeyScore: keyEvidence.score,
            nameScore,
            reasons,
            profiles: options.profiles,
            valueOverlap: overlap,
          });
          if (candidate.confidence >= minConfidence && !isDegenerateSameColumnSelfLink(candidate)) {
            columnCandidates.push(candidate);
          }
        }
      }

      columnCandidates.sort(
        (left, right) => right.confidence - left.confidence || candidateSortKey(left).localeCompare(candidateSortKey(right)),
      );
      candidates.push(...columnCandidates.slice(0, maxCandidatesPerColumn));
    }
  }

  candidates.push(...generateKtxEmbeddingRelationshipCandidates(schema, options));

  const byId = new Map<string, KtxRelationshipDiscoveryCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    if (!existing || candidate.confidence > existing.confidence) {
      byId.set(candidate.id, candidate);
    }
  }
  return Array.from(byId.values()).sort(
    (left, right) => right.confidence - left.confidence || candidateSortKey(left).localeCompare(candidateSortKey(right)),
  );
}

export function mergeKtxRelationshipDiscoveryCandidates(
  candidates: readonly KtxRelationshipDiscoveryCandidate[],
): KtxRelationshipDiscoveryCandidate[] {
  const byId = new Map<string, KtxRelationshipDiscoveryCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    byId.set(candidate.id, existing ? mergeCandidateEvidence(existing, candidate) : candidate);
  }
  return Array.from(byId.values()).sort((left, right) => candidateSortKey(left).localeCompare(candidateSortKey(right)));
}

export function inferKtxRelationshipTargetPks(
  candidates: readonly KtxRelationshipDiscoveryCandidate[],
): KtxRelationshipInferredTargetPk[] {
  const incoming = new Map<string, { table: string; column: string; scores: number[] }>();
  for (const candidate of candidates) {
    const toColumn = singleRelationshipColumn(candidate.to);
    const key = `${candidate.to.table.name}.${toColumn}`;
    const item = incoming.get(key) ?? { table: candidate.to.table.name, column: toColumn, scores: [] };
    item.scores.push(candidate.confidence);
    incoming.set(key, item);
  }

  return Array.from(incoming.values())
    .map((item) => ({
      table: item.table,
      columns: [item.column],
      score: Number(Math.min(0.95, Math.max(...item.scores)).toFixed(3)),
      status: 'review' as const,
      incomingCandidateCount: item.scores.length,
    }))
    .sort((left, right) => left.table.localeCompare(right.table) || left.columns[0]!.localeCompare(right.columns[0]!));
}
