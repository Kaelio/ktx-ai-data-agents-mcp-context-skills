import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject, loadKtxProject } from '@ktx/context/project';
import type { KtxEmbeddingPort } from '@ktx/context';
import { writeLocalKnowledgePage } from '@ktx/context/wiki';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runKtxKnowledge } from './knowledge.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
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
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists and searches wiki pages', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await seedWikiPage(projectDir);

    const listIo = makeIo();
    await expect(runKtxKnowledge({ command: 'list', projectDir, userId: 'local' }, listIo.io)).resolves.toBe(0);
    expect(listIo.stdout()).toContain('GLOBAL\tmetrics-revenue\tRevenue');

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge({ command: 'search', projectDir, query: 'paid order', userId: 'local' }, searchIo.io),
    ).resolves.toBe(0);
    expect(searchIo.stdout()).toContain('metrics-revenue');
  });

  it('prints wiki list and search as public JSON envelopes', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await seedWikiPage(projectDir);

    const listIo = makeIo();
    await expect(runKtxKnowledge({ command: 'list', projectDir, userId: 'local', json: true }, listIo.io)).resolves.toBe(
      0,
    );
    expect(JSON.parse(listIo.stdout())).toMatchObject({
      kind: 'list',
      data: { items: [expect.objectContaining({ key: 'metrics-revenue', summary: 'Revenue' })] },
      meta: { command: 'wiki list' },
    });

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge(
        { command: 'search', projectDir, query: 'paid order', userId: 'local', json: true, limit: 5 },
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
      runKtxKnowledge({ command: 'search', projectDir, query: 'revenue', userId: 'local' }, searchIo.io),
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
        { command: 'search', projectDir, query: 'revenue', userId: 'local' },
        searchIo.io,
        { embeddingService: new FakeEmbeddingPort() },
      ),
    ).resolves.toBe(0);

    expect(searchIo.stdout()).toContain('active-contract-arr-open-tickets');
    expect(searchIo.stderr()).toBe('');
  });
});
