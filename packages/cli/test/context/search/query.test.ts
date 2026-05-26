import { describe, expect, it } from 'vitest';
import { defaultLaneCandidatePoolLimit, normalizeSearchQuery } from '../../../src/context/search/query.js';

describe('search query helpers', () => {
  it('normalizes punctuation and duplicate terms into stable lowercase tokens', () => {
    expect(normalizeSearchQuery('  Gross-Revenue, gross_revenue! Paid orders  ')).toEqual({
      raw: '  Gross-Revenue, gross_revenue! Paid orders  ',
      normalized: 'gross revenue gross_revenue paid orders',
      terms: ['gross', 'revenue', 'gross_revenue', 'paid', 'orders'],
    });
  });

  it('returns an empty normalized query for punctuation-only input', () => {
    expect(normalizeSearchQuery('--- ///')).toEqual({
      raw: '--- ///',
      normalized: '',
      terms: [],
    });
  });

  it('sizes per-lane candidate pools before final limiting', () => {
    expect(defaultLaneCandidatePoolLimit(1)).toBe(25);
    expect(defaultLaneCandidatePoolLimit(8)).toBe(25);
    expect(defaultLaneCandidatePoolLimit(10)).toBe(30);
  });
});
