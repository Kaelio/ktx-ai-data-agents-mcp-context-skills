import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig, type KtxLocalProject, type KtxProjectConfig } from '@ktx/context/project';
import {
  buildLocalStatsStatus,
  buildProjectStatus,
  renderProjectStatus,
} from './status-project.js';

function projectWithConfig(config: KtxProjectConfig): KtxLocalProject {
  return {
    projectDir: '/work/proj',
    configPath: '/work/proj/ktx.yaml',
    config,
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore: {} as KtxLocalProject['fileStore'],
  };
}

function withEmbeddings(
  config: KtxProjectConfig,
  embeddings: KtxProjectConfig['ingest']['embeddings'],
): KtxProjectConfig {
  return {
    ...config,
    ingest: { ...config.ingest, embeddings },
    scan: { ...config.scan, enrichment: { ...config.scan.enrichment, embeddings } },
  };
}

function withClaudeCodeLlm(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      provider: { backend: 'claude-code' },
      models: { ...config.llm.models, default: 'sonnet' },
    },
  };
}

function baseProjectConfig(): KtxProjectConfig {
  return withClaudeCodeLlm(buildDefaultKtxProjectConfig());
}

const stubClaudeCodeAuthProbe = async () => ({ ok: true as const });

describe('buildProjectStatus embeddings', () => {
  it('reports sentence-transformers with explicit base_url as ok', async () => {
    const project = projectWithConfig(
      withEmbeddings(baseProjectConfig(), {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        sentenceTransformers: { base_url: 'http://my-st:8080', pathPrefix: '' },
      }),
    );

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });

    expect(status.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      status: 'ok',
      detail: 'service: http://my-st:8080',
    });
  });

  it('reports sentence-transformers with omitted base_url as managed daemon (ok)', async () => {
    const project = projectWithConfig(
      withEmbeddings(baseProjectConfig(), {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
      }),
    );

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });

    expect(status.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      status: 'ok',
      detail: 'managed local embeddings daemon',
    });
    expect(status.verdictReason).not.toMatch(/embedding credentials missing/);
  });

  it('reports sentence-transformers with empty base_url string as managed daemon (ok)', async () => {
    const project = projectWithConfig(
      withEmbeddings(baseProjectConfig(), {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        sentenceTransformers: { base_url: '', pathPrefix: '' },
      }),
    );

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });

    expect(status.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      status: 'ok',
      detail: 'managed local embeddings daemon',
    });
  });

  it('reports openai backend with missing key as warn', async () => {
    const project = projectWithConfig(
      withEmbeddings(baseProjectConfig(), {
        backend: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        openai: { api_key: 'env:OPENAI_API_KEY' }, // pragma: allowlist secret
      }),
    );

    const status = await buildProjectStatus(project, {
      env: {},
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });

    expect(status.embeddings.status).toBe('warn');
    expect(status.verdictReason).toMatch(/embedding credentials missing/);
  });
});

function withPostgresQueryHistory(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    connections: {
      ...config.connections,
      analytics: {
        driver: 'postgres',
        url: 'env:ANALYTICS_DATABASE_URL',
        context: { queryHistory: { enabled: true } },
      } as KtxProjectConfig['connections'][string],
    },
  };
}

describe('buildProjectStatus --fast', () => {
  it('skips claude-code probe and Postgres query-history probe', async () => {
    let claudeProbeCalls = 0;
    let pgProbeCalls = 0;
    const project = projectWithConfig(withPostgresQueryHistory(baseProjectConfig()));

    const status = await buildProjectStatus(project, {
      env: { ANALYTICS_DATABASE_URL: 'postgres://example' },
      fast: true,
      claudeCodeAuthProbe: async () => {
        claudeProbeCalls += 1;
        return { ok: true };
      },
      postgresQueryHistoryProbe: async () => {
        pgProbeCalls += 1;
        throw new Error('should not be called');
      },
    });

    expect(claudeProbeCalls).toBe(0);
    expect(pgProbeCalls).toBe(0);
    expect(status.llm.status).toBe('skipped');
    expect(status.llm.detail).toMatch(/--fast/);
    expect(status.queryHistory).toHaveLength(1);
    expect(status.queryHistory[0]).toMatchObject({
      connection: 'analytics',
      status: 'skipped',
    });
    expect(status.verdict).not.toBe('blocked');
  });

  it('does not call probes lazily when fast and reports skipped in render', async () => {
    const project = projectWithConfig(withPostgresQueryHistory(baseProjectConfig()));
    const status = await buildProjectStatus(project, {
      env: { ANALYTICS_DATABASE_URL: 'postgres://example' },
      fast: true,
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
      postgresQueryHistoryProbe: async () => {
        throw new Error('should not be called');
      },
    });
    const rendered = renderProjectStatus(status, { verbose: false, useColor: false });
    expect(rendered).toContain('auth probe skipped (--fast)');
    expect(rendered).toContain('pg_stat_statements probe skipped (--fast)');
  });
});

