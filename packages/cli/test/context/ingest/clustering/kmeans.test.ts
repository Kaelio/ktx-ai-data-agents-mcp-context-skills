import { describe, expect, test } from 'vitest';
import { kmeans, pickK } from '../../../../src/context/ingest/clustering/kmeans.js';

describe('pickK', () => {
  test('uses ceil(N/8) heuristic clamped to [1, 10]', () => {
    expect(pickK(0)).toBe(0);
    expect(pickK(1)).toBe(1);
    expect(pickK(8)).toBe(1);
    expect(pickK(9)).toBe(2);
    expect(pickK(24)).toBe(3);
    expect(pickK(81)).toBe(10);
    expect(pickK(1000)).toBe(10);
  });
});

describe('kmeans', () => {
  test('separates two well-spaced gaussians', () => {
    const points = [
      [0, 0],
      [0.1, 0.1],
      [-0.1, 0.05],
      [10, 10],
      [10.1, 9.9],
      [9.95, 10.05],
    ];
    const { assignments } = kmeans(points, 2, { seed: 42 });
    expect(assignments[0]).toBe(assignments[1]);
    expect(assignments[0]).toBe(assignments[2]);
    expect(assignments[3]).toBe(assignments[4]);
    expect(assignments[3]).toBe(assignments[5]);
    expect(assignments[0]).not.toBe(assignments[3]);
  });

  test('is deterministic with same seed', () => {
    const points = Array.from({ length: 30 }, (_, i) => [Math.sin(i), Math.cos(i)]);
    const a = kmeans(points, 4, { seed: 7 }).assignments;
    const b = kmeans(points, 4, { seed: 7 }).assignments;
    expect(a).toEqual(b);
  });

  test('k=1 puts everything in one cluster', () => {
    const points = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    const { assignments } = kmeans(points, 1, { seed: 1 });
    expect(new Set(assignments).size).toBe(1);
  });

  test('k>=N produces N singleton clusters', () => {
    const points = [
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    const { assignments } = kmeans(points, 3, { seed: 1 });
    expect(new Set(assignments).size).toBe(3);
  });

  test('handles empty input', () => {
    const { assignments, centroids } = kmeans([], 3, { seed: 1 });
    expect(assignments).toEqual([]);
    expect(centroids).toEqual([]);
  });
});
