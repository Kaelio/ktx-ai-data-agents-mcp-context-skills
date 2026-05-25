import { describe, expect, it, vi } from 'vitest';
import { KnowledgeWikiService, type WikiFrontmatter } from '../../../src/context/wiki/knowledge-wiki.service.js';

function makeService() {
  const pagesRepository: Record<string, ReturnType<typeof vi.fn>> = {
    upsertPage: vi.fn().mockResolvedValue(undefined),
    deleteByKey: vi.fn().mockResolvedValue(0),
    deleteByScope: vi.fn().mockResolvedValue(0),
    deleteStale: vi.fn().mockResolvedValue(0),
    getExistingSearchTexts: vi.fn().mockResolvedValue(new Map()),
    applyDiffTransactional: vi.fn().mockResolvedValue(undefined),
  };
  const embeddingService = {
    computeEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    computeEmbeddingsBulk: vi.fn().mockResolvedValue([]),
    maxBatchSize: 16,
  };
  const configService = {
    forWorktree: vi.fn().mockReturnValue({
      writeFile: vi.fn(),
      readFile: vi.fn(),
      deleteFile: vi.fn(),
      listFiles: vi.fn(),
      getFileHistory: vi.fn(),
    }),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    deleteFile: vi.fn(),
    listFiles: vi.fn(),
    getFileHistory: vi.fn(),
  };
  const gitService = {
    diffNameStatus: vi.fn().mockResolvedValue([]),
    getFileAtCommit: vi.fn().mockResolvedValue(''),
  };
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = new KnowledgeWikiService(
    configService as any,
    embeddingService as any,
    pagesRepository as any,
    gitService as any,
    logger as any,
  );
  return { service, pagesRepository, embeddingService, configService, gitService, logger };
}

const fm: WikiFrontmatter = { summary: 'sum', usage_mode: 'auto' };

describe('KnowledgeWikiService file reads', () => {
  it('warns and returns null when an existing page cannot be parsed', async () => {
    const { service, configService, logger } = makeService();
    configService.readFile.mockResolvedValue({ content: '---\nsummary: [\n---\nBody' });

    await expect(service.readPage('GLOBAL', null, 'revenue')).resolves.toBeNull();

    expect(configService.readFile).toHaveBeenCalledWith('wiki/global/revenue.md');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[readPage] wiki/global/revenue.md: parse failed:'));
  });

  it('warns and returns an empty page list when directory listing fails', async () => {
    const { service, configService, logger } = makeService();
    configService.listFiles.mockRejectedValue(new Error('filesystem unavailable'));

    await expect(service.listPageKeys('GLOBAL', null)).resolves.toEqual([]);

    expect(logger.warn).toHaveBeenCalledWith('[listPageKeys] wiki/global: filesystem unavailable');
  });
});

