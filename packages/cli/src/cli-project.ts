import { MANAGED_SENTENCE_TRANSFORMERS_BASE_URL } from '@ktx/context';
import { loadKtxProject, type KtxLocalProject } from '@ktx/context/project';
import type { KtxProjectConfig, KtxProjectEmbeddingConfig } from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import {
  ensureManagedLocalEmbeddingsDaemon,
  type ManagedLocalEmbeddingsDaemon,
} from './managed-local-embeddings.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';

export interface LoadKtxCliProjectOptions {
  projectDir: string;
  cliVersion: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
}

export interface LoadKtxCliProjectDeps {
  loadProject?: typeof loadKtxProject;
  ensureLocalEmbeddings?: (
    options: Parameters<typeof ensureManagedLocalEmbeddingsDaemon>[0],
  ) => Promise<ManagedLocalEmbeddingsDaemon>;
}

export async function loadKtxCliProject(
  options: LoadKtxCliProjectOptions,
  deps: LoadKtxCliProjectDeps = {},
): Promise<KtxLocalProject> {
  const loadProject = deps.loadProject ?? loadKtxProject;
  const ensureLocalEmbeddings = deps.ensureLocalEmbeddings ?? ensureManagedLocalEmbeddingsDaemon;

  const project = await loadProject({ projectDir: options.projectDir });
  if (!projectNeedsManagedLocalEmbeddings(project.config)) {
    return project;
  }

  const daemon = await ensureLocalEmbeddings({
    cliVersion: options.cliVersion,
    projectDir: options.projectDir,
    installPolicy: options.installPolicy,
    io: options.io,
  });

  return {
    ...project,
    config: substituteManagedLocalEmbeddingsUrl(project.config, daemon.baseUrl),
  };
}

export function projectNeedsManagedLocalEmbeddings(config: KtxProjectConfig): boolean {
  return (
    embeddingUsesManagedSentinel(config.ingest.embeddings) ||
    embeddingUsesManagedSentinel(config.scan.enrichment.embeddings)
  );
}

export function substituteManagedLocalEmbeddingsUrl(
  config: KtxProjectConfig,
  baseUrl: string,
): KtxProjectConfig {
  const ingestEmbeddings = rewriteManagedEmbeddingConfig(config.ingest.embeddings, baseUrl);
  const scanEnrichmentEmbeddings = rewriteManagedEmbeddingConfig(config.scan.enrichment.embeddings, baseUrl);
  return {
    ...config,
    ingest: { ...config.ingest, embeddings: ingestEmbeddings },
    scan: {
      ...config.scan,
      enrichment: { ...config.scan.enrichment, embeddings: scanEnrichmentEmbeddings },
    },
  };
}

function embeddingUsesManagedSentinel(embedding: KtxProjectEmbeddingConfig | undefined): boolean {
  return embedding?.sentenceTransformers?.base_url === MANAGED_SENTENCE_TRANSFORMERS_BASE_URL;
}

function rewriteManagedEmbeddingConfig<T extends KtxProjectEmbeddingConfig | undefined>(
  embedding: T,
  baseUrl: string,
): T {
  if (!embedding || !embeddingUsesManagedSentinel(embedding)) {
    return embedding;
  }
  return {
    ...embedding,
    sentenceTransformers: {
      ...embedding.sentenceTransformers,
      base_url: baseUrl,
    },
  } as T;
}
