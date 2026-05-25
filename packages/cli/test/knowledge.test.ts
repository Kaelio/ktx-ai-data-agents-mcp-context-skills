import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { initKtxProject, loadKtxProject } from '../src/context/project/project.js';
import type { KtxEmbeddingPort } from '../src/context/core/embedding.js';
import { writeLocalKnowledgePage } from '../src/context/wiki/local-knowledge.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxKnowledge } from '../src/knowledge.js';

function makeIo(options: { isTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.isTTY,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

class FakeEmbeddingPort implements KtxEmbeddingPort {
  readonly maxBatchSize = 16;

  async computeEmbedding(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    return lower.includes('revenue') || lower.includes('arr') ? [1, 0] : [0, 1];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.computeEmbedding(text)));
  }
}

interface WikiPageFixture {
  key?: string;
  summary?: string;
  content?: string;
  tags?: string[];
  slRefs?: string[];
}

async function seedWikiPage(projectDir: string, fixture: WikiPageFixture = {}): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  await writeLocalKnowledgePage(project, {
    key: fixture.key ?? 'metrics-revenue',
    scope: 'GLOBAL',
    userId: 'local',
    summary: fixture.summary ?? 'Revenue',
    content: fixture.content ?? 'Revenue is paid order value.',
    tags: fixture.tags ?? ['finance'],
    refs: [],
    slRefs: fixture.slRefs ?? ['orders'],
  });
}

describe('runKtxKnowledge', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-knowledge-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists and searches wiki pages', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await seedWikiPage(projectDir);

    const listIo = makeIo();
    await expect(
      runKtxKnowledge({ command: 'list', projectDir, userId: 'local', cliVersion: '0.0.0-test' }, listIo.io),
    ).resolves.toBe(0);
    expect(listIo.stdout()).toContain('GLOBAL\tmetrics-revenue\tRevenue');

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge(
        { command: 'search', projectDir, query: 'paid order', userId: 'local', cliVersion: '0.0.0-test' },
        searchIo.io,
      ),
    ).resolves.toBe(0);
    expect(searchIo.stdout()).toContain('metrics-revenue');
  });

  it('emits debug telemetry for wiki search without query text', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await seedWikiPage(projectDir);
    const searchIo = makeIo({ isTTY: true });

    await expect(
      runKtxKnowledge(
        { command: 'search', projectDir, query: 'revenue recognition', userId: 'local', cliVersion: '0.0.0-test' },
        searchIo.io,
      ),
    ).resolves.toBe(0);

    expect(searchIo.stderr()).toContain('"event":"wiki_query_completed"');
    expect(searchIo.stderr()).toContain('"queryLength"');
    expect(searchIo.stderr()).not.toContain('revenue recognition');
  });

  it('prints wiki search rank badges in pretty output', async () => {
    const projectDir = join(tempDir, 'rank-project');
    await initKtxProject({ projectDir });
    await seedWikiPage(projectDir);

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge(
        {
          command: 'search',
          projectDir,
          query: 'paid order',
          userId: 'local',
          output: 'pretty',
          cliVersion: '0.0.0-test',
        },
        searchIo.io,
      ),
    ).resolves.toBe(0);

    const stdout = stripVTControlCharacters(searchIo.stdout());
    expect(stdout).toMatch(/#1\s+metrics-revenue/);
    expect(stdout).not.toContain('%');
  });

  it('prints wiki list and search as public JSON envelopes', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await seedWikiPage(projectDir);

    const listIo = makeIo();
    await expect(
      runKtxKnowledge(
        { command: 'list', projectDir, userId: 'local', json: true, cliVersion: '0.0.0-test' },
        listIo.io,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(listIo.stdout())).toMatchObject({
      kind: 'list',
      data: { items: [expect.objectContaining({ key: 'metrics-revenue', summary: 'Revenue' })] },
      meta: { command: 'wiki list' },
    });

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge(
        {
          command: 'search',
          projectDir,
          query: 'paid order',
          userId: 'local',
          json: true,
          limit: 5,
          cliVersion: '0.0.0-test',
        },
        searchIo.io,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(searchIo.stdout())).toMatchObject({
      kind: 'list',
      data: { items: [expect.objectContaining({ key: 'metrics-revenue', summary: 'Revenue' })] },
      meta: { command: 'wiki search' },
    });
  });

  it('explains empty search results for a project without wiki pages', async () => {
    const projectDir = join(tempDir, 'empty-project');
    await initKtxProject({ projectDir });

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge(
        { command: 'search', projectDir, query: 'revenue', userId: 'local', cliVersion: '0.0.0-test' },
        searchIo.io,
      ),
    ).resolves.toBe(0);

    expect(searchIo.stdout()).toBe('');
    expect(searchIo.stderr()).toContain('No local wiki pages found');
    expect(searchIo.stderr()).toContain('ktx ingest <connectionId>');
  });

  it('uses configured embeddings for semantic wiki search', async () => {
    const projectDir = join(tempDir, 'semantic-project');
    await initKtxProject({ projectDir });
    await seedWikiPage(projectDir, {
      key: 'active-contract-arr-open-tickets',
      summary: 'Active Contract ARR Ranked by Open Support Ticket Count',
      content: 'Accounts ranked by annual recurring contract value and support ticket load.',
      tags: ['historic-sql'],
      slRefs: [],
    });

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge(
        { command: 'search', projectDir, query: 'revenue', userId: 'local', cliVersion: '0.0.0-test' },
        searchIo.io,
        { embeddingService: new FakeEmbeddingPort() },
      ),
    ).resolves.toBe(0);

    expect(searchIo.stdout()).toContain('active-contract-arr-open-tickets');
    expect(searchIo.stderr()).toBe('');
  });

  it('routes wiki search through resolveEmbeddingProvider when no embeddingService is injected', async () => {
    const projectDir = join(tempDir, 'resolver-project');
    await initKtxProject({ projectDir });
    const search = vi.fn(async () => []);
    const searchIo = makeIo();
    await expect(
      runKtxKnowledge(
        {
          command: 'search',
          projectDir,
          query: 'income',
          userId: 'local',
          cliVersion: '0.5.0',
        },
        searchIo.io,
        {
          resolveEmbeddingProvider: async () => ({
            kind: 'managed-running',
            provider: { id: 'fake' } as never,
            baseUrl: 'http://127.0.0.1:51234',
          }),
          searchLocalKnowledgePages: search,
        },
      ),
    ).resolves.toBe(0);
    expect(search).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ embeddingService: expect.any(Object) }),
    );
  });

  it('writes wiki search lane diagnostics to stderr when debug is enabled', async () => {
    const projectDir = join(tempDir, 'debug-project');
    await initKtxProject({ projectDir });
    await seedWikiPage(projectDir);

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge(
        {
          command: 'search',
          projectDir,
          query: 'paid order',
          userId: 'local',
          json: true,
          debug: true,
          cliVersion: '0.0.0-test',
        },
        searchIo.io,
        { embeddingService: new FakeEmbeddingPort() },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(searchIo.stdout())).toMatchObject({
      kind: 'list',
      data: { items: [expect.objectContaining({ key: 'metrics-revenue' })] },
      meta: { command: 'wiki search' },
    });
    expect(searchIo.stderr()).toContain('[debug] wiki search mode=sqlite-fts5');
    expect(searchIo.stderr()).toContain('embedding=configured');
    expect(searchIo.stderr()).toContain('lane=lexical status=available');
    expect(searchIo.stderr()).toContain('lane=semantic status=available');
  });
});
