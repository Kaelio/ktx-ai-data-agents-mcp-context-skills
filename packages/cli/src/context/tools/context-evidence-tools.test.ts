import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import { SqliteContextEvidenceStore } from '../ingest/context-evidence/sqlite-context-evidence-store.js';
import { ContextCandidateMarkTool } from './context-candidate-mark.tool.js';
import { ContextCandidateWriteTool } from './context-candidate-write.tool.js';
import { ContextEvidenceNeighborsTool } from './context-evidence-neighbors.tool.js';
import { ContextEvidenceReadTool } from './context-evidence-read.tool.js';
import { ContextEvidenceSearchTool } from './context-evidence-search.tool.js';
import type { ContextEvidenceToolStorePort } from './context-evidence-tool-store.js';
import { createTouchedSlSources } from '../../context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../context/tools/base-tool.js';
import type { ToolSession } from '../../context/tools/tool-session.js';

const ingestContext = (): ToolContext => ({
  sourceId: 'ingest',
  messageId: 'job-1-wu-unit-1',
  userId: 'system',
  connectionId: '00000000-0000-0000-0000-000000000001',
  ingest: {
    runId: '10000000-0000-0000-0000-000000000001',
    jobId: 'job-1',
    syncId: 'sync-1',
    sourceKey: 'notion',
  },
  session: {
    connectionId: '00000000-0000-0000-0000-000000000001',
    isWorktreeScoped: true,
    preHead: 'abc123',
    touchedSlSources: createTouchedSlSources(),
    actions: [],
    ingest: {
      runId: '10000000-0000-0000-0000-000000000001',
      jobId: 'job-1',
      syncId: 'sync-1',
      sourceKey: 'notion',
    },
  } as unknown as ToolSession,
});

const makeEmbeddingService = (overrides: Partial<KtxEmbeddingPort> = {}) =>
  ({
    computeEmbedding: vi.fn().mockResolvedValue([0.25, 0.5, 0.75]),
    ...overrides,
  }) as Partial<KtxEmbeddingPort> as KtxEmbeddingPort;

