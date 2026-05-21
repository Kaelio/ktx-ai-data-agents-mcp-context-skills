import type { NormalizedSearchQuery } from './types.js';

export function normalizeSearchQuery(queryText: string): NormalizedSearchQuery {
  const terms = queryText
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((term) => term.trim())
    .filter(Boolean);

  return {
    raw: queryText,
    normalized: terms.join(' '),
    terms,
  };
}

export function defaultLaneCandidatePoolLimit(finalLimit: number): number {
  return Math.max(25, Math.max(1, finalLimit) * 3);
}
