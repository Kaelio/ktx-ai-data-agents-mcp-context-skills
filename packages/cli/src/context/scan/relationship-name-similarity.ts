export interface KtxRelationshipNormalizedName {
  raw: string;
  normalized: string;
  singular: string;
  plural: string;
  tokens: string[];
}

/** @internal */
export type KtxRelationshipTokenInput = string | readonly string[] | KtxRelationshipNormalizedName;

const WAREHOUSE_LAYER_PREFIXES = new Set(['stg', 'stage', 'staging', 'dim', 'fct', 'fact', 'int', 'mart']);

function splitCaseBoundaries(value: string): string {
  return value
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1_$2')
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1_$2')
    .replace(/(\p{L})(\p{N})/gu, '$1_$2')
    .replace(/(\p{N})(\p{L})/gu, '$1_$2');
}

function foldAccents(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .replace(/ß/giu, 'ss')
    .replace(/æ/giu, 'ae')
    .replace(/œ/giu, 'oe');
}

export function singularizeKtxRelationshipToken(value: string): string {
  if (value.length <= 2) {
    return value;
  }
  if (value.endsWith('ies') && value.length > 3) {
    return `${value.slice(0, -3)}y`;
  }
  if (/(ches|shes|sses|xes|zes)$/u.test(value)) {
    return value.slice(0, -2);
  }
  if (value.endsWith('ves') && value.length > 4) {
    return `${value.slice(0, -3)}f`;
  }
  if (value.endsWith('s') && !/(ss|us|is)$/u.test(value)) {
    return value.slice(0, -1);
  }
  return value;
}

export function pluralizeKtxRelationshipToken(value: string): string {
  if (value.endsWith('y')) {
    return `${value.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/u.test(value)) {
    return `${value}es`;
  }
  return `${value}s`;
}

function singularizeTokens(tokens: readonly string[]): string[] {
  if (tokens.length === 0) {
    return [];
  }
  const result = [...tokens];
  const last = result[result.length - 1];
  if (last) {
    result[result.length - 1] = singularizeKtxRelationshipToken(last);
  }
  return result;
}

function pluralizeTokens(tokens: readonly string[]): string[] {
  if (tokens.length === 0) {
    return [];
  }
  const result = [...tokens];
  const last = result[result.length - 1];
  if (last) {
    result[result.length - 1] = pluralizeKtxRelationshipToken(last);
  }
  return result;
}

export function tokenizeKtxRelationshipName(name: string): string[] {
  const boundarySeparated = splitCaseBoundaries(foldAccents(name.trim()));
  const tokens = boundarySeparated
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .split('_')
    .filter(Boolean);

  return tokens.filter((token, index) => index > 0 || !WAREHOUSE_LAYER_PREFIXES.has(token));
}

export function normalizeKtxRelationshipName(name: string): KtxRelationshipNormalizedName {
  const tokens = tokenizeKtxRelationshipName(name);
  const singularTokens = singularizeTokens(tokens);
  const pluralTokens = pluralizeTokens(singularTokens);

  return {
    raw: name,
    normalized: tokens.join('_'),
    singular: singularTokens.join('_'),
    plural: pluralTokens.join('_'),
    tokens,
  };
}

function tokensFromInput(input: KtxRelationshipTokenInput): string[] {
  if (typeof input === 'string') {
    return tokenizeKtxRelationshipName(input);
  }
  if ('tokens' in input) {
    return input.tokens;
  }
  return input.map((token) => normalizeKtxRelationshipName(token).normalized).filter(Boolean);
}

function longestCommonSuffixLength(left: readonly string[], right: readonly string[]): number {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function roundedScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

/** @internal */
export function tokenSimilarity(leftInput: KtxRelationshipTokenInput, rightInput: KtxRelationshipTokenInput): number {
  const left = tokensFromInput(leftInput);
  const right = tokensFromInput(rightInput);
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersectionSize = Array.from(leftSet).filter((token) => rightSet.has(token)).length;
  const unionSize = new Set([...leftSet, ...rightSet]).size;
  const jaccard = unionSize === 0 ? 0 : intersectionSize / unionSize;
  const suffixLength = longestCommonSuffixLength(left, right);
  const suffixScore = suffixLength / Math.min(left.length, right.length);

  return roundedScore(jaccard * 0.75 + suffixScore * 0.25);
}