describe('context evidence tools', () => {
  it('searches context evidence with ingest defaults', async () => {
    const repository = {
      searchRRF: vi.fn().mockResolvedValue([
        {
          chunkId: 'chunk-1',
          documentId: 'doc-1',
          externalId: 'page-1',
          title: 'Revenue Recognition',
          path: 'Company Handbook / Finance / Revenue Recognition',
          url: 'https://notion.example/page-1',
          snippet: 'Booked revenue excludes refunds and test accounts.',
          score: 0.35,
          citation: { source: 'notion', pageId: 'page-1', rawPath: 'pages/page-1/page.md' },
          stableCitationKey: 'notion:page-1:policy:abc',
          syncId: 'sync-1',
          lastEditedAt: new Date('2026-04-12T10:15:00.000Z'),
          matchReasons: ['lexical', 'semantic'],
          lanes: [
            {
              lane: 'lexical',
              status: 'available',
              requestedCandidatePoolLimit: 25,
              effectiveCandidatePoolLimit: 25,
              returnedCandidateCount: 1,
              weight: 1.5,
            },
            {
              lane: 'semantic',
              status: 'available',
              requestedCandidatePoolLimit: 25,
              effectiveCandidatePoolLimit: 25,
              returnedCandidateCount: 1,
              weight: 2,
            },
          ],
        },
      ]),
    } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort;
    const embeddings = {
      computeEmbedding: vi.fn().mockResolvedValue([0.1, ...Array.from({ length: 383 }, () => 0)]),
    } as Partial<KtxEmbeddingPort> as KtxEmbeddingPort;

    const tool = new ContextEvidenceSearchTool(repository, embeddings);
    const result = await tool.call({ query: 'revenue refunds', limit: 5, includeDeleted: false }, ingestContext());

    expect(repository.searchRRF).toHaveBeenCalledWith({
      connectionId: '00000000-0000-0000-0000-000000000001',
      sourceKey: 'notion',
      queryEmbedding: [0.1, ...Array.from({ length: 383 }, () => 0)],
      queryText: 'revenue refunds',
      limit: 5,
      includeDeleted: false,
      currentRunId: '10000000-0000-0000-0000-000000000001',
    });
    expect(result.markdown).toContain('Revenue Recognition');
    expect(result.markdown).toContain('matchReasons: lexical, semantic');
    expect(result.structured.success).toBe(true);
    if (result.structured.success) {
      expect(result.structured.results[0]).toMatchObject({
        chunkId: 'chunk-1',
        stableCitationKey: 'notion:page-1:policy:abc',
        matchReasons: ['lexical', 'semantic'],
        lanes: expect.arrayContaining([expect.objectContaining({ lane: 'lexical', status: 'available' })]),
      });
    }
  });

  it('returns a structured ingest metadata error outside ingest sessions', async () => {
    const tool = new ContextEvidenceSearchTool(
      { searchRRF: vi.fn() } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort,
      { computeEmbedding: vi.fn() } as Partial<KtxEmbeddingPort> as KtxEmbeddingPort,
    );

    const result = await tool.call(
      { query: 'revenue', limit: 5, includeDeleted: false },
      { sourceId: 'research', messageId: 'm1', userId: 'user-1' },
    );

    expect(result.structured).toMatchObject({ success: false, error: 'INGEST_METADATA_REQUIRED' });
  });

  it('reads a full document by external id', async () => {
    const repository = {
      readDocumentByExternalId: vi.fn().mockResolvedValue({
        document: {
          id: 'doc-1',
          title: 'Onboarding SOP',
          path: 'Ops / Onboarding SOP',
          external_id: 'page-ops',
          raw_path: 'pages/page-ops/page.md',
          url: 'https://notion.example/page-ops',
        },
        chunks: [
          {
            id: 'chunk-1',
            heading_path: ['Onboarding SOP', 'Checklist'],
            content: 'Create account, invite to workspace, confirm dashboard access.',
            citation: { source: 'notion', pageId: 'page-ops' },
          },
        ],
      }),
    } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort;

    const tool = new ContextEvidenceReadTool(repository);
    const result = await tool.call({ externalId: 'page-ops', includeNeighborChunks: false }, ingestContext());

    expect(repository.readDocumentByExternalId).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'notion',
      'page-ops',
      '10000000-0000-0000-0000-000000000001',
    );
    expect(result.markdown).toContain('## Onboarding SOP');
    expect(result.markdown).toContain('Create account');
    expect(result.structured.success).toBe(true);
    if (result.structured.success) {
      expect(result.structured.found).toBe(true);
    }
  });

  it('reads documents and chunks by id with connection and source scope', async () => {
    const repository = {
      readDocumentById: vi.fn().mockResolvedValue({
        document: {
          id: '00000000-0000-0000-0000-000000000201',
          title: 'Scoped Document',
          path: 'Scoped Document',
          external_id: 'page-scoped',
          url: null,
        },
        chunks: [{ id: 'chunk-1', content: 'Scoped content.' }],
      }),
      readChunkById: vi.fn().mockResolvedValue({
        document: {
          id: '00000000-0000-0000-0000-000000000201',
          title: 'Scoped Document',
          path: 'Scoped Document',
          external_id: 'page-scoped',
          url: null,
        },
        chunk: {
          id: '00000000-0000-0000-0000-000000000301',
          content: 'Scoped chunk.',
          citation: { source: 'notion' },
        },
      }),
    } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort;

    const tool = new ContextEvidenceReadTool(repository);
    await tool.call(
      { documentId: '00000000-0000-0000-0000-000000000201', includeNeighborChunks: false },
      ingestContext(),
    );
    await tool.call({ chunkId: '00000000-0000-0000-0000-000000000301', includeNeighborChunks: false }, ingestContext());

    expect(repository.readDocumentById).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000201',
      '00000000-0000-0000-0000-000000000001',
      'notion',
      '10000000-0000-0000-0000-000000000001',
    );
    expect(repository.readChunkById).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000301',
      '00000000-0000-0000-0000-000000000001',
      'notion',
      '10000000-0000-0000-0000-000000000001',
    );
  });

  it('lists evidence neighbors', async () => {
    const repository = {
      findNeighborDocuments: vi.fn().mockResolvedValue([
        {
          documentId: 'doc-child',
          externalId: 'page-child',
          title: 'Revenue Caveats',
          path: 'Company Handbook / Finance / Revenue Caveats',
          relation: 'children',
          url: null,
          lastEditedAt: null,
        },
      ]),
    } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort;

    const tool = new ContextEvidenceNeighborsTool(repository);
    const result = await tool.call({ documentId: 'doc-1', relation: 'children', limit: 10 }, ingestContext());

    expect(repository.findNeighborDocuments).toHaveBeenCalledWith({
      connectionId: '00000000-0000-0000-0000-000000000001',
      sourceKey: 'notion',
      documentId: 'doc-1',
      relation: 'children',
      limit: 10,
      currentRunId: '10000000-0000-0000-0000-000000000001',
    });
    expect(result.markdown).toContain('Revenue Caveats');
  });

  it('writes a cited candidate with durable evidence refs', async () => {
    const repository = {
      readChunksByIds: vi.fn().mockResolvedValue([
        {
          chunkId: '00000000-0000-0000-0000-000000000101',
          documentId: 'doc-1',
          externalId: 'page-1',
          title: 'Revenue Recognition',
          path: 'Company Handbook / Finance / Revenue Recognition',
          url: 'https://notion.example/page-1',
          rawPath: 'pages/page-1/page.md',
          content: 'Booked revenue excludes refunds and test accounts.',
          citation: { source: 'notion', pageId: 'page-1', rawPath: 'pages/page-1/page.md' },
          stableCitationKey: 'notion:page-1:policy:abc',
          syncId: 'sync-1',
          lastEditedAt: new Date('2026-04-12T10:15:00.000Z'),
        },
      ]),
      insertCandidate: vi.fn().mockResolvedValue({
        id: 'candidate-1',
        candidate_key: 'revenue-definition',
        promotion_score: 10,
        status: 'pending',
      }),
    } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort;

    const embeddings = makeEmbeddingService();
    const tool = new ContextCandidateWriteTool(repository, embeddings);
    const result = await tool.call(
      {
        candidateKey: 'revenue-definition',
        topic: 'Revenue Recognition',
        assertion: 'Booked revenue excludes refunds and test accounts.',
        rationale: 'Finance handbook is the source of truth and describes the reusable revenue rule.',
        evidenceChunkIds: ['00000000-0000-0000-0000-000000000101'],
        suggestedPageKey: 'revenue-definition',
        actionHint: 'create',
        durabilityScore: 3,
        authorityScore: 3,
        reuseScore: 3,
        noveltyScore: 2,
        riskScore: 1,
      },
      ingestContext(),
    );

    expect(repository.readChunksByIds).toHaveBeenCalledWith(
      ['00000000-0000-0000-0000-000000000101'],
      '00000000-0000-0000-0000-000000000001',
      'notion',
      '10000000-0000-0000-0000-000000000001',
    );

    expect(repository.insertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: '10000000-0000-0000-0000-000000000001',
        connectionId: '00000000-0000-0000-0000-000000000001',
        sourceKey: 'notion',
        candidateKey: 'revenue-definition',
        promotionScore: 10,
        status: 'pending',
        evidenceRefs: [
          expect.objectContaining({
            chunkId: '00000000-0000-0000-0000-000000000101',
            stableCitationKey: 'notion:page-1:policy:abc',
            snippetHash: createHash('sha256')
              .update('Booked revenue excludes refunds and test accounts.')
              .digest('hex'),
          }),
        ],
      }),
    );
    expect(embeddings.computeEmbedding).toHaveBeenCalledWith(
      'Revenue Recognition - Booked revenue excludes refunds and test accounts.',
    );
    expect(repository.insertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        embedding: [0.25, 0.5, 0.75],
      }),
    );
    expect(result.structured).toMatchObject({ success: true, candidateKey: 'revenue-definition', promotionScore: 10 });
  });

  it('saves candidate writes with a null embedding when embedding generation fails', async () => {
    const repository = {
      readChunksByIds: vi.fn().mockResolvedValue([
        {
          chunkId: '00000000-0000-0000-0000-000000000101',
          documentId: 'doc-1',
          externalId: 'page-1',
          title: 'Revenue Recognition',
          path: 'Company Handbook / Finance / Revenue Recognition',
          url: 'https://notion.example/page-1',
          rawPath: 'pages/page-1/page.md',
          content: 'Booked revenue excludes refunds and test accounts.',
          citation: { source: 'notion', pageId: 'page-1', rawPath: 'pages/page-1/page.md' },
          stableCitationKey: 'notion:page-1:policy:abc',
          syncId: 'sync-1',
          lastEditedAt: new Date('2026-04-12T10:15:00.000Z'),
        },
      ]),
      insertCandidate: vi.fn().mockResolvedValue({
        id: 'candidate-1',
        candidate_key: 'revenue-definition',
        promotion_score: 10,
        status: 'pending',
      }),
    } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort;
    const embeddings = makeEmbeddingService({
      computeEmbedding: vi.fn().mockRejectedValue(new Error('embedding provider unavailable')),
    });

    const tool = new ContextCandidateWriteTool(repository, embeddings);
    const result = await tool.call(
      {
        candidateKey: 'revenue-definition',
        topic: 'Revenue Recognition',
        assertion: 'Booked revenue excludes refunds and test accounts.',
        rationale: 'Finance handbook is the source of truth and describes the reusable revenue rule.',
        evidenceChunkIds: ['00000000-0000-0000-0000-000000000101'],
        suggestedPageKey: 'revenue-definition',
        actionHint: 'create',
        durabilityScore: 3,
        authorityScore: 3,
        reuseScore: 3,
        noveltyScore: 2,
        riskScore: 1,
      },
      ingestContext(),
    );

    expect(embeddings.computeEmbedding).toHaveBeenCalledWith(
      'Revenue Recognition - Booked revenue excludes refunds and test accounts.',
    );
    expect(repository.insertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        embedding: null,
      }),
    );
    expect(result.structured).toMatchObject({ success: true, candidateKey: 'revenue-definition', promotionScore: 10 });
  });

  it('rejects candidate writes without evidence chunks', async () => {
    const embeddings = makeEmbeddingService();
    const tool = new ContextCandidateWriteTool(
      {
        insertCandidate: vi.fn(),
      } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort,
      embeddings,
    );

    const result = await tool.call(
      {
        candidateKey: 'uncited',
        topic: 'Uncited',
        assertion: 'This has no evidence.',
        rationale: 'No evidence was provided.',
        evidenceChunkIds: [],
        actionHint: 'create',
        durabilityScore: 1,
        authorityScore: 1,
        reuseScore: 1,
        noveltyScore: 1,
        riskScore: 1,
      },
      ingestContext(),
    );

    expect(result.structured).toMatchObject({ success: false, error: 'EVIDENCE_REQUIRED' });
    expect(embeddings.computeEmbedding).not.toHaveBeenCalled();
  });

  it('marks a candidate status during reconciliation', async () => {
    const repository = {
      updateCandidateStatus: vi.fn().mockResolvedValue({
        id: 'candidate-1',
        candidate_key: 'revenue-definition',
        status: 'promoted',
      }),
    } as Partial<ContextEvidenceToolStorePort> as ContextEvidenceToolStorePort;

    const tool = new ContextCandidateMarkTool(repository);
    const result = await tool.call(
      { candidateKey: 'revenue-definition', status: 'promoted', rejectionReason: null },
      ingestContext(),
    );

    expect(repository.updateCandidateStatus).toHaveBeenCalledWith({
      runId: '10000000-0000-0000-0000-000000000001',
      candidateKey: 'revenue-definition',
      status: 'promoted',
      rejectionReason: null,
    });
    expect(result.structured).toMatchObject({ success: true, candidateKey: 'revenue-definition', status: 'promoted' });
  });
});

