import type { KtxEnrichedColumn, KtxEnrichedTable } from './enrichment-types.js';
import { normalizeKtxRelationshipName, tokenizeKtxRelationshipName } from './relationship-name-similarity.js';

export interface KtxRelationshipLocalityCandidateTable {
  table: KtxEnrichedTable;
  score: number;
  tokenScore: number;
  embeddingScore: number;
  reasons: string[];
}

export interface LocalKtxRelationshipCandidateTablesInput {
  childTable: KtxEnrichedTable;
  childColumn: KtxEnrichedColumn;
  parentTables: readonly KtxEnrichedTable[];
  maxParentTables?: number;
}

const DEFAULT_MAX_PARENT_TABLES = 20;
const RELATIONSHIP_SUFFIX_TOKENS = new Set(['id', 'ids', 'key', 'keys', 'code', 'codes', 'uuid', 'uuids']);
const normalizedTokenVariantsCache = new Map<string, string[]>();

function roundedScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function normalizedTokenVariants(name: string): string[] {
  const cached = normalizedTokenVariantsCache.get(name);
  if (cached) {
    return cached;
  }

  const normalized = normalizeKtxRelationshipName(name);
  const variants = Array.from(
    new Set([
      ...normalized.tokens,
      ...tokenizeKtxRelationshipName(normalized.singular),
      ...tokenizeKtxRelationshipName(normalized.plural),
    ]),
  ).filter(Boolean);
  normalizedTokenVariantsCache.set(name, variants);
  return variants;
}

function childColumnLocalityTokens(column: KtxEnrichedColumn): string[] {
  const tokens = normalizedTokenVariants(column.name);
  const withoutSuffix = tokens.filter((token) => !RELATIONSHIP_SUFFIX_TOKENS.has(token));
  return withoutSuffix.length > 0 ? withoutSuffix : tokens;
}

function uniqueTokens(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersectionSize = Array.from(leftSet).filter((token) => rightSet.has(token)).length;
  const unionSize = new Set([...leftSet, ...rightSet]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
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

function parentEmbeddingScore(childColumn: KtxEnrichedColumn, parentTable: KtxEnrichedTable): number {
  if (!Array.isArray(childColumn.embedding) || childColumn.embedding.length === 0) {
    return 0;
  }

  let best = 0;
  for (const parentColumn of parentTable.columns) {
    best = Math.max(best, cosineSimilarity(childColumn.embedding, parentColumn.embedding));
  }
  return best;
}

function tableTokenScore(input: {
  childTableId: string;
  childTableTokens: readonly string[];
  childColumnTokens: readonly string[];
  parentTable: KtxEnrichedTable;
}): number {
  const parentTokens = normalizedTokenVariants(input.parentTable.ref.name);
  const columnOnlyScore = jaccard(input.childColumnTokens, parentTokens);
  if (parentTokens.length === 0) {
    return 0;
  }
  if (input.parentTable.id === input.childTableId) {
    return columnOnlyScore;
  }
  const columnAndTableScore = jaccard(uniqueTokens([...input.childTableTokens, ...input.childColumnTokens]), parentTokens);
  return Math.max(columnOnlyScore, columnAndTableScore * 0.6);
}

function localityScore(input: {
  childTable: KtxEnrichedTable;
  childTableId: string;
  childTableTokens: readonly string[];
  childColumn: KtxEnrichedColumn;
  childColumnTokens: readonly string[];
  parentTable: KtxEnrichedTable;
}): Omit<KtxRelationshipLocalityCandidateTable, 'table'> {
  const tokenScore = roundedScore(tableTokenScore(input));
  const embeddingScore = roundedScore(parentEmbeddingScore(input.childColumn, input.parentTable));
  const score =
    embeddingScore > 0
      ? roundedScore(Math.max(tokenScore, tokenScore * 0.8 + embeddingScore * 0.2, embeddingScore * 0.65))
      : tokenScore;
  const reasons: string[] = [];
  if (tokenScore > 0) {
    reasons.push('column_table_token_overlap');
  }
  if (embeddingScore > 0) {
    reasons.push('embedding_similarity');
  }
  if (reasons.length === 0) {
    reasons.push('locality_tie_breaker');
  }
  return {
    score,
    tokenScore,
    embeddingScore,
    reasons,
  };
}

export function localCandidateTables(
  input: LocalKtxRelationshipCandidateTablesInput,
): KtxRelationshipLocalityCandidateTable[] {
  const limit = input.maxParentTables ?? DEFAULT_MAX_PARENT_TABLES;
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }

  const childTableTokens = normalizedTokenVariants(input.childTable.ref.name);
  const childColumnTokens = childColumnLocalityTokens(input.childColumn);

  return input.parentTables
    .map((table) => ({
      table,
      ...localityScore({
        childTable: input.childTable,
        childTableId: input.childTable.id,
        childTableTokens,
        childColumn: input.childColumn,
        childColumnTokens,
        parentTable: table,
      }),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.tokenScore - left.tokenScore ||
        right.embeddingScore - left.embeddingScore ||
        left.table.ref.name.localeCompare(right.table.ref.name) ||
        left.table.id.localeCompare(right.table.id),
    )
    .slice(0, Math.floor(limit));
}
