import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { KtxEmbeddingPort } from '../../../core/embedding.js';
import type { WorkUnit } from '../../types.js';
import { clusterNotionWorkUnits, MIN_PAGES_TO_CLUSTER } from './cluster.js';

function fakeEmbedding(text: string): number[] {
  const v = [0, 0, 0, 0];
  for (const ch of text) {
    v[ch.charCodeAt(0) % 4] += 1;
  }
  return v;
}

const mockEmbed: KtxEmbeddingPort = {
  maxBatchSize: 100,
  computeEmbedding: async (t: string) => fakeEmbedding(t),
  computeEmbeddingsBulk: async (texts: string[]) => texts.map(fakeEmbedding),
};

async function makeStaged(pages: Array<{ id: string; title: string; body: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'notion-cluster-'));
  for (const p of pages) {
    const pageDir = join(dir, 'pages', p.id);
    await mkdir(pageDir, { recursive: true });
    await writeFile(join(pageDir, 'page.md'), p.body);
    await writeFile(
      join(pageDir, 'metadata.json'),
      JSON.stringify({
        id: p.id,
        title: p.title,
        path: p.title,
        objectType: 'page',
        properties: {},
      }),
    );
  }
  return dir;
}

function makeWorkUnits(pages: Array<{ id: string }>): WorkUnit[] {
  return pages.map((p) => ({
    unitKey: `notion-${p.id}`,
    rawFiles: [`pages/${p.id}/page.md`, `pages/${p.id}/metadata.json`],
    peerFileIndex: [],
    dependencyPaths: ['manifest.json'],
  }));
}

describe('clusterNotionWorkUnits', () => {
  test('returns input unchanged when below threshold', async () => {
    const pages = Array.from({ length: 3 }, (_, i) => ({
      id: `p${i}`,
      title: `Page ${i}`,
      body: 'short body',
    }));
    const stagedDir = await makeStaged(pages);
    const wus = makeWorkUnits(pages);
    const out = await clusterNotionWorkUnits({ workUnits: wus, stagedDir, embedding: mockEmbed });
    expect(out).toHaveLength(3);
    expect(out[0].unitKey).toBe('notion-p0');
  });

  test('groups pages into k=ceil(N/8) clusters when above threshold', async () => {
    const n = MIN_PAGES_TO_CLUSTER + 4;
    const pages = Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      title: `Topic ${i % 2 === 0 ? 'alpha' : 'beta'} ${i}`,
      body: `Body for page ${i}`.repeat(20),
    }));
    const stagedDir = await makeStaged(pages);
    const wus = makeWorkUnits(pages);
    const out = await clusterNotionWorkUnits({ workUnits: wus, stagedDir, embedding: mockEmbed });
    expect(out.length).toBeLessThanOrEqual(wus.length);
    expect(out.length).toBe(Math.ceil(wus.length / 8));
    for (const wu of out) {
      expect(wu.unitKey).toMatch(/^notion-cluster-\d+$/);
      expect(wu.rawFiles.length).toBeGreaterThan(0);
      expect(wu.notes).toMatch(/Synthesize/);
      expect(wu.notes).toContain('emit_unmapped_fallback');
      expect(wu.notes).toContain('Do not create SL sources under the Notion connection');
    }
  });

  test('merges pages into one synthesis unit at the clustering threshold', async () => {
    const pages = Array.from({ length: MIN_PAGES_TO_CLUSTER }, (_, i) => ({
      id: `p${i}`,
      title: `Customer source reference ${i}`,
      body: `Customer source reference maps to orbit_analytics.customer ${i}`.repeat(10),
    }));
    const stagedDir = await makeStaged(pages);
    const wus = makeWorkUnits(pages);
    const out = await clusterNotionWorkUnits({ workUnits: wus, stagedDir, embedding: mockEmbed });
    expect(out).toHaveLength(1);
    expect(out[0].unitKey).toBe('notion-cluster-1');
    expect(new Set(out[0].rawFiles)).toEqual(new Set(wus.flatMap((wu) => wu.rawFiles)));
    expect(out[0].notes).toContain('emit_unmapped_fallback');
    expect(out[0].notes).toContain('Do not create SL sources under the Notion connection');
  });

  test('preserves coverage: every input rawFile appears in some cluster', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      title: `Page ${i}`,
      body: 'body content',
    }));
    const stagedDir = await makeStaged(pages);
    const wus = makeWorkUnits(pages);
    const inputFiles = new Set(wus.flatMap((wu) => wu.rawFiles));
    const out = await clusterNotionWorkUnits({ workUnits: wus, stagedDir, embedding: mockEmbed });
    const outFiles = new Set(out.flatMap((wu) => wu.rawFiles));
    expect(outFiles).toEqual(inputFiles);
  });

  test('falls back to input when embedding fails', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      title: `Page ${i}`,
      body: 'b',
    }));
    const stagedDir = await makeStaged(pages);
    const wus = makeWorkUnits(pages);
    const failingEmbed: KtxEmbeddingPort = {
      maxBatchSize: 100,
      computeEmbedding: async () => {
        throw new Error('embedding down');
      },
      computeEmbeddingsBulk: async () => {
        throw new Error('embedding down');
      },
    };
    const out = await clusterNotionWorkUnits({ workUnits: wus, stagedDir, embedding: failingEmbed });
    expect(out).toEqual(wus);
  });
});
