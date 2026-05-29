import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import {
  listLocalKnowledgePageKeys,
  listLocalKnowledgePages,
  readLocalKnowledgePage,
  searchLocalKnowledgePages,
  writeLocalKnowledgePage,
} from '../../../src/context/wiki/local-knowledge.js';

class FakeEmbeddingPort {
  readonly maxBatchSize = 16;

  async computeEmbedding(text: string): Promise<number[]> {
    return text.toLowerCase().includes('semantic revenue') ? [1, 0] : [0, 1];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.computeEmbedding(text)));
  }
}

class ArrSynonymEmbeddingPort {
  readonly maxBatchSize = 16;

  async computeEmbedding(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    if (lower.trim() === 'annual recurring revenue' || lower.includes('arr') || lower.includes('contract-first')) {
      return [1, 0];
    }
    if (lower.includes('net revenue') || lower.includes('gross') || lower.includes('refund')) {
      return [0, 1];
    }
    return [0.5, 0.5];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.computeEmbedding(text)));
  }
}

describe('local knowledge helpers', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-knowledge-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes, reads, lists, and searches global wiki pages', async () => {
    const write = await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
      refs: ['semantic-layer/warehouse/orders.yaml'],
      slRefs: ['orders'],
    });

    expect(write.path).toBe('wiki/global/metrics-revenue.md');
    expect(write.operation).toBe('write');

    await expect(readLocalKnowledgePage(project, { key: 'metrics-revenue', userId: 'local' })).resolves.toMatchObject({
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
      refs: ['semantic-layer/warehouse/orders.yaml'],
      slRefs: ['orders'],
    });

    await expect(listLocalKnowledgePages(project, { userId: 'local' })).resolves.toEqual([
      {
        key: 'metrics-revenue',
        path: 'wiki/global/metrics-revenue.md',
        scope: 'GLOBAL',
        summary: 'Revenue metric definition',
      },
    ]);

    const search = await searchLocalKnowledgePages(project, { query: 'paid order', userId: 'local' });
    expect(search).toEqual([
      expect.objectContaining({
        key: 'metrics-revenue',
        path: 'wiki/global/metrics-revenue.md',
        scope: 'GLOBAL',
        score: expect.any(Number),
        matchReasons: expect.arrayContaining(['lexical']),
        lanes: expect.arrayContaining([expect.objectContaining({ lane: 'lexical', status: 'available' })]),
      }),
    ]);
    expect(search[0]?.score).toBeGreaterThan(0);
    await expect(access(join(project.projectDir, '.ktx', 'db.sqlite'))).resolves.toBeUndefined();
  });

  it('lists page keys across scopes, deduped and sorted, for completion', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
    });
    await writeLocalKnowledgePage(project, {
      key: 'metrics-churn',
      scope: 'USER',
      userId: 'local',
      summary: 'Churn metric definition',
      content: 'Churn is measured monthly.',
    });
    // Same key in both scopes must collapse to a single completion candidate.
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'USER',
      userId: 'local',
      summary: 'User override of revenue',
      content: 'Local revenue note.',
    });

    await expect(listLocalKnowledgePageKeys(project, { userId: 'local' })).resolves.toEqual([
      'metrics-churn',
      'metrics-revenue',
    ]);
  });

  it('adds the token lane alongside lexical wiki matches', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
    });

    const search = await searchLocalKnowledgePages(project, { query: 'paid---', userId: 'local', limit: 5 });

    expect(search[0]).toMatchObject({
      key: 'metrics-revenue',
      matchReasons: expect.arrayContaining(['token']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'token', status: 'available' })]),
    });
  });

  it('uses stored page embeddings when a wiki embedding backend is configured', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Semantic revenue definition',
      content: 'Revenue search text.',
      tags: ['finance'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'support-escalations',
      scope: 'GLOBAL',
      summary: 'Support escalation process',
      content: 'Support search text.',
      tags: ['operations'],
    });

    const search = await searchLocalKnowledgePages(project, {
      query: 'semantic revenue',
      userId: 'local',
      limit: 5,
      embeddingService: new FakeEmbeddingPort(),
    });

    expect(search[0]).toMatchObject({
      key: 'metrics-revenue',
      matchReasons: expect.arrayContaining(['semantic']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'semantic', status: 'available' })]),
    });
  });

  it('ranks ARR synonym queries by semantic page embeddings over stronger lexical revenue matches', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'arr-definition',
      scope: 'GLOBAL',
      summary: 'ARR is calculated contract-first for active customer contracts.',
      content: 'Contract-first active contract value takes precedence over subscription values.',
      tags: ['arr', 'contracts', 'finance'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'net-revenue-definition',
      scope: 'GLOBAL',
      summary: 'Net revenue definition',
      content: 'Annual revenue is gross invoice revenue minus credits and refunds.',
      tags: ['revenue', 'finance'],
    });

    const search = await searchLocalKnowledgePages(project, {
      query: 'annual recurring revenue',
      userId: 'local',
      limit: 2,
      embeddingService: new ArrSynonymEmbeddingPort(),
    });

    expect(search.map((result) => result.key)).toEqual(['arr-definition', 'net-revenue-definition']);
    expect(search[0]).toMatchObject({
      key: 'arr-definition',
      matchReasons: expect.arrayContaining(['semantic']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'semantic', status: 'available' })]),
    });
  });

  it('reports semantic lane as skipped when wiki embeddings are not configured', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
    });

    const search = await searchLocalKnowledgePages(project, { query: 'revenue', userId: 'local', limit: 5 });

    expect(search[0]?.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: 'semantic', status: 'skipped', reason: 'embedding_unconfigured' }),
      ]),
    );
  });

  it('prefers user knowledge over global pages with the same key', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'handoff',
      scope: 'GLOBAL',
      summary: 'Global handoff',
      content: 'Global context.',
    });
    await writeLocalKnowledgePage(project, {
      key: 'handoff',
      scope: 'USER',
      userId: 'agent-1',
      summary: 'User handoff',
      content: 'User context.',
    });

    await expect(readLocalKnowledgePage(project, { key: 'handoff', userId: 'agent-1' })).resolves.toMatchObject({
      scope: 'USER',
      summary: 'User handoff',
    });
  });

  it('serializes historic-SQL frontmatter fields for global pages', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'monthly-paid-orders',
      scope: 'GLOBAL',
      summary: 'Monthly paid orders',
      content: '## Monthly paid order count',
      tags: ['historic-sql', 'query-pattern'],
      slRefs: ['analytics.orders'],
      source: 'historic-sql',
      intent: 'Monthly paid order count',
      tables: ['analytics.orders'],
      representativeSql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
      usage: {
        executions: 42,
        distinct_users: 3,
        first_seen: '2026-02-01',
        last_seen: '2026-05-04',
        p50_runtime_ms: 100,
        p95_runtime_ms: 200,
        error_rate: 0,
        rows_produced: 42,
      },
      fingerprints: ['fp_paid_orders'],
    });

    const raw = await project.fileStore.readFile('wiki/global/monthly-paid-orders.md');
    expect(raw.content).toContain('source: historic-sql');
    expect(raw.content).toContain('intent: Monthly paid order count');
    expect(raw.content).toContain(['tables:', '  - analytics.orders'].join('\n'));
    expect(raw.content).toContain("representative_sql: SELECT count(*) FROM analytics.orders WHERE status = 'paid'");
    expect(raw.content).toContain(['usage:', '  executions: 42', '  distinct_users: 3'].join('\n'));
    expect(raw.content).toContain(['fingerprints:', '  - fp_paid_orders'].join('\n'));
  });

  it('falls back to Markdown scanning when the config does not select sqlite-fts5', async () => {
    project.config.storage.search = 'postgres-hybrid';
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
    });

    await expect(searchLocalKnowledgePages(project, { query: 'paid order', userId: 'local' })).resolves.toEqual([
      expect.objectContaining({
        key: 'metrics-revenue',
        score: 3,
        matchReasons: ['token'],
      }),
    ]);
  });

  it('rejects unsafe knowledge keys', async () => {
    await expect(
      writeLocalKnowledgePage(project, {
        key: '../secret',
        scope: 'GLOBAL',
        summary: 'bad',
        content: 'bad',
      }),
    ).rejects.toThrow('Invalid wiki key "../secret". Wiki keys must be flat; use "secret".');
  });

  it('rejects slash-delimited knowledge keys with a flat-key suggestion', async () => {
    await expect(
      writeLocalKnowledgePage(project, {
        key: 'orbit/company-overview',
        scope: 'GLOBAL',
        summary: 'bad',
        content: 'bad',
      }),
    ).rejects.toThrow('Invalid wiki key "orbit/company-overview". Wiki keys must be flat; use "orbit-company-overview".');
  });

  it('ignores nested historic-SQL legacy paths when listing local wiki pages', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'historic-sql-paid-orders',
      scope: 'GLOBAL',
      summary: 'Flat historic SQL page',
      content: 'Flat page body.',
      tags: ['historic-sql'],
    });
    await project.fileStore.writeFile(
      'wiki/global/historic-sql/paid-orders.md',
      '---\nsummary: Nested historic SQL page\nusage_mode: auto\n---\n\nNested body\n',
      'Test',
      'test@example.com',
      'Write nested legacy page',
    );

    await expect(listLocalKnowledgePages(project, { userId: 'local' })).resolves.toEqual([
      {
        key: 'historic-sql-paid-orders',
        path: 'wiki/global/historic-sql-paid-orders.md',
        scope: 'GLOBAL',
        summary: 'Flat historic SQL page',
      },
    ]);
  });
});
