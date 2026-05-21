import { describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig, type KtxLocalProject, type KtxProjectConfig } from '@ktx/context/project';
import { buildProjectStatus } from './status-project.js';

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