describe('context evidence tools against real SqliteContextEvidenceStore', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-context-tools-sqlite-'));
    dbPath = join(tempDir, '.ktx', 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const realStoreContext = (): ToolContext => ({
    sourceId: 'ingest',
    messageId: 'job-1-wu-unit-1',
    userId: 'system',
    connectionId: 'conn-1',
    ingest: {
      runId: 'run-1',
      jobId: 'job-1',
      syncId: 'sync-1',
      sourceKey: 'notion',
    },
    session: {
      connectionId: 'conn-1',
      isWorktreeScoped: true,
      preHead: 'abc123',
      touchedSlSources: createTouchedSlSources(),
      actions: [],
      ingest: {
        runId: 'run-1',
        jobId: 'job-1',
        syncId: 'sync-1',
        sourceKey: 'notion',
      },
    } as unknown as ToolSession,
  });

  async function seedChunk(store: SqliteContextEvidenceStore): Promise<string> {
    const doc = await store.upsertDocument({
      runId: 'run-1',
      connectionId: 'conn-1',
      sourceKey: 'notion',
      externalId: 'page-1',
      externalParentId: null,
      databaseId: null,
      dataSourceId: null,
      title: 'Revenue Recognition',
      path: 'Company Handbook / Finance / Revenue Recognition',
      url: 'https://notion.test/page-1',
      objectType: 'page',
      lastEditedAt: new Date('2026-04-30T10:00:00.000Z'),
      lastEditedBy: 'user-1',
      rawPath: 'pages/page-1/page.md',
      syncId: 'sync-1',
      contentHash: 'hash-page-1',
      publishState: 'published',
      metadata: {},
    });
    await store.replaceChunks(doc.id, [
      {
        chunkKey: 'intro',
        headingPath: ['Revenue'],
        ordinal: 0,
        content: 'Booked revenue excludes refunds and test accounts.',
        searchText: 'booked revenue excludes refunds test accounts',
        embedding: [1, 0, 0],
        tokenCount: 8,
        citation: { source: 'notion', pageId: 'page-1', rawPath: 'pages/page-1/page.md' },
        stableCitationKey: 'notion:page-1:intro',
        syncId: 'sync-1',
        contentHash: 'chunk-page-1',
      },
    ]);
    const read = await store.readDocumentByExternalId('conn-1', 'notion', 'page-1', 'run-1');
    if (!read) {
      throw new Error('seeded chunk not readable');
    }
    return read.chunks[0].id;
  }

  it('candidate write accepts the prefixed chunkId returned by the real store and persists', async () => {
    const store = new SqliteContextEvidenceStore({ dbPath });
    const chunkId = await seedChunk(store);
    expect(chunkId).toMatch(/^ctxchunk-[0-9a-f-]{36}$/);

    const tool = new ContextCandidateWriteTool(store, {
      computeEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    } as Partial<KtxEmbeddingPort> as KtxEmbeddingPort);

    const parsed = tool.parseInput({
      candidateKey: 'revenue-definition',
      topic: 'Revenue Recognition',
      assertion: 'Booked revenue excludes refunds and test accounts.',
      rationale: 'The Finance handbook is the source of truth.',
      evidenceChunkIds: [chunkId],
      actionHint: 'create',
      durabilityScore: 3,
      authorityScore: 3,
      reuseScore: 3,
      noveltyScore: 2,
      riskScore: 1,
    });

    const result = await tool.call(parsed, realStoreContext());
    expect(result.structured).toMatchObject({
      success: true,
      candidateKey: 'revenue-definition',
      promotionScore: 10,
      status: 'pending',
    });
  });

  it('candidate write schema rejects a bare UUID without the ctxchunk- prefix', () => {
    const tool = new ContextCandidateWriteTool(
      {} as ContextEvidenceToolStorePort,
      { computeEmbedding: vi.fn() } as Partial<KtxEmbeddingPort> as KtxEmbeddingPort,
    );

    expect(() =>
      tool.parseInput({
        candidateKey: 'revenue-definition',
        topic: 'Revenue Recognition',
        assertion: 'Booked revenue excludes refunds and test accounts.',
        rationale: 'Finance handbook is the source of truth.',
        evidenceChunkIds: ['00000000-0000-0000-0000-000000000101'],
        actionHint: 'create',
        durabilityScore: 3,
        authorityScore: 3,
        reuseScore: 3,
        noveltyScore: 2,
        riskScore: 1,
      }),
    ).toThrow(/ctxchunk/);
  });

  it('evidence read schema rejects bare UUIDs for chunkId and documentId', () => {
    const tool = new ContextEvidenceReadTool({} as ContextEvidenceToolStorePort);

    expect(() =>
      tool.parseInput({ chunkId: '00000000-0000-0000-0000-000000000301', includeNeighborChunks: false }),
    ).toThrow(/ctxchunk/);
    expect(() =>
      tool.parseInput({ documentId: '00000000-0000-0000-0000-000000000201', includeNeighborChunks: false }),
    ).toThrow(/ctxdoc/);
  });

  it('evidence neighbors schema rejects bare UUIDs for documentId', () => {
    const tool = new ContextEvidenceNeighborsTool({} as ContextEvidenceToolStorePort);
    expect(() =>
      tool.parseInput({ documentId: '00000000-0000-0000-0000-000000000201', relation: 'children', limit: 10 }),
    ).toThrow(/ctxdoc/);
  });
});
