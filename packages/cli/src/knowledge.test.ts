import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '@ktx/context/project';
import type { KtxEmbeddingPort } from '@ktx/context';
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

describe('runKtxKnowledge', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-knowledge-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes, reads, lists, and searches knowledge pages', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });

    const writeIo = makeIo();
    await expect(
      runKtxKnowledge(
        {
          command: 'write',
          projectDir,
          key: 'metrics-revenue',
          scope: 'GLOBAL',
          userId: 'local',
          summary: 'Revenue',
          content: 'Revenue is paid order value.',
          tags: ['finance'],
          refs: [],
          slRefs: ['orders'],
        },
        writeIo.io,
      ),
    ).resolves.toBe(0);
    expect(writeIo.stdout()).toContain('Wrote knowledge/global/metrics-revenue.md');

    const readIo = makeIo();
    await expect(
      runKtxKnowledge({ command: 'read', projectDir, key: 'metrics-revenue', userId: 'local' }, readIo.io),
    ).resolves.toBe(0);
    expect(readIo.stdout()).toContain('# metrics-revenue');
    expect(readIo.stdout()).toContain('Revenue is paid order value.');

    const listIo = makeIo();
    await expect(runKtxKnowledge({ command: 'list', projectDir, userId: 'local' }, listIo.io)).resolves.toBe(0);
    expect(listIo.stdout()).toContain('GLOBAL\tmetrics-revenue\tRevenue');

    const searchIo = makeIo();
    await expect(
      runKtxKnowledge({ command: 'search', projectDir, query: 'paid order', userId: 'local' }, searchIo.io),
    ).resolves.toBe(0);
    expect(searchIo.stdout()).toContain('metrics-revenue');
  });

  it('rejects slash-delimited write keys with a flat-key suggestion', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });

    const writeIo = makeIo();
    await expect(
      runKtxKnowledge(
        {
          command: 'write',
          projectDir,
          key: 'orbit/company-overview',
          scope: 'GLOBAL',
          userId: 'local',
          summary: 'Orbit',
          content: 'Orbit overview.',
          tags: [],
          refs: [],
          slRefs: [],
        },
        writeIo.io,
      ),
    ).resolves.toBe(1);

    expect(writeIo.stderr()).toContain(
      'Invalid wiki key "orbit/company-overview". Wiki keys must be flat; use "orbit-company-overview".',
    );
    expect(writeIo.stdout()).toBe('');
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
    expect(searchIo.stderr()).toContain('ktx wiki write');
  });

  it('uses configured embeddings for semantic wiki search', async () => {
    const projectDir = join(tempDir, 'semantic-project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });

    await expect(
      runKtxKnowledge(
        {
          command: 'write',
          projectDir,
          key: 'active-contract-arr-open-tickets',
          scope: 'GLOBAL',
          userId: 'local',
          summary: 'Active Contract ARR Ranked by Open Support Ticket Count',
          content: 'Accounts ranked by annual recurring contract value and support ticket load.',
          tags: ['historic-sql'],
          refs: [],
          slRefs: [],
        },
        makeIo().io,
      ),
    ).resolves.toBe(0);

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