describe('buildLocalStatsStatus', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-status-stats-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function projectIn(dir: string): KtxLocalProject {
    return {
      projectDir: dir,
      configPath: join(dir, 'ktx.yaml'),
      config: baseProjectConfig(),
      coreConfig: {} as KtxLocalProject['coreConfig'],
      git: {} as KtxLocalProject['git'],
      fileStore: {} as KtxLocalProject['fileStore'],
    };
  }

  it('returns unavailable when .ktx/db.sqlite is missing', async () => {
    const stats = await buildLocalStatsStatus(projectIn(tempDir));
    expect(stats.unavailable).toMatch(/no \.ktx\/db\.sqlite/);
    expect(stats.ingest.totalCompletedRuns).toBe(0);
    expect(stats.projectDir.dbSqliteBytes).toBeNull();
  });

  it('reads counts from a seeded SQLite DB and walks projectDir folders', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    await mkdir(join(tempDir, '.ktx', 'cache'), { recursive: true });
    await writeFile(join(tempDir, '.ktx', 'cache', 'a.bin'), Buffer.alloc(2048));
    await mkdir(join(tempDir, 'raw-sources', 'analytics'), { recursive: true });
    await writeFile(join(tempDir, 'raw-sources', 'analytics', 'snap.json'), 'x'.repeat(100));
    await writeFile(join(tempDir, 'raw-sources', 'analytics', 'snap.bin'), Buffer.alloc(512));
    await mkdir(join(tempDir, 'wiki', 'global', 'sub'), { recursive: true });
    await writeFile(join(tempDir, 'wiki', 'global', 'one.md'), '# one');
    await writeFile(join(tempDir, 'wiki', 'global', 'sub', 'two.md'), '# two');
    await mkdir(join(tempDir, 'semantic-layer'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'orders.yaml'), 'name: orders');
    await writeFile(join(tempDir, 'semantic-layer', 'users.yml'), 'name: users');

    const dbPath = join(tempDir, '.ktx', 'db.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE local_ingest_reports (
        run_id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        raw_content_hashes_json TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
      INSERT INTO local_ingest_reports VALUES
        ('r1', 'live-database', 'analytics', 'done', '2026-04-01T10:00:00Z', '{}', '{}'),
        ('r2', 'live-database', 'analytics', 'done', '2026-05-10T10:00:00Z', '{}', '{}'),
        ('r3', 'notion', 'docs', 'done', '2026-05-01T10:00:00Z', '{}', '{}'),
        ('r4', 'notion', 'docs', 'error', '2026-05-02T10:00:00Z', '{}', '{}');

      CREATE TABLE knowledge_pages (
        path TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        search_text TEXT NOT NULL DEFAULT '',
        embedding_json TEXT
      );
      INSERT INTO knowledge_pages VALUES
        ('a.md', 'a', 'GLOBAL', NULL, '', '', '[]', '', NULL),
        ('b.md', 'b', 'GLOBAL', NULL, '', '', '[]', '', NULL),
        ('c.md', 'c', 'PROJECT', NULL, '', '', '[]', '', NULL);

      CREATE TABLE local_sl_sources (
        connection_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        search_text TEXT NOT NULL,
        embedding_json TEXT,
        content_hash TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, source_name)
      );
      INSERT INTO local_sl_sources VALUES
        ('analytics', 'orders', '', NULL, NULL, '2026-05-10T10:00:00Z'),
        ('analytics', 'users', '', NULL, NULL, '2026-05-10T10:00:00Z');

      CREATE TABLE local_sl_dictionary_values (
        connection_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        value TEXT NOT NULL,
        value_lower TEXT NOT NULL,
        cardinality INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, source_name, column_name, value)
      );
      INSERT INTO local_sl_dictionary_values VALUES
        ('analytics', 'orders', 'status', 'open', 'open', 1, '2026-05-10T10:00:00Z'),
        ('analytics', 'orders', 'status', 'closed', 'closed', 1, '2026-05-10T10:00:00Z');
    `);
    db.close();

    const stats = await buildLocalStatsStatus(projectIn(tempDir));
    expect(stats.unavailable).toBeUndefined();
    expect(stats.ingest.totalCompletedRuns).toBe(3);
    expect(stats.ingest.perConnection).toEqual([
      { connectionId: 'analytics', adapter: 'live-database', lastCompletedAt: '2026-05-10T10:00:00Z' },
      { connectionId: 'docs', adapter: 'notion', lastCompletedAt: '2026-05-01T10:00:00Z' },
    ]);
    expect(stats.knowledgePages).toEqual([
      { scope: 'GLOBAL', count: 2 },
      { scope: 'PROJECT', count: 1 },
    ]);
    expect(stats.semanticLayer).toEqual([
      { connectionId: 'analytics', sourceCount: 2, dictionaryValueCount: 2 },
    ]);
    expect(stats.projectDir.dbSqliteBytes).toBeGreaterThan(0);
    expect(stats.projectDir.ktxCacheBytes).toBe(2048);
    expect(stats.projectDir.rawSources).toEqual({ fileCount: 2, bytes: 612 });
    expect(stats.projectDir.wikiGlobalMarkdownCount).toBe(2);
    expect(stats.projectDir.semanticLayerYamlCount).toBe(2);
  });

  it('tolerates a SQLite DB missing some tables', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    const dbPath = join(tempDir, '.ktx', 'db.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE local_ingest_reports (
        run_id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        raw_content_hashes_json TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
      INSERT INTO local_ingest_reports VALUES
        ('r1', 'live-database', 'analytics', 'done', '2026-05-10T10:00:00Z', '{}', '{}');
    `);
    db.close();

    const stats = await buildLocalStatsStatus(projectIn(tempDir));
    expect(stats.unavailable).toBeUndefined();
    expect(stats.ingest.totalCompletedRuns).toBe(1);
    expect(stats.knowledgePages).toEqual([]);
    expect(stats.semanticLayer).toEqual([]);
  });
});

