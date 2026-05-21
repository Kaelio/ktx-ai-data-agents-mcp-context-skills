import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextEvidenceIndexService } from './context-evidence-index.service.js';
import type { ContextEvidenceIndexStorePort } from './store.js';
import type { ContextEvidenceEmbeddingPort } from './types.js';

const vector384 = (first: number): number[] => [first, ...Array.from({ length: 383 }, () => 0)];

describe('ContextEvidenceIndexService', () => {
  let tmp: string;
  let repository: {
    upsertDocument: ReturnType<typeof vi.fn>;
    replaceChunks: ReturnType<typeof vi.fn>;
    countPublishedDocumentsByRawPaths: ReturnType<typeof vi.fn>;
    publishSync: ReturnType<typeof vi.fn>;
  };
  let embeddings: {
    computeEmbeddingsBulk: ReturnType<typeof vi.fn>;
    maxBatchSize: number;
  };
  let service: ContextEvidenceIndexService;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'context-evidence-'));
    repository = {
      upsertDocument: vi.fn().mockResolvedValue({ id: 'doc-1' }),
      replaceChunks: vi.fn().mockResolvedValue(undefined),
      countPublishedDocumentsByRawPaths: vi.fn().mockResolvedValue(1),
      publishSync: vi.fn().mockResolvedValue({ documentsPublished: 1, documentsDeleted: 0 }),
    };
    embeddings = {
      maxBatchSize: 100,
      computeEmbeddingsBulk: vi
        .fn()
        .mockImplementation((texts: string[]) => texts.map((_text, index) => vector384((index + 1) / 10))),
    };
    service = new ContextEvidenceIndexService({
      store: repository as Partial<ContextEvidenceIndexStorePort> as ContextEvidenceIndexStorePort,
      embeddings: embeddings as Partial<ContextEvidenceEmbeddingPort> as ContextEvidenceEmbeddingPort,
      logger: { warn: vi.fn() },
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('indexes Notion-style page markdown into documents and heading chunks', async () => {
    await writeFile(join(tmp, 'manifest.json'), JSON.stringify({ source: 'notion', apiVersion: '2026-03-11' }));
    await mkdir(join(tmp, 'pages', 'page-1'), { recursive: true });
    await writeFile(
      join(tmp, 'pages', 'page-1', 'metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id: 'page-1',
        title: 'Revenue Recognition',
        path: 'Company Handbook / Finance / Revenue Recognition',
        url: 'https://notion.example/page-1',
        parentId: 'page-parent',
        lastEditedAt: '2026-04-12T10:15:00.000Z',
        lastEditedBy: 'Jane Doe',
        properties: { Status: 'Approved' },
      }),
    );
    await writeFile(
      join(tmp, 'pages', 'page-1', 'page.md'),
      [
        '# Revenue Recognition',
        '',
        '## Policy',
        '',
        'Booked revenue excludes refunds and test accounts.',
        '',
        '## Caveats',
        '',
        'This page supersedes the 2025 Sales Ops revenue definition.',
      ].join('\n'),
    );

    const summary = await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: {
        added: ['pages/page-1/metadata.json', 'pages/page-1/page.md'],
        modified: [],
        deleted: [],
        unchanged: [],
      },
      currentHashes: new Map([
        ['pages/page-1/metadata.json', 'meta-hash'],
        ['pages/page-1/page.md', 'page-hash'],
      ]),
    });

    expect(summary.documentsIndexed).toBe(1);
    expect(summary.chunksIndexed).toBeGreaterThanOrEqual(2);
    expect(repository.upsertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'connection-1',
        runId: 'run-1',
        sourceKey: 'notion',
        externalId: 'page-1',
        title: 'Revenue Recognition',
        path: 'Company Handbook / Finance / Revenue Recognition',
        rawPath: 'pages/page-1/page.md',
        contentHash: 'page-hash',
      }),
    );
    expect(repository.replaceChunks).toHaveBeenCalledWith(
      'doc-1',
      expect.arrayContaining([
        expect.objectContaining({
          chunkKey: 'h2:policy:0000',
          headingPath: ['Revenue Recognition', 'Policy'],
          stableCitationKey: expect.stringMatching(/^notion:page-1:policy:[a-f0-9]{16}$/),
        }),
      ]),
    );
  });

  it('indexes only added or modified page documents by default', async () => {
    for (const pageId of ['changed', 'unchanged']) {
      await mkdir(join(tmp, 'pages', pageId), { recursive: true });
      await writeFile(
        join(tmp, 'pages', pageId, 'metadata.json'),
        JSON.stringify({
          objectType: 'page',
          id: pageId,
          title: pageId === 'changed' ? 'Changed Page' : 'Unchanged Page',
          path: `Company Handbook / ${pageId}`,
        }),
      );
      await writeFile(join(tmp, 'pages', pageId, 'page.md'), `# ${pageId}\n\n${pageId} body`);
    }

    const summary = await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: {
        added: [],
        modified: ['pages/changed/page.md'],
        deleted: [],
        unchanged: ['pages/unchanged/page.md', 'pages/unchanged/metadata.json'],
      },
      currentHashes: new Map([
        ['pages/changed/page.md', 'changed-hash'],
        ['pages/unchanged/page.md', 'unchanged-hash'],
      ]),
    });

    expect(summary.documentsIndexed).toBe(1);
    expect(repository.upsertDocument).toHaveBeenCalledTimes(1);
    expect(repository.upsertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'changed',
        contentHash: 'changed-hash',
      }),
    );
  });

  it('indexes documents when only their metadata changed', async () => {
    for (const pageId of ['metadata-changed', 'unchanged']) {
      await mkdir(join(tmp, 'pages', pageId), { recursive: true });
      await writeFile(
        join(tmp, 'pages', pageId, 'metadata.json'),
        JSON.stringify({
          objectType: 'page',
          id: pageId,
          title: pageId === 'metadata-changed' ? 'Metadata Changed' : 'Unchanged Page',
          path: `Company Handbook / ${pageId}`,
          properties: { Status: pageId === 'metadata-changed' ? 'Approved' : 'Draft' },
        }),
      );
      await writeFile(join(tmp, 'pages', pageId, 'page.md'), `# ${pageId}\n\n${pageId} body`);
    }

    const summary = await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: {
        added: [],
        modified: ['pages/metadata-changed/metadata.json'],
        deleted: [],
        unchanged: ['pages/unchanged/page.md', 'pages/unchanged/metadata.json'],
      },
      currentHashes: new Map([
        ['pages/metadata-changed/page.md', 'metadata-changed-hash'],
        ['pages/unchanged/page.md', 'unchanged-hash'],
      ]),
    });

    expect(summary.documentsIndexed).toBe(1);
    expect(repository.upsertDocument).toHaveBeenCalledTimes(1);
    expect(repository.upsertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'metadata-changed',
        contentHash: 'metadata-changed-hash',
      }),
    );
  });

  it('marks deleted page markdown paths as deleted evidence documents', async () => {
    const summary = await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-2',
      diffSet: {
        added: [],
        modified: [],
        deleted: ['pages/page-1/page.md', 'pages/page-1/metadata.json'],
        unchanged: [],
      },
      currentHashes: new Map(),
    });

    expect(summary.documentsDeleted).toBe(1);
    expect(repository.countPublishedDocumentsByRawPaths).toHaveBeenCalledWith('connection-1', 'notion', [
      'pages/page-1/page.md',
    ]);
  });

  it('falls back to null embeddings when embedding computation fails', async () => {
    embeddings.computeEmbeddingsBulk.mockRejectedValueOnce(new Error('embedding provider unavailable'));
    await writeFile(join(tmp, 'manifest.json'), JSON.stringify({ source: 'notion', apiVersion: '2026-03-11' }));
    await mkdir(join(tmp, 'pages', 'page-2'), { recursive: true });
    await writeFile(
      join(tmp, 'pages', 'page-2', 'metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id: 'page-2',
        title: 'Glossary',
        path: 'Company Handbook / Glossary',
      }),
    );
    await writeFile(join(tmp, 'pages', 'page-2', 'page.md'), '# Glossary\n\nARR means annual recurring revenue.');

    const summary = await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: { added: ['pages/page-2/page.md'], modified: [], deleted: [], unchanged: [] },
      currentHashes: new Map([['pages/page-2/page.md', 'page-hash']]),
    });

    expect(summary.embeddingFailures).toBe(1);
    expect(repository.replaceChunks).toHaveBeenCalledWith(
      'doc-1',
      expect.arrayContaining([expect.objectContaining({ embedding: null })]),
    );
  });

  it('batches embedding requests at the provider batch size', async () => {
    embeddings.computeEmbeddingsBulk.mockImplementation((texts: string[]) => {
      if (texts.length > 100) {
        throw new Error('too many texts');
      }
      return texts.map((_text, index) => vector384(index / 100));
    });
    await mkdir(join(tmp, 'pages', 'large-page'), { recursive: true });
    await writeFile(
      join(tmp, 'pages', 'large-page', 'metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id: 'large-page',
        title: 'Large Page',
        path: 'Company Handbook / Large Page',
      }),
    );
    await writeFile(
      join(tmp, 'pages', 'large-page', 'page.md'),
      Array.from({ length: 101 }, (_value, index) =>
        [`## Section ${index + 1}`, '', `Body ${index + 1}`].join('\n'),
      ).join('\n\n'),
    );

    const summary = await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: { added: ['pages/large-page/page.md'], modified: [], deleted: [], unchanged: [] },
      currentHashes: new Map([['pages/large-page/page.md', 'large-hash']]),
    });

    expect(summary.embeddingFailures).toBe(0);
    expect(embeddings.computeEmbeddingsBulk).toHaveBeenCalledTimes(2);
    expect(embeddings.computeEmbeddingsBulk.mock.calls.map(([texts]) => texts)).toEqual([
      expect.arrayContaining([expect.stringContaining('Section 1')]),
      expect.arrayContaining([expect.stringContaining('Section 101')]),
    ]);
    expect(embeddings.computeEmbeddingsBulk.mock.calls[0][0]).toHaveLength(100);
    expect(embeddings.computeEmbeddingsBulk.mock.calls[1][0]).toHaveLength(1);
    expect(repository.replaceChunks).toHaveBeenCalledWith(
      'doc-1',
      expect.arrayContaining([expect.objectContaining({ embedding: expect.any(Array) })]),
    );
  });

  it('splits single long paragraphs into bounded chunks', async () => {
    await mkdir(join(tmp, 'pages', 'long-paragraph'), { recursive: true });
    await writeFile(
      join(tmp, 'pages', 'long-paragraph', 'metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id: 'long-paragraph',
        title: 'Long Paragraph',
        path: 'Company Handbook / Long Paragraph',
      }),
    );
    await writeFile(join(tmp, 'pages', 'long-paragraph', 'page.md'), `# Long Paragraph\n\n${'x'.repeat(12_000)}`);

    await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: { added: ['pages/long-paragraph/page.md'], modified: [], deleted: [], unchanged: [] },
      currentHashes: new Map([['pages/long-paragraph/page.md', 'long-hash']]),
    });

    const chunks = repository.replaceChunks.mock.calls[0][1] as Array<{ content: string }>;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 4800)).toBe(true);
  });

  it('creates unique stable citation keys for duplicate heading leaves', async () => {
    embeddings.computeEmbeddingsBulk.mockImplementation((texts: string[]) =>
      texts.map((_text, index) => vector384(index / 10)),
    );
    await mkdir(join(tmp, 'pages', 'duplicate-headings'), { recursive: true });
    await writeFile(
      join(tmp, 'pages', 'duplicate-headings', 'metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id: 'duplicate-headings',
        title: 'Duplicate Headings',
        path: 'Company Handbook / Duplicate Headings',
      }),
    );
    await writeFile(
      join(tmp, 'pages', 'duplicate-headings', 'page.md'),
      [
        '# Duplicate Headings',
        '',
        '## Overview',
        '',
        'First overview.',
        '',
        '## Overview',
        '',
        'Second overview.',
      ].join('\n'),
    );

    await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: { added: ['pages/duplicate-headings/page.md'], modified: [], deleted: [], unchanged: [] },
      currentHashes: new Map([['pages/duplicate-headings/page.md', 'duplicate-hash']]),
    });

    const chunks = repository.replaceChunks.mock.calls[0][1];
    const citationKeys = chunks.map((chunk: { stableCitationKey: string }) => chunk.stableCitationKey);
    expect(new Set(citationKeys).size).toBe(citationKeys.length);
    expect(citationKeys).toEqual([
      expect.stringMatching(/^notion:duplicate-headings:overview:[a-f0-9]{16}$/),
      expect.stringMatching(/^notion:duplicate-headings:overview:[a-f0-9]{16}$/),
    ]);
  });

  it('persists Notion links metadata for neighbor lookup', async () => {
    await mkdir(join(tmp, 'pages', 'page-root'), { recursive: true });
    await writeFile(
      join(tmp, 'pages/page-root/metadata.json'),
      JSON.stringify({
        objectType: 'page',
        id: 'page-root',
        title: 'Root',
        path: 'Root',
      }),
    );
    await writeFile(join(tmp, 'pages/page-root/page.md'), '# Root\n\nSee linked pages.');
    await writeFile(
      join(tmp, 'pages/page-root/links.json'),
      JSON.stringify({
        children: ['page-child'],
        reverseLinks: ['page-parent'],
        mentions: ['page-mentioned'],
        databases: [],
      }),
    );

    await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: { added: ['pages/page-root/links.json'], modified: [], deleted: [], unchanged: [] },
      currentHashes: new Map(),
      forceRebuild: true,
    });

    expect(repository.upsertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          linksPath: 'pages/page-root/links.json',
          links: expect.objectContaining({
            children: ['page-child'],
            reverseLinks: ['page-parent'],
            mentions: ['page-mentioned'],
          }),
        }),
      }),
    );
  });

  it('indexes data-source row metadata as the surviving document form', async () => {
    await mkdir(join(tmp, 'data-sources/data-source-1/rows/row-1'), { recursive: true });
    await writeFile(
      join(tmp, 'data-sources/data-source-1/rows/row-1/metadata.json'),
      JSON.stringify({
        objectType: 'data_source_row',
        id: 'row-1',
        title: 'Row One',
        path: 'Policies / Row One',
        parentId: 'data-source-1',
        databaseId: null,
        dataSourceId: 'data-source-1',
        properties: {},
      }),
    );
    await writeFile(join(tmp, 'data-sources/data-source-1/rows/row-1/page.md'), '# Row One\n\nDurable row fact.');

    await service.indexStagedDir({
      stagedDir: tmp,
      runId: 'run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
      syncId: 'sync-1',
      diffSet: {
        added: ['data-sources/data-source-1/rows/row-1/metadata.json', 'data-sources/data-source-1/rows/row-1/page.md'],
        modified: [],
        deleted: [],
        unchanged: [],
      },
      currentHashes: new Map([['data-sources/data-source-1/rows/row-1/page.md', 'row-hash']]),
    });

    expect(repository.upsertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'row-1',
        objectType: 'data_source_row',
        dataSourceId: 'data-source-1',
        rawPath: 'data-sources/data-source-1/rows/row-1/page.md',
      }),
    );
  });
});
