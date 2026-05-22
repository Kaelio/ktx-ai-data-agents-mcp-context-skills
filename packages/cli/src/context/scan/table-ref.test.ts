import { describe, expect, it } from 'vitest';
import {
  hasTableRef,
  scopedTableNames,
  tableRefFromKey,
  tableRefKey,
  tableRefSet,
  type KtxTableRefKey,
} from './table-ref.js';

describe('tableRefKey roundtrip', () => {
  it('encodes and decodes a three-part ref', () => {
    const ref = { catalog: 'ANALYTICS', db: 'MARTS', name: 'LISTINGS' };
    expect(tableRefFromKey(tableRefKey(ref))).toEqual(ref);
  });

  it('treats null catalog/db as the empty segment', () => {
    const ref = { catalog: null, db: 'public', name: 'users' };
    expect(tableRefFromKey(tableRefKey(ref))).toEqual(ref);
  });

  it('roundtrips a bare-name ref', () => {
    const ref = { catalog: null, db: null, name: 'orders' };
    expect(tableRefFromKey(tableRefKey(ref))).toEqual(ref);
  });
});

describe('tableRefSet', () => {
  it('produces a set with member-equality on canonical keys', () => {
    const scope = tableRefSet([
      { catalog: 'ANALYTICS', db: 'MARTS', name: 'LISTINGS' },
      { catalog: 'ANALYTICS', db: 'MARTS', name: 'ITEMS' },
    ]);
    expect(scope.size).toBe(2);
    expect(scope.has(tableRefKey({ catalog: 'ANALYTICS', db: 'MARTS', name: 'LISTINGS' }))).toBe(true);
    expect(scope.has(tableRefKey({ catalog: 'ANALYTICS', db: 'MARTS', name: 'OTHER' }))).toBe(false);
  });
});

describe('hasTableRef', () => {
  const scope = tableRefSet([
    { catalog: 'ANALYTICS', db: 'MARTS', name: 'LISTINGS' },
    { catalog: null, db: 'public', name: 'users' },
  ]);

  it('matches fully qualified entries exactly', () => {
    expect(hasTableRef(scope, { catalog: 'ANALYTICS', db: 'MARTS', name: 'LISTINGS' })).toBe(true);
  });

  it('matches when the scope omits catalog (legacy 2-part entry)', () => {
    expect(hasTableRef(scope, { catalog: 'PRODUCTION_DB', db: 'public', name: 'users' })).toBe(true);
  });

  it('rejects refs not in the scope', () => {
    expect(hasTableRef(scope, { catalog: 'ANALYTICS', db: 'STAGING', name: 'LISTINGS' })).toBe(false);
    expect(hasTableRef(scope, { catalog: null, db: 'public', name: 'orders' })).toBe(false);
  });
});

describe('scopedTableNames', () => {
  it('projects to the requested (catalog, db) namespace', () => {
    const scope = tableRefSet([
      { catalog: 'ANALYTICS', db: 'MARTS', name: 'LISTINGS' },
      { catalog: 'ANALYTICS', db: 'MARTS', name: 'ITEMS' },
      { catalog: 'ANALYTICS', db: 'STAGING', name: 'LISTINGS' },
    ]);
    expect(scopedTableNames(scope, { catalog: 'ANALYTICS', db: 'MARTS' }).sort()).toEqual(['ITEMS', 'LISTINGS']);
    expect(scopedTableNames(scope, { catalog: 'ANALYTICS', db: 'STAGING' })).toEqual(['LISTINGS']);
  });

  it('treats null in the scope entry as a wildcard for that segment', () => {
    const scope = tableRefSet([{ catalog: null, db: 'public', name: 'users' }]);
    expect(scopedTableNames(scope, { catalog: 'any-catalog', db: 'public' })).toEqual(['users']);
  });

  it('returns empty when no scope entry matches the namespace', () => {
    const scope = tableRefSet([{ catalog: 'A', db: 'B', name: 'C' }]);
    expect(scopedTableNames(scope, { catalog: 'X', db: 'Y' })).toEqual([]);
  });

  it('dedupes when the same name appears under different catalog projections', () => {
    const scope: ReadonlySet<KtxTableRefKey> = tableRefSet([
      { catalog: null, db: 'public', name: 'users' },
      { catalog: 'A', db: 'public', name: 'users' },
    ]);
    expect(scopedTableNames(scope, { catalog: 'A', db: 'public' })).toEqual(['users']);
  });
});
