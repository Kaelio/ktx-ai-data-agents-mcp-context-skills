import {
  createKtxEmbeddingProvider,
  createKtxLlmProvider,
  type KtxEmbeddingConfig,
  type KtxEmbeddingProvider,
  type KtxLlmConfig,
  type KtxLlmProvider,
  type KtxModelRole,
} from '@ktx/llm';
import { resolveKtxConfigReference } from '../core/config-reference.js';
import type { KtxProjectEmbeddingConfig, KtxProjectLlmConfig } from '../project/config.js';
import { AiSdkKtxLlmRuntime } from './ai-sdk-runtime.js';
import { ClaudeCodeKtxLlmRuntime } from './claude-code-runtime.js';
import type { KtxLlmRuntimePort } from './runtime-port.js';

interface LocalConfigDeps {
  env?: NodeJS.ProcessEnv;
  projectDir?: string;
  createKtxLlmProvider?: typeof createKtxLlmProvider;
  createKtxEmbeddingProvider?: typeof createKtxEmbeddingProvider;
  createClaudeCodeRuntime?: (deps: ConstructorParameters<typeof ClaudeCodeKtxLlmRuntime>[0]) => KtxLlmRuntimePort;
  createAiSdkRuntime?: (deps: { llmProvider: KtxLlmProvider }) => KtxLlmRuntimePort;
}

export const MANAGED_SENTENCE_TRANSFORMERS_BASE_URL = 'managed:local-embeddings';
export const MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV = 'KTX_MANAGED_SENTENCE_TRANSFORMERS_BASE_URL';

function resolveOptional(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return resolveKtxConfigReference(value, env) || undefined;
}

function resolveRequired(value: string | undefined, env: NodeJS.ProcessEnv, message: string): string {
  const resolved = resolveOptional(value, env);
  if (!resolved) {
    throw new Error(message);
  }
  return resolved;
}

function resolveModelSlots(
  models: KtxProjectLlmConfig['models'],
  env: NodeJS.ProcessEnv,
): KtxLlmConfig['modelSlots'] {
  const resolved: Partial<Record<KtxModelRole, string>> & { default?: string } = {};
  for (const [role, value] of Object.entries(models)) {
    if (value) {
      resolved[role as KtxModelRole] = resolveRequired(value, env, `llm.models.${role} is required`);
    }
  }
  if (!resolved.default) {
    throw new Error('llm.models.default is required when llm.provider.backend is not none');
  }
  return resolved as KtxLlmConfig['modelSlots'];
}

function resolvedProviderConfig(
  config: { api_key?: string; base_url?: string } | undefined,
  env: NodeJS.ProcessEnv,
): { apiKey?: string; baseURL?: string } | undefined {
  if (!config) {
    return undefined;
  }

  const apiKey = resolveOptional(config.api_key, env);
  const baseURL = resolveOptional(config.base_url, env);
  if (!apiKey && !baseURL) {
    return undefined;
  }

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
  };
}

function resolvedVertexConfig(
  config: { project?: string; location?: string } | undefined,
  env: NodeJS.ProcessEnv,
): { project?: string; location: string } | undefined {
  if (!config) {
    return undefined;
  }

  const project = resolveOptional(config.project, env);
  const location = resolveRequired(config.location, env, 'llm.provider.vertex.location is required');
  return {
    ...(project ? { project } : {}),
    location,
  };
}

export function resolveLocalKtxLlmConfig(config: KtxProjectLlmConfig, env: NodeJS.ProcessEnv): KtxLlmConfig | null {
  if (config.provider.backend === 'none') {
    return null;
  }
  const modelSlots = resolveModelSlots(config.models, env);
  const vertex = config.provider.backend === 'vertex' ? resolvedVertexConfig(config.provider.vertex, env) : undefined;
  const anthropic = resolvedProviderConfig(config.provider.anthropic, env);
  const gateway = resolvedProviderConfig(config.provider.gateway, env);
  return {
    backend: config.provider.backend,
    ...(vertex ? { vertex } : {}),
    ...(anthropic ? { anthropic } : {}),
    ...(gateway ? { gateway } : {}),
    modelSlots,
    promptCaching: config.promptCaching,
  };
}

export function createLocalKtxLlmProviderFromConfig(
  config: KtxProjectLlmConfig,
  deps: LocalConfigDeps = {},
): KtxLlmProvider | null {
  const resolved = resolveLocalKtxLlmConfig(config, deps.env ?? process.env);
  if (!resolved || resolved.backend === 'claude-code') {
    return null;
  }
  return (deps.createKtxLlmProvider ?? createKtxLlmProvider)(resolved);
}

export function createLocalKtxLlmRuntimeFromConfig(
  config: KtxProjectLlmConfig,
  deps: LocalConfigDeps = {},
): KtxLlmRuntimePort | null {
  const resolved = resolveLocalKtxLlmConfig(config, deps.env ?? process.env);
  if (!resolved) {
    return null;
  }
  if (resolved.backend === 'claude-code') {
    const projectDir = deps.projectDir;
    if (!projectDir) {
      throw new Error('projectDir is required when creating the claude-code LLM runtime');
    }
    return (deps.createClaudeCodeRuntime ?? ((runtimeDeps) => new ClaudeCodeKtxLlmRuntime(runtimeDeps)))({
      projectDir,
      modelSlots: resolved.modelSlots,
      env: deps.env,
    });
  }
  const llmProvider = (deps.createKtxLlmProvider ?? createKtxLlmProvider)(resolved);
  return (deps.createAiSdkRuntime ?? ((runtimeDeps) => new AiSdkKtxLlmRuntime(runtimeDeps)))({ llmProvider });
}

function resolveSentenceTransformersBaseUrl(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value === MANAGED_SENTENCE_TRANSFORMERS_BASE_URL) {
    return resolveOptional(`env:${MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV}`, env);
  }
  return value;
}

export function resolveLocalKtxEmbeddingConfig(
  config: KtxProjectEmbeddingConfig,
  env: NodeJS.ProcessEnv,
): KtxEmbeddingConfig | null {
  if (config.backend === 'none') {
    return null;
  }
  if (config.backend === 'sentence-transformers') {
    const baseURL = resolveSentenceTransformersBaseUrl(config.sentenceTransformers?.base_url, env);
    if (!baseURL) {
      return null;
    }
    return {
      backend: config.backend,
      model: config.model ?? 'all-MiniLM-L6-v2',
      dimensions: config.dimensions,
      sentenceTransformers: {
        baseURL,
        pathPrefix: config.sentenceTransformers?.pathPrefix,
      },
      batchSize: config.batchSize,
    };
  }
  return {
    backend: config.backend,
    model: config.model ?? 'deterministic',
    dimensions: config.dimensions,
    ...(resolvedProviderConfig(config.openai, env) ? { openai: resolvedProviderConfig(config.openai, env) } : {}),
    ...(config.sentenceTransformers
      ? {
          sentenceTransformers: {
            baseURL: config.sentenceTransformers.base_url,
            pathPrefix: config.sentenceTransformers.pathPrefix,
          },
        }
      : {}),
    batchSize: config.batchSize,
  };
}

export function createLocalKtxEmbeddingProviderFromConfig(
  config: KtxProjectEmbeddingConfig,
  deps: LocalConfigDeps = {},
): KtxEmbeddingProvider | null {
  const resolved = resolveLocalKtxEmbeddingConfig(config, deps.env ?? process.env);
  return resolved ? (deps.createKtxEmbeddingProvider ?? createKtxEmbeddingProvider)(resolved) : null;
}
