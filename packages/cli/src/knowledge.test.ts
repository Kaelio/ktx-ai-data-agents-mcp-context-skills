import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '@ktx/context/project';
import type { KtxEmbeddingPort } from '@ktx/context';
import { type LocalKnowledgeScope, writeLocalKnowledgePage } from '@ktx/context/wiki';
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

async function seedKnowledgePage(input: {
  projectDir: string;
  key: string;
  summary: string;
  content: string;
  scope?: LocalKnowledgeScope;
  tags?: string[];
  refs?: string[];
  slRefs?: string[];
}): Promise<void> {
  const project = await initKtxProject({ projectDir: input.projectDir, projectName: 'warehouse' });
  await writeLocalKnowledgePage(project, {
    key: input.key,
    scope: input.scope ?? 'GLOBAL',
    userId: 'local',
    summary: input.summary,
    content: input.content,
    tags: input.tags ?? [],
    refs: input.refs ?? [],
    slRefs: input.slRefs ?? [],
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

  it('lists and searches knowledge pages', async () => {
    const projectDir = join(tempDir, 'project');
    await seedKnowledgePage({
      projectDir,
      key: 'metrics-revenue',
      summary: 'Revenue',
      content: 'Revenue is paid order value.',
      tags: ['finance'],
      slRefs: ['orders'],
    });

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
    await seedKnowledgePage({
      projectDir,
      key: 'metrics-revenue',
      summary: 'Revenue',
      content: 'Revenue is paid order value.',
      tags: ['finance'],
      slRefs: ['orders'],
    });

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
    await initKtxProject({ projectDir, projectName: 'warehouse' });

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge({ command: 'search', projectDir, query: 'revenue', userId: 'local' }, searchIo.io),
    ).resolves.toBe(0);

    expect(searchIo.stdout()).toBe('');
    expect(searchIo.stderr()).toContain('No local wiki pages found');
    expect(searchIo.stderr()).toContain('Run ingest');
    expect(searchIo.stderr()).not.toContain('ktx wiki write');
  });

  it('uses configured embeddings for semantic wiki search', async () => {
    const projectDir = join(tempDir, 'semantic-project');
    await seedKnowledgePage({
      projectDir,
      key: 'active-contract-arr-open-tickets',
      summary: 'Active Contract ARR Ranked by Open Support Ticket Count',
      content: 'Accounts ranked by annual recurring contract value and support ticket load.',
      tags: ['historic-sql'],
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
