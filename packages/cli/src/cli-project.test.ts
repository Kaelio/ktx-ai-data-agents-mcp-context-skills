import { describe, expect, it, vi } from 'vitest';
import { MANAGED_SENTENCE_TRANSFORMERS_BASE_URL } from '@ktx/context';
import { buildDefaultKtxProjectConfig, type KtxLocalProject, type KtxProjectConfig } from '@ktx/context/project';
import {
  loadKtxCliProject,
  projectNeedsManagedLocalEmbeddings,
  substituteManagedLocalEmbeddingsUrl,
} from './cli-project.js';
import type { ManagedLocalEmbeddingsDaemon } from './managed-local-embeddings.js';

const RESOLVED_BASE_URL = 'http://127.0.0.1:51234';

function makeIo() {
  let stderr = '';
  return {
    io: {
      stdout: { write: (_chunk: string) => {} },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stderr: () => stderr,
  };
}

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

function withManagedIngestEmbedding(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    ingest: {
      ...config.ingest,
      embeddings: {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        sentenceTransformers: { base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL, pathPrefix: '' },
      },
    },
  };
}

function withManagedScanEnrichmentEmbedding(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    scan: {
      ...config.scan,
      enrichment: {
        ...config.scan.enrichment,
        embeddings: {
          backend: 'sentence-transformers',
          model: 'all-MiniLM-L6-v2',
          dimensions: 384,
          sentenceTransformers: { base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL, pathPrefix: '' },
        },
      },
    },
  };
}

const fakeDaemon: ManagedLocalEmbeddingsDaemon = {
  baseUrl: RESOLVED_BASE_URL,
  stdoutLog: '/work/proj/.ktx/runtime/daemon.stdout.log',
  stderrLog: '/work/proj/.ktx/runtime/daemon.stderr.log',
};

describe('projectNeedsManagedLocalEmbeddings', () => {
  it('returns false when neither ingest nor scan embeddings reference the managed sentinel', () => {
    expect(projectNeedsManagedLocalEmbeddings(buildDefaultKtxProjectConfig())).toBe(false);
  });

  it('returns true when ingest.embeddings uses the managed sentinel', () => {
    expect(projectNeedsManagedLocalEmbeddings(withManagedIngestEmbedding(buildDefaultKtxProjectConfig()))).toBe(true);
  });

  it('returns true when scan.enrichment.embeddings uses the managed sentinel', () => {
    expect(
      projectNeedsManagedLocalEmbeddings(withManagedScanEnrichmentEmbedding(buildDefaultKtxProjectConfig())),
    ).toBe(true);
  });
});

describe('substituteManagedLocalEmbeddingsUrl', () => {
  it('rewrites the managed sentinel in both ingest.embeddings and scan.enrichment.embeddings', () => {
    const config = withManagedScanEnrichmentEmbedding(withManagedIngestEmbedding(buildDefaultKtxProjectConfig()));
    const resolved = substituteManagedLocalEmbeddingsUrl(config, RESOLVED_BASE_URL);
    expect(resolved.ingest.embeddings.sentenceTransformers?.base_url).toBe(RESOLVED_BASE_URL);
    expect(resolved.scan.enrichment.embeddings?.sentenceTransformers?.base_url).toBe(RESOLVED_BASE_URL);
  });

  it('returns the input unchanged when no sentinel is present', () => {
    const config = buildDefaultKtxProjectConfig();
    const resolved = substituteManagedLocalEmbeddingsUrl(config, RESOLVED_BASE_URL);
    expect(resolved.ingest.embeddings).toEqual(config.ingest.embeddings);
    expect(resolved.scan.enrichment.embeddings).toEqual(config.scan.enrichment.embeddings);
  });

  it('does not touch non-sentinel sentence-transformers URLs', () => {
    const config: KtxProjectConfig = {
      ...buildDefaultKtxProjectConfig(),
      ingest: {
        ...buildDefaultKtxProjectConfig().ingest,
        embeddings: {
          backend: 'sentence-transformers',
          model: 'all-MiniLM-L6-v2',
          dimensions: 384,
          sentenceTransformers: { base_url: 'http://localhost:9999', pathPrefix: '' },
        },
      },
    };
    const resolved = substituteManagedLocalEmbeddingsUrl(config, RESOLVED_BASE_URL);
    expect(resolved.ingest.embeddings.sentenceTransformers?.base_url).toBe('http://localhost:9999');
  });
});

describe('loadKtxCliProject', () => {
  it('returns the project unchanged and does not start the daemon when no sentinel is present', async () => {
    const io = makeIo();
    const project = projectWithConfig(buildDefaultKtxProjectConfig());
    const loadProject = vi.fn(async () => project);
    const ensureLocalEmbeddings = vi.fn(async () => fakeDaemon);

    const result = await loadKtxCliProject(
      { projectDir: '/work/proj', cliVersion: '0.2.0', installPolicy: 'never', io: io.io },
      { loadProject, ensureLocalEmbeddings },
    );

    expect(result).toBe(project);
    expect(ensureLocalEmbeddings).not.toHaveBeenCalled();
  });

  it('starts the daemon and substitutes the resolved URL when ingest.embeddings uses the sentinel', async () => {
    const io = makeIo();
    const project = projectWithConfig(withManagedIngestEmbedding(buildDefaultKtxProjectConfig()));
    const loadProject = vi.fn(async () => project);
    const ensureLocalEmbeddings = vi.fn(async () => fakeDaemon);

    const result = await loadKtxCliProject(
      { projectDir: '/work/proj', cliVersion: '0.2.0', installPolicy: 'never', io: io.io },
      { loadProject, ensureLocalEmbeddings },
    );

    expect(ensureLocalEmbeddings).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      installPolicy: 'never',
      io: io.io,
    });
    expect(result.config.ingest.embeddings.sentenceTransformers?.base_url).toBe(RESOLVED_BASE_URL);
  });

  it('does not mutate process.env', async () => {
    const io = makeIo();
    const before = process.env.KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL;
    delete process.env.KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL;
    try {
      const project = projectWithConfig(withManagedIngestEmbedding(buildDefaultKtxProjectConfig()));
      await loadKtxCliProject(
        { projectDir: '/work/proj', cliVersion: '0.2.0', installPolicy: 'never', io: io.io },
        { loadProject: vi.fn(async () => project), ensureLocalEmbeddings: vi.fn(async () => fakeDaemon) },
      );
      expect(process.env.KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL).toBeUndefined();
    } finally {
      if (before === undefined) {
        delete process.env.KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL;
      } else {
        process.env.KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL = before;
      }
    }
  });
});