describe('KnowledgeWikiService.syncIndex result stats', () => {
  it('reports scanned, updated, deleted, and embedding counts', async () => {
    const { service, pagesRepository, embeddingService, configService } = makeService();
    configService.listFiles.mockResolvedValue({ files: ['wiki/global/revenue.md'] });
    configService.readFile.mockResolvedValue({
      content: '---\nsummary: Revenue\nusage_mode: auto\ntags:\n  - finance\n---\n\nPaid orders.\n',
    });
    pagesRepository.getExistingSearchTexts.mockResolvedValue(
      new Map([
        ['old-page', { searchText: 'old', hasEmbedding: true }],
      ]),
    );
    embeddingService.computeEmbeddingsBulk.mockResolvedValue([[0.1, 0.2, 0.3]]);
    pagesRepository.deleteStale.mockResolvedValue(1);

    await expect(service.syncIndex('GLOBAL', null)).resolves.toEqual({
      scanned: 1,
      updated: 1,
      deleted: 1,
      embeddingsRecomputed: 1,
      embeddingsFailed: 0,
    });
  });

  it('indexes lexical rows when embeddings are not configured', async () => {
    const { pagesRepository, configService, gitService, logger } = makeService();
    const service = new KnowledgeWikiService(
      configService as any,
      null,
      pagesRepository as any,
      gitService as any,
      logger as any,
    );
    configService.listFiles.mockResolvedValue({ files: ['wiki/global/revenue.md'] });
    configService.readFile.mockResolvedValue({
      content: '---\nsummary: Revenue\nusage_mode: auto\n---\n\nPaid orders.\n',
    });
    pagesRepository.getExistingSearchTexts.mockResolvedValue(new Map());
    pagesRepository.deleteStale.mockResolvedValue(0);

    const result = await service.syncIndex('GLOBAL', null);

    expect(result.embeddingsRecomputed).toBe(0);
    expect(result.embeddingsFailed).toBe(0);
    expect(pagesRepository.upsertPage).toHaveBeenCalledWith(
      expect.objectContaining({ pageKey: 'revenue', embedding: null }),
    );
  });

  it('does not update unchanged lexical-only wiki rows on repeated sync', async () => {
    const { pagesRepository, configService, gitService, logger } = makeService();
    const service = new KnowledgeWikiService(
      configService as any,
      null,
      pagesRepository as any,
      gitService as any,
      logger as any,
    );
    configService.listFiles.mockResolvedValue({ files: ['wiki/global/revenue.md'] });
    configService.readFile.mockResolvedValue({
      content: '---\nsummary: Revenue\nusage_mode: auto\n---\n\nPaid orders.\n',
    });
    pagesRepository.getExistingSearchTexts.mockResolvedValue(
      new Map([
        ['revenue', { searchText: 'revenue\nRevenue\nPaid orders.', hasEmbedding: false }],
      ]),
    );
    pagesRepository.deleteStale.mockResolvedValue(0);

    await expect(service.syncIndex('GLOBAL', null)).resolves.toEqual({
      scanned: 1,
      updated: 0,
      deleted: 0,
      embeddingsRecomputed: 0,
      embeddingsFailed: 0,
    });
    expect(pagesRepository.upsertPage).not.toHaveBeenCalled();
    expect(pagesRepository.deleteStale).toHaveBeenCalledWith('GLOBAL', null, ['revenue']);
  });
});

describe('KnowledgeWikiService.forWorktree isolation', () => {
  it('syncSinglePage in worktree scope does not call pagesRepository.upsertPage', async () => {
    const { service, pagesRepository, embeddingService } = makeService();
    const scoped = service.forWorktree('/tmp/fake-worktree');

    await scoped.syncSinglePage('GLOBAL', null, 'key', fm, 'body');

    expect(pagesRepository.upsertPage).not.toHaveBeenCalled();
    expect(embeddingService.computeEmbedding).not.toHaveBeenCalled();
  });

  it('deleteFromIndex in worktree scope does not call pagesRepository.deleteByKey', async () => {
    const { service, pagesRepository } = makeService();
    const scoped = service.forWorktree('/tmp/fake-worktree');

    await scoped.deleteFromIndex('GLOBAL', null, 'key');

    expect(pagesRepository.deleteByKey).not.toHaveBeenCalled();
  });

  it('syncSinglePage in main scope still calls pagesRepository.upsertPage', async () => {
    const { service, pagesRepository } = makeService();

    await service.syncSinglePage('GLOBAL', null, 'key', fm, 'body');

    expect(pagesRepository.upsertPage).toHaveBeenCalledTimes(1);
  });
});