describe('renderProjectStatus Local data', () => {
  it('renders the Local data section with seeded stats', async () => {
    const project = projectWithConfig(baseProjectConfig());
    const status = await buildProjectStatus(project, { claudeCodeAuthProbe: stubClaudeCodeAuthProbe });
    status.localStats = {
      ingest: {
        totalCompletedRuns: 3,
        perConnection: [
          { connectionId: 'analytics', adapter: 'live-database', lastCompletedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
        ],
      },
      knowledgePages: [
        { scope: 'GLOBAL', count: 2 },
        { scope: 'PROJECT', count: 1 },
      ],
      semanticLayer: [
        { connectionId: 'analytics', sourceCount: 12, dictionaryValueCount: 200 },
      ],
      projectDir: {
        dbSqliteBytes: 4096,
        ktxCacheBytes: 1_048_576,
        rawSources: { fileCount: 5, bytes: 200 },
        wikiGlobalMarkdownCount: 7,
        semanticLayerYamlCount: 3,
      },
    };
    const rendered = renderProjectStatus(status, { useColor: false });
    expect(rendered).toContain('Local data');
    expect(rendered).toContain('3 completed runs');
    expect(rendered).toContain('GLOBAL=2');
    expect(rendered).toContain('PROJECT=1');
    expect(rendered).toContain('12 sources · 200 dictionary values');
    expect(rendered).toContain('db=4.00 KiB');
    expect(rendered).toContain('cache=1.00 MiB');
    expect(rendered).toContain('wiki=7 md');
    expect(rendered).toContain('semantic-layer=3 yaml');
  });

  it('renders unavailable note when DB is missing', async () => {
    const project = projectWithConfig(baseProjectConfig());
    const status = await buildProjectStatus(project, { claudeCodeAuthProbe: stubClaudeCodeAuthProbe });
    status.localStats = {
      ingest: { totalCompletedRuns: 0, perConnection: [] },
      knowledgePages: [],
      semanticLayer: [],
      projectDir: {
        dbSqliteBytes: null,
        ktxCacheBytes: 0,
        rawSources: { fileCount: 0, bytes: 0 },
        wikiGlobalMarkdownCount: 0,
        semanticLayerYamlCount: 0,
      },
      unavailable: 'no .ktx/db.sqlite yet',
    };
    const rendered = renderProjectStatus(status, { useColor: false });
    expect(rendered).toContain('Local data');
    expect(rendered).toContain('no .ktx/db.sqlite yet');
  });
});
