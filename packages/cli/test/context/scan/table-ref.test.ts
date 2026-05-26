import { describe, expect, it } from 'vitest';
import {
  scopedTableNames,
  tableRefFromKey,
  tableRefKey,
  tableRefSet,
  type KtxTableRefKey,
} from '../../../src/context/scan/table-ref.js';

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

  it('requires non-null scope segments to match the namespace', () => {
    const scope = tableRefSet([{ catalog: null, db: 'public', name: 'users' }]);
    expect(scopedTableNames(scope, { catalog: 'any-catalog', db: 'public' })).toEqual([]);
  });

  it('returns empty when no scope entry matches the namespace', () => {
    const scope = tableRefSet([{ catalog: 'A', db: 'B', name: 'C' }]);
    expect(scopedTableNames(scope, { catalog: 'X', db: 'Y' })).toEqual([]);
  });

  it('dedupes exact namespace matches only', () => {
    const scope: ReadonlySet<KtxTableRefKey> = tableRefSet([
      { catalog: null, db: 'public', name: 'users' },
      { catalog: 'A', db: 'public', name: 'users' },
    ]);
    expect(scopedTableNames(scope, { catalog: 'A', db: 'public' })).toEqual(['users']);
  });
});
