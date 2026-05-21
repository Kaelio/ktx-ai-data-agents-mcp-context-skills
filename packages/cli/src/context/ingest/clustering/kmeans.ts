interface KmeansOptions {
  seed?: number;
  maxIters?: number;
}

interface KmeansResult {
  assignments: number[];
  centroids: number[][];
}

export function pickK(n: number): number {
  if (n <= 0) return 0;
  return Math.max(1, Math.min(10, Math.ceil(n / 8)));
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distSq(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function kMeansPlusPlusInit(points: number[][], k: number, rand: () => number): number[][] {
  const centroids: number[][] = [];
  const firstIdx = Math.floor(rand() * points.length);
  centroids.push([...points[firstIdx]]);
  while (centroids.length < k) {
    const dists = points.map((p) => Math.min(...centroids.map((c) => distSq(p, c))));
    const total = dists.reduce((acc, d) => acc + d, 0);
    if (total === 0) {
      centroids.push([...points[Math.floor(rand() * points.length)]]);
      continue;
    }
    let r = rand() * total;
    let chosen = 0;
    for (let i = 0; i < dists.length; i += 1) {
      r -= dists[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push([...points[chosen]]);
  }
  return centroids;
}

export function kmeans(points: number[][], k: number, options: KmeansOptions = {}): KmeansResult {
  const n = points.length;
  if (n === 0 || k <= 0) return { assignments: [], centroids: [] };
  if (k >= n) {
    return {
      assignments: points.map((_, i) => i),
      centroids: points.map((p) => [...p]),
    };
  }
  const rand = mulberry32(options.seed ?? 1);
  const maxIters = options.maxIters ?? 50;
  const centroids = kMeansPlusPlusInit(points, k, rand);
  const dim = points[0].length;
  const assignments = new Array<number>(n).fill(0);

  for (let iter = 0; iter < maxIters; iter += 1) {
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      let bestK = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const d = distSq(points[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          bestK = c;
        }
      }
      if (assignments[i] !== bestK) {
        assignments[i] = bestK;
        changed = true;
      }
    }

    const sums = Array.from({ length: k }, () => new Array<number>(dim).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i += 1) {
      const c = assignments[i];
      counts[c] += 1;
      for (let d = 0; d < dim; d += 1) {
        sums[c][d] += points[i][d];
      }
    }
    for (let c = 0; c < k; c += 1) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dim; d += 1) {
        sums[c][d] /= counts[c];
      }
      centroids[c] = sums[c];
    }
    if (!changed) break;
  }

  return { assignments, centroids };
}
