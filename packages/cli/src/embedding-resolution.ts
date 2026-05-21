import {
  type KtxEmbeddingProvider,
  createKtxEmbeddingProvider as defaultCreateKtxEmbeddingProvider,
} from '@ktx/llm';
import type { KtxLocalProject, KtxProjectEmbeddingConfig } from '@ktx/context/project';
import { resolveLocalKtxEmbeddingConfig } from '@ktx/context';
import type { KtxCliIo } from './cli-runtime.js';
import {
  ensureManagedLocalEmbeddingsDaemon as defaultEnsureManagedDaemon,
  tryUseManagedLocalEmbeddingsDaemon as defaultTryUseManagedDaemon,
} from './managed-local-embeddings.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';

type EmbeddingResolutionMode = 'ensure' | 'use-if-running';

export type EmbeddingProviderResolution =
  | { kind: 'disabled' }
  | { kind: 'configured'; provider: KtxEmbeddingProvider; baseUrl: string }
  | { kind: 'managed-running'; provider: KtxEmbeddingProvider; baseUrl: string }
  | { kind: 'managed-started'; provider: KtxEmbeddingProvider; baseUrl: string }
  | { kind: 'managed-unavailable'; reason: string };

export interface ResolveProjectEmbeddingProviderOptions {
  mode: EmbeddingResolutionMode;
  cliVersion: string;
  io: KtxCliIo;
  /** Required when mode === 'ensure'. */
  installPolicy?: KtxManagedPythonInstallPolicy;
  tryUseManagedDaemon?: typeof defaultTryUseManagedDaemon;
  ensureManagedDaemon?: typeof defaultEnsureManagedDaemon;
  createKtxEmbeddingProvider?: typeof defaultCreateKtxEmbeddingProvider;
}

function usesManagedDaemon(embeddings: KtxProjectEmbeddingConfig): boolean {
  if (embeddings.backend !== 'sentence-transformers') {
    return false;
  }
  const baseUrl = embeddings.sentenceTransformers?.base_url;
  return baseUrl === undefined || baseUrl === '';
}

export async function resolveProjectEmbeddingProvider(
  project: KtxLocalProject,
  options: ResolveProjectEmbeddingProviderOptions,
): Promise<EmbeddingProviderResolution> {
  const embeddings = project.config.ingest.embeddings;
  if (embeddings.backend === 'none') {
    return { kind: 'disabled' };
  }
  const createProvider = options.createKtxEmbeddingProvider ?? defaultCreateKtxEmbeddingProvider;

  if (!usesManagedDaemon(embeddings)) {
    const resolved = resolveLocalKtxEmbeddingConfig(embeddings, process.env);
    if (!resolved) {
      return { kind: 'managed-unavailable', reason: 'embedding config missing required fields' };
    }
    const provider = createProvider(resolved);
    const baseUrl = embeddings.sentenceTransformers?.base_url ?? '';
    return { kind: 'configured', provider, baseUrl };
  }

  const tryUse = options.tryUseManagedDaemon ?? defaultTryUseManagedDaemon;
  const running = await tryUse({ cliVersion: options.cliVersion, projectDir: project.projectDir });

  if (running) {
    const provider = buildManagedProvider(embeddings, running.baseUrl, createProvider);
    return provider
      ? { kind: 'managed-running', provider, baseUrl: running.baseUrl }
      : { kind: 'managed-unavailable', reason: 'failed to build embedding provider from running daemon' };
  }

  if (options.mode === 'use-if-running') {
    return { kind: 'managed-unavailable', reason: 'managed embeddings daemon is not running' };
  }

  const ensure = options.ensureManagedDaemon ?? defaultEnsureManagedDaemon;
  if (!options.installPolicy) {
    throw new Error("installPolicy is required when mode === 'ensure'");
  }
  const daemon = await ensure({
    cliVersion: options.cliVersion,
    projectDir: project.projectDir,
    installPolicy: options.installPolicy,
    io: options.io,
  });
  const provider = buildManagedProvider(embeddings, daemon.baseUrl, createProvider);
  return provider
    ? { kind: 'managed-started', provider, baseUrl: daemon.baseUrl }
    : { kind: 'managed-unavailable', reason: 'failed to build embedding provider after starting daemon' };
}

function buildManagedProvider(
  embeddings: KtxProjectEmbeddingConfig,
  baseUrl: string,
  createProvider: typeof defaultCreateKtxEmbeddingProvider,
): KtxEmbeddingProvider | null {
  const merged: KtxProjectEmbeddingConfig = {
    ...embeddings,
    sentenceTransformers: {
      ...embeddings.sentenceTransformers,
      base_url: baseUrl,
    },
  };
  const resolved = resolveLocalKtxEmbeddingConfig(merged, process.env);
  return resolved ? createProvider(resolved) : null;
}
