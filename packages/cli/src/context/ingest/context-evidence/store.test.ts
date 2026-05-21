import { describe, expect, it, vi } from 'vitest';
import type { ContextEvidenceIndexStorePort } from './store.js';
import type { ReplaceContextEvidenceChunk, UpsertContextEvidenceDocument } from './types.js';

const documentInput: UpsertContextEvidenceDocument = {
  runId: 'run-1',
  connectionId: 'connection-1',
  sourceKey: 'notion',
  externalId: 'page-1',
  externalParentId: null,
  databaseId: null,
  dataSourceId: null,
  title: 'Revenue Recognition',
  path: 'Company Handbook / Finance / Revenue Recognition',
  url: 'https://notion.example/page-1',
  objectType: 'page',
  lastEditedAt: new Date('2026-04-12T10:15:00.000Z'),
  lastEditedBy: 'Jane Doe',
  rawPath: 'pages/page-1/page.md',
  syncId: 'sync-1',
  contentHash: 'page-hash',
  publishState: 'pending',
  metadata: { properties: { Status: 'Approved' } },
};

const chunkInput: ReplaceContextEvidenceChunk = {
  chunkKey: 'h2:policy:0000',
  headingPath: ['Revenue Recognition', 'Policy'],
  ordinal: 0,
  content: 'Booked revenue excludes refunds and test accounts.',
  searchText: 'Revenue Recognition\nPolicy\nBooked revenue excludes refunds and test accounts.',
  embedding: [0.1, 0.2, 0.3],
  tokenCount: 8,
  citation: {
    source: 'notion',
    pageId: 'page-1',
    title: 'Revenue Recognition',
    path: 'Company Handbook / Finance / Revenue Recognition',
    rawPath: 'pages/page-1/page.md',
  },
  stableCitationKey: 'notion:page-1:policy:abc123',
  syncId: 'sync-1',
  contentHash: 'chunk-hash',
};

describe('ContextEvidenceIndexStorePort', () => {
  it('describes the persistence operations required by the package indexer', async () => {
    const store: ContextEvidenceIndexStorePort = {
      upsertDocument: vi.fn().mockResolvedValue({ id: 'doc-1' }),
      replaceChunks: vi.fn().mockResolvedValue(undefined),
      countPublishedDocumentsByRawPaths: vi.fn().mockResolvedValue(1),
      publishSync: vi.fn().mockResolvedValue({ documentsPublished: 1, documentsDeleted: 0 }),
    };

    await expect(store.upsertDocument(documentInput)).resolves.toEqual({ id: 'doc-1' });
    await store.replaceChunks('doc-1', [chunkInput]);
    await expect(
      store.countPublishedDocumentsByRawPaths('connection-1', 'notion', ['pages/page-1/page.md']),
    ).resolves.toBe(1);
    await expect(
      store.publishSync('connection-1', 'notion', 'sync-1', ['pages/page-1/page.md']),
    ).resolves.toEqual({ documentsPublished: 1, documentsDeleted: 0 });

    expect(store.replaceChunks).toHaveBeenCalledWith('doc-1', [chunkInput]);
  });
});
