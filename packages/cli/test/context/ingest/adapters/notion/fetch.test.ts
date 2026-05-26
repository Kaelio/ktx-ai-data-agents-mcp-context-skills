import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchNotionSnapshot } from '../../../../../src/context/ingest/adapters/notion/fetch.js';
import type { NotionApi } from '../../../../../src/context/ingest/adapters/notion/notion-client.js';

describe('fetchNotionSnapshot', () => {
  let stagedDir: string;
  let client: NotionApi;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'notion-fetch-'));
    client = {
      search: vi.fn().mockResolvedValue({ results: [], hasMore: false, nextCursor: null }),
      retrieveBotUser: vi.fn().mockResolvedValue({ name: 'Notion bot' }),
      retrievePage: vi.fn().mockImplementation((pageId: string) => ({
        id: pageId,
        url: `https://notion.example/${pageId}`,
        parent: pageId.startsWith('row-')
          ? { type: 'data_source_id', data_source_id: 'data-source-search' }
          : { type: 'page_id', page_id: 'root' },
        last_edited_time: '2026-04-12T10:15:00.000Z',
        last_edited_by: { type: 'person', name: 'Jane Doe', person: {} },
        properties: { Name: { type: 'title', title: [{ plain_text: pageId === 'row-1' ? 'Row One' : pageId }] } },
      })),
      retrieveDatabase: vi.fn().mockResolvedValue({
        id: 'database-1',
        data_sources: [{ id: 'data-source-1', name: 'Policies' }],
      }),
      queryDataSource: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'row-1',
            url: 'https://notion.example/row-1',
            parent: { type: 'data_source_id', data_source_id: 'data-source-1' },
            last_edited_time: '2026-04-12T10:15:00.000Z',
            properties: { Name: { type: 'title', title: [{ plain_text: 'Row One' }] } },
          },
        ],
        hasMore: false,
        nextCursor: null,
      }),
      listBlockChildren: vi.fn().mockResolvedValue({
        results: [
          { id: 'h1', type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Policy' }] } },
          { id: 'p1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Durable rule.' }] } },
        ],
        hasMore: false,
        nextCursor: null,
      }),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('materializes selected root pages and database data-source rows', async () => {
    await fetchNotionSnapshot({
      client,
      stagedDir,
      config: {
        authToken: 'secret',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1'],
        rootDatabaseIds: ['database-1'],
        rootDataSourceIds: [],
        maxPagesPerRun: 10,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({
      source: 'notion',
      apiVersion: '2026-03-11',
      pageCount: 2,
      databaseCount: 1,
      dataSourceCount: 1,
    });
    await expect(readFile(join(stagedDir, 'pages/page-1/page.md'), 'utf-8')).resolves.toContain('Durable rule.');
    await expect(
      readFile(join(stagedDir, 'databases/database-1/data-sources/data-source-1/rows/row-1/page.md'), 'utf-8'),
    ).resolves.toContain('Row One');
  });

  it('logs skipped page materialization failures', async () => {
    const logger = { warn: vi.fn() };
    (client.retrievePage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Notion API failed'));

    const manifest = await fetchNotionSnapshot({
      client,
      stagedDir,
      logger,
      config: {
        authToken: 'secret',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        maxPagesPerRun: 10,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    expect(manifest.skipped).toEqual([{ externalId: 'page-1', reason: 'Notion API failed' }]);
    expect(logger.warn).toHaveBeenCalledWith('Skipping Notion page page-1: Notion API failed');
  });

  it('recursively fetches selected-root child pages and derives scoped links', async () => {
    (client.retrievePage as ReturnType<typeof vi.fn>).mockImplementation((pageId: string) => ({
      id: pageId,
      url: `https://notion.example/${pageId}`,
      parent:
        pageId === 'child-page' ? { type: 'page_id', page_id: 'root-page' } : { type: 'workspace', workspace: true },
      last_edited_time: '2026-04-12T10:15:00.000Z',
      properties: {
        Name: { type: 'title', title: [{ plain_text: pageId === 'root-page' ? 'Root Page' : 'Child Page' }] },
        Related: pageId === 'root-page' ? { type: 'relation', relation: [{ id: 'child-page' }] } : undefined,
      },
    }));
    (client.listBlockChildren as ReturnType<typeof vi.fn>).mockImplementation((blockId: string) => ({
      results:
        blockId === 'root-page'
          ? [
              { id: 'child-page', type: 'child_page', child_page: { title: 'Child Page' } },
              {
                id: 'page-link',
                type: 'link_to_page',
                link_to_page: { type: 'page_id', page_id: 'child-page' },
              },
              {
                id: 'db-link',
                type: 'link_to_page',
                link_to_page: { type: 'database_id', database_id: 'database-1' },
              },
            ]
          : [
              {
                id: 'mention-root',
                type: 'paragraph',
                paragraph: {
                  rich_text: [
                    {
                      plain_text: 'See Root Page',
                      mention: { type: 'page', page: { id: 'root-page' } },
                    },
                  ],
                },
              },
            ],
      hasMore: false,
      nextCursor: null,
    }));

    await fetchNotionSnapshot({
      client,
      stagedDir,
      config: {
        authToken: 'secret',
        crawlMode: 'selected_roots',
        rootPageIds: ['root-page'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        maxPagesPerRun: 10,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    const rootLinks = JSON.parse(await readFile(join(stagedDir, 'pages/root-page/links.json'), 'utf-8'));
    const childLinks = JSON.parse(await readFile(join(stagedDir, 'pages/child-page/links.json'), 'utf-8'));
    expect(rootLinks).toMatchObject({
      children: ['child-page'],
      reverseLinks: ['child-page'],
      mentions: ['child-page'],
      databases: ['database-1'],
    });
    expect(childLinks).toMatchObject({
      children: [],
      reverseLinks: ['root-page'],
      mentions: ['root-page'],
      databases: [],
    });
  });

  it('truncates deeply nested block trees and records a warning', async () => {
    const logger = { warn: vi.fn() };
    (client.listBlockChildren as ReturnType<typeof vi.fn>).mockImplementation((blockId: string) => {
      const currentDepth = blockId === 'page-1' ? 0 : Number(blockId.replace('block-', ''));
      const nextDepth = currentDepth + 1;
      return {
        results:
          nextDepth <= 12
            ? [
                {
                  id: `block-${nextDepth}`,
                  type: 'paragraph',
                  has_children: nextDepth < 12,
                  paragraph: { rich_text: [{ plain_text: `Depth ${nextDepth}` }] },
                },
              ]
            : [],
        hasMore: false,
        nextCursor: null,
      };
    });

    await fetchNotionSnapshot({
      client,
      stagedDir,
      logger,
      config: {
        authToken: 'secret',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        maxPagesPerRun: 10,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    const blocks = JSON.parse(await readFile(join(stagedDir, 'pages/page-1/blocks.json'), 'utf-8'));
    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8'));
    expect(blocks).toHaveLength(10);
    expect(manifest.warnings).toContain('maxBlockDepth reached for page page-1 at depth 10');
    expect(logger.warn).toHaveBeenCalledWith('maxBlockDepth reached for page page-1 at depth 10');
  });

  it('truncates pages at the per-page block cap and records a warning', async () => {
    const logger = { warn: vi.fn() };
    (client.listBlockChildren as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: Array.from({ length: 2001 }, (_, index) => ({
        id: `block-${index}`,
        type: 'paragraph',
        paragraph: { rich_text: [{ plain_text: `Block ${index}` }] },
      })),
      hasMore: false,
      nextCursor: null,
    });

    await fetchNotionSnapshot({
      client,
      stagedDir,
      logger,
      config: {
        authToken: 'secret',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        maxPagesPerRun: 10,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    const blocks = JSON.parse(await readFile(join(stagedDir, 'pages/page-1/blocks.json'), 'utf-8'));
    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8'));
    expect(blocks).toHaveLength(2000);
    expect(manifest.warnings).toContain('maxBlocksPerPage reached for page page-1 at 2000 blocks');
    expect(logger.warn).toHaveBeenCalledWith('maxBlocksPerPage reached for page page-1 at 2000 blocks');
  });

  it('uses all_accessible search for pages and data sources', async () => {
    (client.search as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: [{ id: 'page-search', object: 'page' }], hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({
        results: [{ id: 'data-source-search', object: 'data_source' }],
        hasMore: false,
        nextCursor: null,
      });

    await fetchNotionSnapshot({
      client,
      stagedDir,
      config: {
        authToken: 'secret',
        crawlMode: 'all_accessible',
        rootPageIds: [],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        maxPagesPerRun: 10,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    expect(client.search).toHaveBeenCalledWith('page', null, 10);
    expect(client.search).toHaveBeenCalledWith('data_source', null, 1);
    await expect(readFile(join(stagedDir, 'pages/page-search/page.md'), 'utf-8')).resolves.toContain('Durable rule.');
    await expect(
      readFile(join(stagedDir, 'data-sources/data-source-search/rows/row-1/page.md'), 'utf-8'),
    ).resolves.toContain('Row One');
  });

  it('does not write a duplicate generic page snapshot when page search sees a data-source row first', async () => {
    (client.search as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: [{ id: 'row-1', object: 'page' }], hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({
        results: [{ id: 'data-source-search', object: 'data_source' }],
        hasMore: false,
        nextCursor: null,
      });

    await fetchNotionSnapshot({
      client,
      stagedDir,
      config: {
        authToken: 'secret',
        crawlMode: 'all_accessible',
        rootPageIds: [],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        maxPagesPerRun: 10,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    await expect(readFile(join(stagedDir, 'pages/row-1/page.md'), 'utf-8')).rejects.toThrow();
    await expect(
      readFile(join(stagedDir, 'data-sources/data-source-search/rows/row-1/page.md'), 'utf-8'),
    ).resolves.toContain('Row One');
    const rowMetadata = JSON.parse(
      await readFile(join(stagedDir, 'data-sources/data-source-search/rows/row-1/metadata.json'), 'utf-8'),
    );
    expect(rowMetadata).toMatchObject({ objectType: 'data_source_row', dataSourceId: 'data-source-search' });
  });

  it('caps page materialization at maxPagesPerRun', async () => {
    await fetchNotionSnapshot({
      client,
      stagedDir,
      config: {
        authToken: 'secret',
        crawlMode: 'selected_roots',
        rootPageIds: ['page-1', 'page-2'],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        maxPagesPerRun: 1,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8'));
    expect(manifest.capped).toBe(true);
    expect(manifest.partialSnapshot).toBe(true);
    expect(manifest.pageCount).toBe(1);
  });

  it('short-circuits all_accessible pagination and records a continuation cursor when capped', async () => {
    (client.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [{ id: 'page-1', object: 'page' }],
      hasMore: true,
      nextCursor: 'next-page-cursor',
    });

    await fetchNotionSnapshot({
      client,
      stagedDir,
      config: {
        authToken: 'secret',
        crawlMode: 'all_accessible',
        rootPageIds: [],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        maxPagesPerRun: 1,
        maxKnowledgeCreatesPerRun: 5,
        maxKnowledgeUpdatesPerRun: 20,
        lastSuccessfulCursor: null,
      },
    });

    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({ capped: true, continuedFromCursor: false, partialSnapshot: true, pageCount: 1 });
    expect(JSON.parse(manifest.nextSuccessfulCursor)).toEqual({
      phase: 'all_accessible_pages',
      cursor: 'next-page-cursor',
    });
    expect(client.search).not.toHaveBeenCalledWith('data_source', expect.anything(), expect.anything());
  });
});
