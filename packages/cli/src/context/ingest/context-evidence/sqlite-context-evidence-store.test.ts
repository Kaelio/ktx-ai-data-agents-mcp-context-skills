import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InsertContextCandidateInput } from '../../../context/ingest/context-candidates/types.js';
import type { JsonValue } from '../ports.js';
import { SqliteContextEvidenceStore } from './sqlite-context-evidence-store.js';

describe('SqliteContextEvidenceStore', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-context-evidence-sqlite-'));
    dbPath = join(tempDir, '.ktx', 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function store(): SqliteContextEvidenceStore {
    return new SqliteContextEvidenceStore({ dbPath });
  }

  async function seedDocument(
    subject: SqliteContextEvidenceStore,
    input: {
      runId?: string;
      syncId?: string;
      externalId?: string;
      externalParentId?: string | null;
      title?: string;
      path?: string;
      rawPath?: string;
      metadata?: JsonValue;
      publishState?: 'pending' | 'published';
      embedding?: number[] | null;
      content?: string;
      searchText?: string;
    } = {},
  ): Promise<{ documentId: string; chunkId: string }> {
    const runId = input.runId ?? 'run-1';
    const syncId = input.syncId ?? 'sync-1';
    const externalId = input.externalId ?? 'page-1';
    const title = input.title ?? 'Revenue Policy';
    const rawPath = input.rawPath ?? `pages/${externalId}/page.md`;
    const doc = await subject.upsertDocument({
      runId,
      connectionId: 'conn-1',
      sourceKey: 'notion',
      externalId,
      externalParentId: input.externalParentId ?? null,
      databaseId: null,
      dataSourceId: null,
      title,
      path: input.path ?? `Company Handbook / ${title}`,
      url: `https://notion.test/${externalId}`,
      objectType: 'page',
      lastEditedAt: new Date('2026-04-30T10:00:00.000Z'),
      lastEditedBy: 'user-1',
      rawPath,
      syncId,
      contentHash: `hash-${externalId}`,
      publishState: input.publishState ?? 'pending',
      metadata: input.metadata ?? {},
    });
    await subject.replaceChunks(doc.id, [
      {
        chunkKey: 'intro',
        headingPath: ['Revenue'],
        ordinal: 0,
        content: input.content ?? `${title} requires approval from the accountable owner.`,
        searchText: input.searchText ?? `${title} approval accountable owner`,
        embedding: input.embedding ?? [1, 0, 0],
        tokenCount: 8,
        citation: {
          source: 'notion',
          pageId: externalId,
          title,
          syncId,
          rawPath,
        },
        stableCitationKey: `notion:${externalId}:intro`,
        syncId,
        contentHash: `chunk-${externalId}`,
      },
    ]);
    const read = await subject.readDocumentByExternalId('conn-1', 'notion', externalId, runId);
    if (!read) {
      throw new Error(`seeded document ${externalId} was not readable`);
    }
    return { documentId: doc.id, chunkId: read.chunks[0].id };
  }

  function candidate(input: Partial<InsertContextCandidateInput> = {}): InsertContextCandidateInput {
    return {
      runId: input.runId ?? 'run-1',
      connectionId: input.connectionId ?? 'conn-1',
      sourceKey: input.sourceKey ?? 'notion',
      candidateKey: input.candidateKey ?? 'owner-approval-policy',
      topic: input.topic ?? 'Owner approval policy',
      assertion: input.assertion ?? 'Revenue policy changes require an accountable owner.',
      rationale: input.rationale ?? 'The Notion evidence states that owner approval is required.',
      evidenceChunkIds: input.evidenceChunkIds ?? ['chunk-1'],
      evidenceRefs: input.evidenceRefs ?? [
        {
          chunkId: 'chunk-1',
          stableCitationKey: 'notion:page-1:intro',
          syncId: 'sync-1',
          rawPath: 'pages/page-1/page.md',
        },
      ],
      suggestedPageKey: input.suggestedPageKey ?? 'revenue_policy',
      actionHint: input.actionHint ?? 'create',
      durabilityScore: input.durabilityScore ?? 3,
      authorityScore: input.authorityScore ?? 3,
      reuseScore: input.reuseScore ?? 2,
      noveltyScore: input.noveltyScore ?? 2,
      riskScore: input.riskScore ?? 0,
      promotionScore: input.promotionScore ?? 10,
      status: input.status ?? 'pending',
      rejectionReason: input.rejectionReason ?? null,
      lane: input.lane ?? 'full',
      embedding: input.embedding ?? null,
    };
  }

  it('persists evidence documents, chunks, publish state, and retrieval across reopen', async () => {
    const first = store();
    const seeded = await seedDocument(first, {
      metadata: { links: { children: ['child-1'], mentions: ['linked-1'], reverseLinks: ['back-1'] } },
    });
    await seedDocument(first, {
      externalId: 'child-1',
      externalParentId: 'page-1',
      title: 'Child Policy',
      searchText: 'child handbook reference',
      embedding: [0, 1, 0],
    });
    await seedDocument(first, {
      externalId: 'linked-1',
      title: 'Linked Policy',
      searchText: 'linked handbook reference',
      embedding: [0, 1, 0],
    });
    await seedDocument(first, {
      externalId: 'back-1',
      title: 'Backlink Policy',
      searchText: 'backlink handbook reference',
      embedding: [0, 1, 0],
    });

    expect(await first.countPublishedDocumentsByRawPaths('conn-1', 'notion', ['pages/page-1/page.md'])).toBe(0);
    expect(await first.publishSync('conn-1', 'notion', 'sync-1', [])).toEqual({
      documentsPublished: 4,
      documentsDeleted: 0,
    });

    const reopened = store();
    expect(await reopened.countPublishedDocumentsByRawPaths('conn-1', 'notion', ['pages/page-1/page.md'])).toBe(1);
    const search = await reopened.searchRRF({
      connectionId: 'conn-1',
      sourceKey: 'notion',
      queryEmbedding: [0.99, 0.01, 0],
      queryText: 'approval owner',
      limit: 5,
      includeDeleted: false,
    });

    expect(search[0]).toMatchObject({
      documentId: seeded.documentId,
      externalId: 'page-1',
      title: 'Revenue Policy',
      stableCitationKey: 'notion:page-1:intro',
      matchReasons: expect.arrayContaining(['lexical', 'semantic']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'semantic', status: 'available' })]),
    });
    expect(search[0].score).toBeGreaterThan(0);

    await expect(reopened.readChunkById(seeded.chunkId, 'conn-1', 'notion')).resolves.toMatchObject({
      chunk: expect.objectContaining({ id: seeded.chunkId, content: expect.stringContaining('Revenue Policy') }),
      document: expect.objectContaining({ external_id: 'page-1' }),
    });
    await expect(reopened.readDocumentById(seeded.documentId, 'conn-1', 'notion')).resolves.toMatchObject({
      chunks: [expect.objectContaining({ id: seeded.chunkId })],
    });
    await expect(
      reopened.findNeighborDocuments({
        connectionId: 'conn-1',
        sourceKey: 'notion',
        documentId: seeded.documentId,
        relation: 'children',
        limit: 5,
      }),
    ).resolves.toEqual([expect.objectContaining({ externalId: 'child-1', relation: 'children' })]);
    await expect(
      reopened.findNeighborDocuments({
        connectionId: 'conn-1',
        sourceKey: 'notion',
        documentId: seeded.documentId,
        relation: 'linked',
        limit: 5,
      }),
    ).resolves.toEqual([expect.objectContaining({ externalId: 'linked-1', relation: 'linked' })]);
    await expect(
      reopened.findNeighborDocuments({
        connectionId: 'conn-1',
        sourceKey: 'notion',
        documentId: seeded.documentId,
        relation: 'backlinked',
        limit: 5,
      }),
    ).resolves.toEqual([expect.objectContaining({ externalId: 'back-1', relation: 'backlinked' })]);
  });

  it('uses hybrid RRF lanes for context evidence search and exposes match reasons', async () => {
    const subject = store();
    const primary = await seedDocument(subject, {
      externalId: 'page-discount',
      title: 'Enterprise Discount Policy',
      content: 'Enterprise discounts require finance approval before quote approval.',
      searchText: 'enterprise discount finance approval quote',
      embedding: [1, 0, 0],
      publishState: 'published',
    });
    await seedDocument(subject, {
      externalId: 'page-owner',
      title: 'Accountable Owner Policy',
      content: 'Every policy has an accountable owner and review date.',
      searchText: 'accountable owner review date',
      embedding: [0.95, 0.05, 0],
      publishState: 'published',
    });
    await seedDocument(subject, {
      externalId: 'page-expense',
      title: 'Expense Policy',
      content: 'Expense reimbursement requires receipt review.',
      searchText: 'expense reimbursement receipt review',
      embedding: [0, 1, 0],
      publishState: 'published',
    });

    const search = await subject.searchRRF({
      connectionId: 'conn-1',
      sourceKey: 'notion',
      queryEmbedding: [1, 0, 0],
      queryText: 'enterprise discount approval',
      limit: 2,
      includeDeleted: false,
    });

    expect(search).toHaveLength(2);
    expect(search[0]).toMatchObject({
      chunkId: primary.chunkId,
      documentId: primary.documentId,
      externalId: 'page-discount',
      title: 'Enterprise Discount Policy',
      matchReasons: expect.arrayContaining(['lexical', 'semantic', 'token']),
      lanes: expect.arrayContaining([
        expect.objectContaining({ lane: 'lexical', status: 'available', requestedCandidatePoolLimit: 25 }),
        expect.objectContaining({ lane: 'semantic', status: 'available', requestedCandidatePoolLimit: 25 }),
        expect.objectContaining({ lane: 'token', status: 'available', requestedCandidatePoolLimit: 25 }),
      ]),
    });
    expect(search[0].score).toBeCloseTo(1.5 / 61 + 2 / 61 + 0.75 / 61, 8);
    expect(search[1].matchReasons).toContain('semantic');
  });

  it('falls back to token substring matching when FTS has no valid terms', async () => {
    const subject = store();
    await seedDocument(subject, {
      externalId: 'page-cpp',
      title: 'C++ Warehouse Notes',
      content: 'C++ parser notes for warehouse extraction.',
      searchText: 'C++ parser warehouse extraction',
      embedding: null,
      publishState: 'published',
    });

    const search = await subject.searchRRF({
      connectionId: 'conn-1',
      sourceKey: 'notion',
      queryEmbedding: null,
      queryText: '++',
      limit: 5,
      includeDeleted: false,
    });

    expect(search).toHaveLength(1);
    expect(search[0]).toMatchObject({
      externalId: 'page-cpp',
      matchReasons: ['token'],
      lanes: expect.arrayContaining([
        expect.objectContaining({ lane: 'lexical', status: 'skipped', reason: 'fts_query_empty' }),
        expect.objectContaining({ lane: 'semantic', status: 'skipped', reason: 'embedding_unconfigured' }),
        expect.objectContaining({ lane: 'token', status: 'available', returnedCandidateCount: 1 }),
      ]),
    });
  });

  it('keeps current-run and deleted-state visibility filters before hybrid ranking', async () => {
    const subject = store();
    const current = await seedDocument(subject, {
      runId: 'run-current',
      externalId: 'page-current',
      title: 'Current Run Evidence',
      searchText: 'visibility approval current',
      publishState: 'pending',
    });
    await seedDocument(subject, {
      runId: 'run-other',
      externalId: 'page-other-pending',
      title: 'Other Pending Evidence',
      searchText: 'visibility approval other pending',
      publishState: 'pending',
    });
    await seedDocument(subject, {
      runId: 'run-old',
      syncId: 'sync-old',
      externalId: 'page-published',
      title: 'Published Evidence',
      searchText: 'visibility approval published',
      publishState: 'published',
    });
    await subject.publishSync('conn-1', 'notion', 'sync-old', ['pages/page-published/page.md']);

    const search = await subject.searchRRF({
      connectionId: 'conn-1',
      sourceKey: 'notion',
      queryEmbedding: null,
      queryText: 'visibility approval',
      limit: 10,
      includeDeleted: false,
      currentRunId: 'run-current',
    });

    expect(search.map((result) => result.externalId)).toEqual(['page-current']);
    expect(search[0]).toMatchObject({
      chunkId: current.chunkId,
      matchReasons: expect.arrayContaining(['lexical']),
    });

    const deletedIncluded = await subject.searchRRF({
      connectionId: 'conn-1',
      sourceKey: 'notion',
      queryEmbedding: null,
      queryText: 'visibility approval',
      limit: 10,
      includeDeleted: true,
      currentRunId: 'run-current',
    });

    expect(deletedIncluded.map((result) => result.externalId)).toEqual(
      expect.arrayContaining(['page-current', 'page-published']),
    );
  });

  it('supports page triage lanes and light extraction chunk lookup', async () => {
    const subject = store();
    await seedDocument(subject);

    expect(await subject.setDocumentTriageLane('run-1', 'pages/page-1/page.md', 'light')).toBe(1);
    const chunks = await subject.listDocumentChunksForLightExtraction('run-1', 'pages/page-1/page.md');

    expect(chunks).toEqual([
      expect.objectContaining({
        chunkId: expect.any(String),
        headingPath: ['Revenue'],
        rawPath: 'pages/page-1/page.md',
        title: 'Revenue Policy',
        stableCitationKey: 'notion:page-1:intro',
      }),
    ]);
  });

  it('supports candidate writes, dedup state, status updates, and carry-forward reads across reopen', async () => {
    const first = store();
    const seeded = await seedDocument(first);
    await first.publishSync('conn-1', 'notion', 'sync-1', []);

    const primary = await first.insertCandidate(candidate({ evidenceChunkIds: [seeded.chunkId] }));
    const duplicate = await first.insertCandidate(
      candidate({
        candidateKey: 'owner-approval-policy-copy',
        evidenceChunkIds: [seeded.chunkId],
        promotionScore: 6,
      }),
    );
    await first.updateCandidateEmbedding(primary.id, [0.1, 0.2, 0.3]);
    await first.markCandidatesAsMergedToCluster({
      representativeId: primary.id,
      memberIds: [duplicate.id],
      evidenceChunkIds: [seeded.chunkId],
      evidenceRefs: [{ chunkId: seeded.chunkId, stableCitationKey: 'notion:page-1:intro', syncId: 'sync-1' }],
      promotionScore: 16,
    });
    await first.insertCandidate(
      candidate({
        runId: 'old-run',
        candidateKey: 'prior-budget-candidate',
        status: 'rejected',
        rejectionReason: 'exceeded_run_budget',
        evidenceChunkIds: [seeded.chunkId],
      }),
    );

    const reopened = store();
    const pending = await reopened.listPendingCandidatesForDedup('run-1');
    expect(pending).toEqual([
      expect.objectContaining({
        id: primary.id,
        candidateKey: 'owner-approval-policy',
        embedding: JSON.stringify([0.1, 0.2, 0.3]),
        promotionScore: 16,
      }),
    ]);
    await expect(
      reopened.updateCandidateStatus({
        runId: 'run-1',
        candidateKey: 'owner-approval-policy',
        status: 'promoted',
        rejectionReason: null,
      }),
    ).resolves.toMatchObject({ candidate_key: 'owner-approval-policy', status: 'promoted' });
    await expect(
      reopened.listBudgetExhaustedCandidatesForCarryForward({
        connectionId: 'conn-1',
        sourceKey: 'notion',
        currentRunId: 'run-1',
      }),
    ).resolves.toEqual([expect.objectContaining({ candidateKey: 'prior-budget-candidate', sourceRunId: 'old-run' })]);
    await expect(reopened.listCurrentRunEvidenceChunksForCarryForward('run-1')).resolves.toEqual([
      expect.objectContaining({ chunkId: seeded.chunkId, stableCitationKey: 'notion:page-1:intro' }),
    ]);
    await expect(reopened.readChunksByIds([seeded.chunkId], 'conn-1', 'notion')).resolves.toEqual([
      expect.objectContaining({ chunkId: seeded.chunkId, externalId: 'page-1' }),
    ]);
  });

  it('supports curator pagination prompt ordering, rejection marking, and verdict summaries', async () => {
    const subject = store();
    await subject.insertCandidate(
      candidate({
        candidateKey: 'c1',
        topic: 'Revenue policy',
        status: 'pending',
        promotionScore: 10,
      }),
    );
    await subject.insertCandidate(
      candidate({
        candidateKey: 'c2',
        topic: 'Refund policy',
        status: 'promoted',
        promotionScore: 9,
      }),
    );
    await subject.insertCandidate(
      candidate({
        candidateKey: 'c3',
        topic: 'Task backlog',
        status: 'pending',
        promotionScore: 1,
      }),
    );

    await expect(subject.listCandidatesForPromptByKeys('run-1', ['c3', 'c1'])).resolves.toEqual([
      expect.objectContaining({ candidateKey: 'c3', topic: 'Task backlog' }),
      expect.objectContaining({ candidateKey: 'c1', topic: 'Revenue policy' }),
    ]);

    await expect(
      subject.markPendingCandidatesByReason({
        runId: 'run-1',
        candidateKeys: ['c1', 'c2', 'missing'],
        rejectionReason: 'exceeded_curator_passes',
      }),
    ).resolves.toBe(1);

    await expect(subject.summarizeCandidateVerdicts('run-1', ['c1', 'c2', 'c3'])).resolves.toEqual({
      pending: 1,
      promoted: 1,
      merged: 0,
      rejected: 1,
      conflict: 0,
      rejectedByReason: { exceeded_curator_passes: 1 },
    });
  });
});
