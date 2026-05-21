import { describe, expect, it } from 'vitest';
import {
  bucketDistinctUsers,
  bucketErrorRate,
  bucketExecutions,
  bucketFrequency,
  bucketP95Runtime,
  bucketRecency,
} from './buckets.js';

describe('historic-sql bucket helpers', () => {
  it('uses stable execution buckets', () => {
    expect([0, 9, 10, 99, 100, 999, 1000, 4999, 5000, 49999, 50000].map(bucketExecutions)).toEqual([
      '<10',
      '<10',
      '10-100',
      '10-100',
      '100-1k',
      '100-1k',
      '1k-5k',
      '1k-5k',
      '5k-50k',
      '5k-50k',
      '>50k',
    ]);
  });

  it('uses stable distinct-user, error-rate, runtime, and recency buckets', () => {
    expect([0, 1, 2, 5, 6, 10, 11].map(bucketDistinctUsers)).toEqual([
      '0',
      '1',
      '2-5',
      '2-5',
      '5-10',
      '5-10',
      '>10',
    ]);
    expect([0, 0.01, 0.05, 0.2].map(bucketErrorRate)).toEqual(['none', 'low', 'low', 'high']);
    expect([null, 99, 100, 999, 1000, 9999, 10000].map(bucketP95Runtime)).toEqual([
      'unknown',
      '<100ms',
      '100ms-1s',
      '100ms-1s',
      '1s-10s',
      '1s-10s',
      '>10s',
    ]);
    expect(bucketRecency('2026-05-11T00:00:00.000Z', new Date('2026-05-11T12:00:00.000Z'))).toBe('current');
    expect(bucketRecency('2026-04-20T00:00:00.000Z', new Date('2026-05-11T12:00:00.000Z'))).toBe('recent');
    expect(bucketRecency('2026-01-01T00:00:00.000Z', new Date('2026-05-11T12:00:00.000Z'))).toBe('stale');
  });

  it('maps frequency counts to high, mid, and low labels', () => {
    expect(bucketFrequency(80, 100)).toBe('high');
    expect(bucketFrequency(20, 100)).toBe('mid');
    expect(bucketFrequency(1, 100)).toBe('low');
    expect(bucketFrequency(0, 0)).toBe('low');
  });
});
