import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KtxEmbeddingPort } from '../../../src/context/core/embedding.js';
import { initKtxProject, loadKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import { SqliteKnowledgeIndex } from '../../../src/context/wiki/sqlite-knowledge-index.js';
import { reindexLocalIndexes } from '../../../src/context/index-sync/reindex.js';

class FakeEmbeddingPort implements KtxEmbeddingPort {
  readonly maxBatchSize = 8;

  async computeEmbedding(text: string): Promise<number[]> {
    return [text.length, 1];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return texts.map((text) => [text.length, 1]);
  }
}

async function createProject(tempDir: string): Promise<KtxLocalProject> {
  await initKtxProject({ projectDir: tempDir, force: true });
  return loadKtxProject({ projectDir: tempDir });
}

describe('reindexLocalIndexes', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-reindex-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an empty summary when no wiki or semantic-layer directories exist', async () => {
    const project = await createProject(tempDir);
    await rm(join(project.projectDir, 'wiki'), { recursive: true, force: true });
    await rm(join(project.projectDir, 'semantic-layer'), { recursive: true, force: true });

    await expect(reindexLocalIndexes(project, { force: false, embeddingService: null })).resolves.toMatchObject({
      scopes: [],
      totals: { scanned: 0, updated: 0, deleted: 0, embeddingsRecomputed: 0, embeddingsFailed: 0 },
      force: false,
      embeddingsAvailable: false,
    });
  });

  it('discovers empty directories as zero-row scopes', async () => {
    const project = await createProject(tempDir);
    await mkdir(join(project.projectDir, 'wiki/user/local'), { recursive: true });
    await mkdir(join(project.projectDir, 'semantic-layer/warehouse'), { recursive: true });

    const summary = await reindexLocalIndexes(project, { force: false, embeddingService: null });

    expect(summary.scopes.map((scope) => scope.label)).toEqual(['global', 'user/local', 'warehouse']);
    expect(summary.totals.scanned).toBe(0);
  });

  it('indexes mixed wiki and SL sources and reports totals', async () => {
    const project = await createProject(tempDir);
    await writeFile(
      join(project.projectDir, 'wiki/global/revenue.md'),
      '---\nsummary: Revenue\nusage_mode: auto\n---\n\nPaid orders.\n',
      'utf-8',
    );
    await mkdir(join(project.projectDir, 'semantic-layer/warehouse'), { recursive: true });
    await writeFile(
      join(project.projectDir, 'semantic-layer/warehouse/orders.yaml'),
      'name: orders\ntable: public.orders\ngrain: [id]\ncolumns:\n  - name: id\n    type: number\njoins: []\nmeasures: []\n',
      'utf-8',
    );

    const summary = await reindexLocalIndexes(project, {
      force: false,
      embeddingService: new FakeEmbeddingPort(),
    });

    expect(summary.scopes).toHaveLength(2);
    expect(summary.totals).toMatchObject({ scanned: 2, updated: 2, deleted: 0, embeddingsRecomputed: 2 });
    expect(summary.embeddingsAvailable).toBe(true);
  });

  it('does not report unchanged lexical-only rows as updated on repeated runs', async () => {
    const project = await createProject(tempDir);
    await writeFile(
      join(project.projectDir, 'wiki/global/revenue.md'),
      '---\nsummary: Revenue\nusage_mode: auto\n---\n\nPaid orders.\n',
      'utf-8',
    );
    await mkdir(join(project.projectDir, 'semantic-layer/warehouse'), { recursive: true });
    await writeFile(
      join(project.projectDir, 'semantic-layer/warehouse/orders.yaml'),
      'name: orders\ntable: public.orders\ngrain: [id]\ncolumns:\n  - name: id\n    type: number\njoins: []\nmeasures: []\n',
      'utf-8',
    );

    const first = await reindexLocalIndexes(project, { force: false, embeddingService: null });
    expect(first.totals).toMatchObject({
      scanned: 2,
      updated: 2,
      deleted: 0,
      embeddingsRecomputed: 0,
      embeddingsFailed: 0,
    });

    const second = await reindexLocalIndexes(project, { force: false, embeddingService: null });

    expect(second.totals).toMatchObject({
      scanned: 2,
      updated: 0,
      deleted: 0,
      embeddingsRecomputed: 0,
      embeddingsFailed: 0,
    });
    expect(second.scopes.map((scope) => [scope.label, scope.updated])).toEqual([
      ['global', 0],
      ['warehouse', 0],
    ]);
  });

  it('force clears stale rows before rebuilding each discovered scope', async () => {
    const project = await createProject(tempDir);
    const wikiIndex = new SqliteKnowledgeIndex({ dbPath: join(project.projectDir, '.ktx/db.sqlite') });
    wikiIndex.sync([
      {
        path: 'wiki/global/stale.md',
        key: 'stale',
        scope: 'GLOBAL',
        scopeId: null,
        summary: 'Stale',
        content: 'Stale content',
        tags: [],
        embedding: [1, 0],
      },
    ]);
    await writeFile(
      join(project.projectDir, 'wiki/global/revenue.md'),
      '---\nsummary: Revenue\nusage_mode: auto\n---\n\nPaid orders.\n',
      'utf-8',
    );

    const summary = await reindexLocalIndexes(project, {
      force: true,
      embeddingService: new FakeEmbeddingPort(),
    });

    expect(summary.force).toBe(true);
    expect(summary.totals).toMatchObject({ scanned: 1, updated: 1, deleted: 0 });
    expect(wikiIndex.search('Stale', 10)).toEqual([]);
  });

  it('captures a per-scope error and continues other scopes', async () => {
    const project = await createProject(tempDir);
    await writeFile(
      join(project.projectDir, 'wiki/global/revenue.md'),
      '---\nsummary: Revenue\nusage_mode: auto\n---\n\nPaid orders.\n',
      'utf-8',
    );
    await mkdir(join(project.projectDir, 'semantic-layer/warehouse'), { recursive: true });
    await writeFile(join(project.projectDir, 'semantic-layer/warehouse/broken.yaml'), 'not: [valid', 'utf-8');

    const summary = await reindexLocalIndexes(project, { force: false, embeddingService: null });

    expect(summary.scopes.find((scope) => scope.label === 'global')?.error).toBeUndefined();
    expect(summary.scopes.find((scope) => scope.label === 'warehouse')?.error).toContain('YAML');
  });

  it('marks a scope errored when configured embeddings fail', async () => {
    const project = await createProject(tempDir);
    await writeFile(
      join(project.projectDir, 'wiki/global/revenue.md'),
      '---\nsummary: Revenue\nusage_mode: auto\n---\n\nPaid orders.\n',
      'utf-8',
    );
    const embeddingService: KtxEmbeddingPort = {
      maxBatchSize: 8,
      async computeEmbedding() {
        throw new Error('embedding provider unavailable');
      },
      async computeEmbeddingsBulk() {
        throw new Error('embedding provider unavailable');
      },
    };

    const summary = await reindexLocalIndexes(project, { force: false, embeddingService });

    expect(summary.scopes[0]).toMatchObject({
      label: 'global',
      embeddingsFailed: 1,
      error: '1 embedding recomputation failed',
    });
  });
});
