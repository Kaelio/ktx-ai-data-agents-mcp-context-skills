import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KtxEmbeddingPort } from '../../../src/context/core/embedding.js';
import { CandidateDedupService } from '../../../src/context/ingest/context-candidates/candidate-dedup.service.js';
import { ContextEvidenceIndexService } from '../../../src/context/ingest/context-evidence/context-evidence-index.service.js';
import { SqliteContextEvidenceStore } from '../../../src/context/ingest/context-evidence/sqlite-context-evidence-store.js';
import type { DiffSet } from '../../../src/context/ingest/types.js';

describe('local ingest embedding providers with SQLite ingest stores', () => {
  let tempDir: string;
  let dbPath: string;
  let stagedDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-ingest-embedding-'));
    dbPath = join(tempDir, '.ktx', 'db.sqlite');
    stagedDir = join(tempDir, 'staged');
    await mkdir(join(stagedDir, 'pages', 'revenue'), { recursive: true });
    await writeFile(
      join(stagedDir, 'pages', 'revenue', 'metadata.json'),
      `${JSON.stringify({
        objectType: 'page',
        id: 'page-revenue',
        title: 'Revenue Policy',
        path: 'Revenue Policy',
        url: 'https://notion.test/revenue',
        parentId: null,
        lastEditedAt: '2026-04-30T12:00:00.000Z',
        properties: {},
      })}\n`,
      'utf8',
    );
    await writeFile(
      join(stagedDir, 'pages', 'revenue', 'page.md'),
      ['# Approval', '', 'Owner approval is required before enterprise discounts are granted.', ''].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function embeddings(): KtxEmbeddingPort {
    return {
      maxBatchSize: 4,
      async computeEmbedding() {
        return [1, 0, 0];
      },
      async computeEmbeddingsBulk(texts) {
        return texts.map(() => [1, 0, 0]);
      },
    };
  }

  it('indexes and searches context evidence using a package-owned local embedding provider', async () => {
    const store = new SqliteContextEvidenceStore({ dbPath });
    const embeddingPort = embeddings();
    const indexer = new ContextEvidenceIndexService({ store, embeddings: embeddingPort });
    const diffSet: DiffSet = {
      added: ['pages/revenue/metadata.json', 'pages/revenue/page.md'],
      modified: [],
      deleted: [],
      unchanged: [],
    };

    const summary = await indexer.indexStagedDir({
      stagedDir,
      runId: 'run-1',
      connectionId: 'docs',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet,
      currentHashes: new Map([
        ['pages/revenue/metadata.json', 'metadata-hash'],
        ['pages/revenue/page.md', 'page-hash'],
      ]),
    });

    expect(summary).toMatchObject({
      documentsIndexed: 1,
      embeddingFailures: 0,
    });
    expect(summary.chunksIndexed).toBeGreaterThan(0);

    const queryText = [
      'Revenue Policy',
      'Revenue Policy',
      'Approval',
      'Owner approval is required before enterprise discounts are granted.',
    ].join('\n');
    const queryEmbedding = await embeddingPort.computeEmbedding(queryText);
    const results = await store.searchRRF({
      connectionId: 'docs',
      sourceKey: 'notion',
      queryEmbedding,
      queryText,
      limit: 5,
      includeDeleted: false,
      currentRunId: 'run-1',
    });

    expect(results[0]?.title).toBe('Revenue Policy');
    expect(results[0]?.stableCitationKey).toContain('notion:page-revenue');
    expect(results[0]).toMatchObject({
      matchReasons: expect.arrayContaining(['semantic']),
      lanes: expect.arrayContaining([
        expect.objectContaining({ lane: 'semantic', status: 'available' }),
        expect.objectContaining({ lane: 'lexical', status: 'available' }),
        expect.objectContaining({ lane: 'token', status: 'available' }),
      ]),
    });
  });

  it('deduplicates candidates using package-owned local embeddings and SQLite persistence', async () => {
    const store = new SqliteContextEvidenceStore({ dbPath });
    const embeddingPort = embeddings();
    const candidateBase = {
      runId: 'run-1',
      connectionId: 'docs',
      sourceKey: 'notion',
      topic: 'Enterprise discount approval',
      assertion: 'Owner approval is required before enterprise discounts are granted.',
      rationale: 'The source policy states that approval is required.',
      evidenceChunkIds: [],
      evidenceRefs: [],
      suggestedPageKey: 'revenue-policy',
      actionHint: 'create' as const,
      durabilityScore: 3,
      authorityScore: 3,
      reuseScore: 3,
      noveltyScore: 2,
      riskScore: 0,
      promotionScore: 11,
      status: 'pending' as const,
      rejectionReason: null,
      lane: 'full' as const,
      embedding: null,
    };

    await store.insertCandidate({ ...candidateBase, candidateKey: 'discount-policy-a' });
    await store.insertCandidate({ ...candidateBase, candidateKey: 'discount-policy-b' });

    const result = await new CandidateDedupService({
      store,
      embeddings: embeddingPort,
      settings: {
        enabled: true,
        topicSimilarityThreshold: -1,
        scoreAggregation: 'max',
      },
    }).deduplicateRun('run-1');

    expect(result.enabled).toBe(true);
    expect(result.embeddingFailures).toBe(0);
    expect(result.candidatesIn).toBe(2);
    expect(result.clustersOut).toBe(1);
    expect(result.mergedCount).toBe(1);
  });
});