describe('KnowledgeWikiService.syncFromCommit', () => {
  it('applies upserts for added/modified files and deletes for removed files in a single transactional batch', async () => {
    const { service, pagesRepository, gitService } = makeService();

    gitService.diffNameStatus.mockResolvedValue([
      { status: 'A', path: 'wiki/global/new-page.md' },
      { status: 'M', path: 'wiki/global/changed-page.md' },
      { status: 'D', path: 'wiki/global/gone-page.md' },
    ]);
    gitService.getFileAtCommit.mockImplementation((path: string) => {
      if (path.endsWith('new-page.md')) {
        return Promise.resolve('---\nsummary: new\nusage_mode: auto\n---\n\nbody-new\n');
      }
      if (path.endsWith('changed-page.md')) {
        return Promise.resolve('---\nsummary: changed\nusage_mode: auto\n---\n\nbody-changed\n');
      }
      return Promise.reject(new Error(`unexpected getFileAtCommit path: ${path}`));
    });

    await service.syncFromCommit('sha-before', 'sha-after', 'run-uuid');

    expect(pagesRepository.applyDiffTransactional).toHaveBeenCalledTimes(1);
    const call = pagesRepository.applyDiffTransactional.mock.calls[0][0];
    expect(call.runId).toBe('run-uuid');
    expect(call.upserts).toHaveLength(2);
    expect(call.upserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'GLOBAL', pageKey: 'new-page', summary: 'new' }),
        expect.objectContaining({ scope: 'GLOBAL', pageKey: 'changed-page', summary: 'changed' }),
      ]),
    );
    expect(call.deletes).toEqual([{ scope: 'GLOBAL', scopeId: null, pageKey: 'gone-page' }]);
  });

  it('indexes only flat wiki pages and skips nested paths from commit sync', async () => {
    const { service, pagesRepository, gitService, logger } = makeService();

    gitService.diffNameStatus.mockResolvedValue([
      { status: 'A', path: 'wiki/global/revenue-policy.md' },
      { status: 'A', path: 'wiki/global/historic-sql-order-lifecycle.md' },
      { status: 'A', path: 'wiki/global/historic-sql/order-lifecycle.md' },
      { status: 'A', path: 'wiki/global/orbit/company-overview.md' },
    ]);
    gitService.getFileAtCommit.mockImplementation((path: string) => {
      if (path.endsWith('revenue-policy.md')) {
        return Promise.resolve('---\nsummary: revenue\nusage_mode: auto\n---\n\nbody-revenue\n');
      }
      if (path.endsWith('order-lifecycle.md')) {
        return Promise.resolve('---\nsummary: order lifecycle\nusage_mode: auto\n---\n\nbody-orders\n');
      }
      if (path.endsWith('retired-pattern.md')) {
        return Promise.resolve('---\nsummary: retired\nusage_mode: never\n---\n\nbody-retired\n');
      }
      return Promise.reject(new Error(`unexpected getFileAtCommit path: ${path}`));
    });

    await service.syncFromCommit('sha-before', 'sha-after', 'run-uuid');

    expect(gitService.getFileAtCommit).not.toHaveBeenCalledWith('wiki/global/orbit/company-overview.md', 'sha-after');
    expect(gitService.getFileAtCommit).not.toHaveBeenCalledWith('wiki/global/historic-sql/order-lifecycle.md', 'sha-after');
    expect(logger.warn).toHaveBeenCalledWith(
      '[wiki.sync] skipping unparseable path: wiki/global/orbit/company-overview.md',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[wiki.sync] skipping unparseable path: wiki/global/historic-sql/order-lifecycle.md',
    );
    const call = pagesRepository.applyDiffTransactional.mock.calls[0][0];
    expect(call.upserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'GLOBAL', pageKey: 'revenue-policy', summary: 'revenue' }),
        expect.objectContaining({
          scope: 'GLOBAL',
          pageKey: 'historic-sql-order-lifecycle',
          summary: 'order lifecycle',
        }),
      ]),
    );
    expect(call.upserts).toHaveLength(2);
  });

  it('is a no-op when the diff between shas has no knowledge changes', async () => {
    const { service, pagesRepository, gitService } = makeService();
    gitService.diffNameStatus.mockResolvedValue([]);

    await service.syncFromCommit('sha-before', 'sha-after', 'run-uuid');

    expect(pagesRepository.applyDiffTransactional).not.toHaveBeenCalled();
  });
});
