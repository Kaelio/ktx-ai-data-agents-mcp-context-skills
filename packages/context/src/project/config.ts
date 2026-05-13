import type { KtxEmbeddingBackend, KtxLlmBackend, KtxModelRole, KtxPromptCacheTtl } from '@ktx/llm';
import YAML from 'yaml';

export type KtxStorageState = 'postgres' | 'sqlite';
export type KtxSearchBackend = 'postgres-hybrid' | 'sqlite-fts5';
type KtxLocalLlmBackend = KtxLlmBackend | 'none';
type KtxLocalEmbeddingBackend = KtxEmbeddingBackend | 'none';
type KtxScanEnrichmentMode = 'none' | 'deterministic' | 'llm';

interface KtxProjectPromptCachingConfig {
  enabled?: boolean;
  systemTtl?: KtxPromptCacheTtl;
  toolsTtl?: KtxPromptCacheTtl;
  historyTtl?: KtxPromptCacheTtl;
  vertexFallbackTo5m?: boolean;
}

export interface KtxProjectLlmProviderConfig {
  backend: KtxLocalLlmBackend;
  vertex?: { project?: string; location: string };
  anthropic?: { api_key?: string; base_url?: string };
  gateway?: { api_key?: string; base_url?: string };
}

export interface KtxProjectLlmConfig {
  provider: KtxProjectLlmProviderConfig;
  models: Partial<Record<KtxModelRole, string>> & { default?: string };
  promptCaching?: KtxProjectPromptCachingConfig;
}

export interface KtxProjectEmbeddingConfig {
  backend: KtxLocalEmbeddingBackend;
  model?: string;
  dimensions: number;
  openai?: { api_key?: string; base_url?: string };
  sentenceTransformers?: { base_url: string; pathPrefix?: string };
  batchSize?: number;
}

export interface KtxScanEnrichmentConfig {
  mode: KtxScanEnrichmentMode;
  embeddings?: KtxProjectEmbeddingConfig;
}

export interface KtxIngestWorkUnitsConfig {
  stepBudget: number;
  maxConcurrency: number;
  failureMode: 'abort' | 'continue';
}

export interface KtxScanRelationshipConfig {
  enabled: boolean;
  llmProposals: boolean;
  validationRequiredForManifest: boolean;
  acceptThreshold: number;
  reviewThreshold: number;
  maxLlmTablesPerBatch: number;
  maxCandidatesPerColumn: number;
  profileSampleRows: number;
  validationConcurrency: number;
  validationBudget?: number | 'all';
}

export interface KtxProjectScanConfig {
  enrichment: KtxScanEnrichmentConfig;
  relationships: KtxScanRelationshipConfig;
}

export interface KtxProjectConnectionConfig {
  driver: string;
  url?: string;
  [key: string]: unknown;
}

export interface KtxProjectSetupConfig {
  database_connection_ids: string[];
}

export interface KtxProjectConfig {
  project: string;
  setup?: KtxProjectSetupConfig;
  connections: Record<string, KtxProjectConnectionConfig>;
  storage: {
    state: KtxStorageState;
    search: KtxSearchBackend;
    git: {
      auto_commit: boolean;
      author: string;
    };
  };
  llm: KtxProjectLlmConfig;
  ingest: {
    adapters: string[];
    embeddings: KtxProjectEmbeddingConfig;
    workUnits: KtxIngestWorkUnitsConfig;
  };
  agent: {
    run_research: {
      enabled: boolean;
      max_iterations: number;
      default_toolset: string[];
    };
  };
  memory: {
    auto_commit: boolean;
  };
  scan: KtxProjectScanConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveIntegerConfigValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function validationBudgetConfigValue(value: unknown, fallback: number | 'all' | undefined): number | 'all' | undefined {
  if (value === 'all') {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function ratioConfigValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return fallback;
  }

  return value;
}

function localLlmBackend(value: unknown, fallback: KtxLocalLlmBackend, section = 'llm.provider'): KtxLocalLlmBackend {
  if (value == null) {
    return fallback;
  }

  if (value === 'none' || value === 'anthropic' || value === 'vertex' || value === 'gateway') {
    return value;
  }

  throw new Error(`Unsupported ${section}.backend: ${String(value)}`);
}

function localEmbeddingBackend(
  value: unknown,
  fallback: KtxLocalEmbeddingBackend,
  section = 'ingest.embeddings',
): KtxLocalEmbeddingBackend {
  if (value == null) {
    return fallback;
  }

  if (
    value === 'none' ||
    value === 'deterministic' ||
    value === 'openai' ||
    value === 'sentence-transformers'
  ) {
    return value;
  }

  throw new Error(`Unsupported ${section}.backend: ${String(value)}`);
}

function scanEnrichmentMode(value: unknown, fallback: KtxScanEnrichmentMode): KtxScanEnrichmentMode {
  if (value == null) {
    return fallback;
  }

  if (value === 'none' || value === 'deterministic' || value === 'llm') {
    return value;
  }

  throw new Error(`Unsupported scan.enrichment.mode: ${String(value)}`);
}

function rejectUnsupportedProvider(section: string, value: unknown): void {
  if (value !== undefined) {
    throw new Error(`Unsupported ${section}.provider: use ${section}.backend`);
  }
}

function optionalStringRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function optionalProviderConfig(value: unknown): { api_key?: string; base_url?: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const apiKey = optionalNonEmptyString(value.api_key);
  const baseUrl = optionalNonEmptyString(value.base_url);
  if (!apiKey && !baseUrl) {
    return undefined;
  }

  return {
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
  };
}

function parseModels(value: unknown): KtxProjectLlmConfig['models'] {
  if (!isRecord(value)) {
    return {};
  }

  const models: KtxProjectLlmConfig['models'] = {};
  for (const [role, model] of Object.entries(value)) {
    const modelName = optionalNonEmptyString(model);
    if (modelName) {
      models[role as KtxModelRole] = modelName;
    }
  }
  return models;
}

function promptCacheTtl(value: unknown): KtxPromptCacheTtl | undefined {
  return value === '5m' || value === '1h' ? value : undefined;
}

function parsePromptCaching(value: unknown): KtxProjectPromptCachingConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(promptCacheTtl(value.systemTtl) ? { systemTtl: promptCacheTtl(value.systemTtl) } : {}),
    ...(promptCacheTtl(value.toolsTtl) ? { toolsTtl: promptCacheTtl(value.toolsTtl) } : {}),
    ...(promptCacheTtl(value.historyTtl) ? { historyTtl: promptCacheTtl(value.historyTtl) } : {}),
    ...(typeof value.vertexFallbackTo5m === 'boolean' ? { vertexFallbackTo5m: value.vertexFallbackTo5m } : {}),
  };
}

function parseProjectLlmProviderConfig(
  raw: Record<string, unknown>,
  defaults: KtxProjectLlmProviderConfig,
  section: string,
): KtxProjectLlmProviderConfig {
  rejectUnsupportedProvider(section, raw.provider);

  const vertex = isRecord(raw.vertex)
    ? {
        ...(optionalNonEmptyString(raw.vertex.project) ? { project: optionalNonEmptyString(raw.vertex.project) } : {}),
        location: stringValue(raw.vertex.location, ''),
      }
    : undefined;
  const anthropic = optionalProviderConfig(raw.anthropic);
  const gateway = optionalProviderConfig(raw.gateway);

  return {
    backend: localLlmBackend(raw.backend, defaults.backend, section),
    ...(vertex ? { vertex } : {}),
    ...(anthropic ? { anthropic } : {}),
    ...(gateway ? { gateway } : {}),
  };
}

function parseProjectLlmConfig(raw: Record<string, unknown>, defaults: KtxProjectLlmConfig): KtxProjectLlmConfig {
  const provider = isRecord(raw.provider) ? raw.provider : {};
  return {
    provider: parseProjectLlmProviderConfig(provider, defaults.provider, 'llm.provider'),
    models: parseModels(raw.models ?? defaults.models),
    ...(parsePromptCaching(raw.promptCaching) ? { promptCaching: parsePromptCaching(raw.promptCaching) } : {}),
  };
}

function parseProjectEmbeddingConfig(
  raw: Record<string, unknown>,
  defaults: KtxProjectEmbeddingConfig,
  section: string,
): KtxProjectEmbeddingConfig {
  rejectUnsupportedProvider(section, raw.provider);

  const openai = optionalProviderConfig(raw.openai);
  const sentenceTransformers = isRecord(raw.sentenceTransformers)
    ? {
        base_url: stringValue(raw.sentenceTransformers.base_url, ''),
        ...(typeof raw.sentenceTransformers.pathPrefix === 'string'
          ? { pathPrefix: raw.sentenceTransformers.pathPrefix }
          : {}),
      }
    : undefined;

  const backend = localEmbeddingBackend(raw.backend, defaults.backend, section);
  const model =
    optionalNonEmptyString(raw.model) ?? (raw.backend == null && backend !== 'none' ? defaults.model : undefined);
  const batchSize = positiveIntegerConfigValue(raw.batchSize, 0);
  return {
    backend,
    ...(model ? { model } : {}),
    dimensions: positiveIntegerConfigValue(raw.dimensions, defaults.dimensions),
    ...(openai ? { openai } : {}),
    ...(sentenceTransformers ? { sentenceTransformers } : {}),
    ...(batchSize > 0 ? { batchSize } : {}),
  };
}

function parseScanRelationshipConfig(
  raw: Record<string, unknown>,
  defaults: KtxScanRelationshipConfig,
): KtxScanRelationshipConfig {
  const validationBudget = validationBudgetConfigValue(raw.validationBudget, defaults.validationBudget);

  return {
    enabled: booleanValue(raw.enabled, defaults.enabled),
    llmProposals: booleanValue(raw.llmProposals, defaults.llmProposals),
    validationRequiredForManifest: booleanValue(
      raw.validationRequiredForManifest,
      defaults.validationRequiredForManifest,
    ),
    acceptThreshold: ratioConfigValue(raw.acceptThreshold, defaults.acceptThreshold),
    reviewThreshold: ratioConfigValue(raw.reviewThreshold, defaults.reviewThreshold),
    maxLlmTablesPerBatch: positiveIntegerConfigValue(raw.maxLlmTablesPerBatch, defaults.maxLlmTablesPerBatch),
    maxCandidatesPerColumn: positiveIntegerConfigValue(raw.maxCandidatesPerColumn, defaults.maxCandidatesPerColumn),
    profileSampleRows: positiveIntegerConfigValue(raw.profileSampleRows, defaults.profileSampleRows),
    validationConcurrency: positiveIntegerConfigValue(raw.validationConcurrency, defaults.validationConcurrency),
    ...(validationBudget !== undefined ? { validationBudget } : {}),
  };
}

function workUnitFailureMode(value: unknown, fallback: 'abort' | 'continue'): 'abort' | 'continue' {
  return value === 'abort' || value === 'continue' ? value : fallback;
}

function parseIngestWorkUnitsConfig(
  raw: Record<string, unknown>,
  defaults: KtxIngestWorkUnitsConfig,
): KtxIngestWorkUnitsConfig {
  return {
    stepBudget: positiveIntegerConfigValue(raw.stepBudget, defaults.stepBudget),
    maxConcurrency: positiveIntegerConfigValue(raw.maxConcurrency, defaults.maxConcurrency),
    failureMode: workUnitFailureMode(raw.failureMode, defaults.failureMode),
  };
}

export function buildDefaultKtxProjectConfig(projectName = 'ktx-project'): KtxProjectConfig {
  return {
    project: projectName,
    connections: {},
    storage: {
      state: 'sqlite',
      search: 'sqlite-fts5',
      git: {
        auto_commit: true,
        author: 'ktx <ktx@example.com>',
      },
    },
    llm: {
      provider: {
        backend: 'none',
      },
      models: {},
    },
    ingest: {
      adapters: ['live-database', 'lookml', 'metabase', 'metricflow', 'notion'],
      embeddings: {
        backend: 'deterministic',
        model: 'deterministic',
        dimensions: 8,
      },
      workUnits: {
        stepBudget: 40,
        maxConcurrency: 1,
        failureMode: 'continue',
      },
    },
    agent: {
      run_research: {
        enabled: false,
        max_iterations: 20,
        default_toolset: ['sl_query', 'wiki_search', 'sl_read_source'],
      },
    },
    memory: {
      auto_commit: true,
    },
    scan: {
      enrichment: {
        mode: 'none',
      },
      relationships: {
        enabled: true,
        llmProposals: true,
        validationRequiredForManifest: true,
        acceptThreshold: 0.85,
        reviewThreshold: 0.55,
        maxLlmTablesPerBatch: 40,
        maxCandidatesPerColumn: 25,
        profileSampleRows: 10000,
        validationConcurrency: 4,
      },
    },
  };
}

export function parseKtxProjectConfig(raw: string): KtxProjectConfig {
  const parsed = YAML.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('ktx.yaml must contain a YAML object');
  }

  const project = parsed.project;
  if (typeof project !== 'string' || project.trim().length === 0) {
    throw new Error('ktx.yaml field "project" is required');
  }

  const defaults = buildDefaultKtxProjectConfig(project.trim());
  const llm = isRecord(parsed.llm) ? parsed.llm : {};
  const storage = isRecord(parsed.storage) ? parsed.storage : {};
  const storageGit = isRecord(storage.git) ? storage.git : {};
  const setup = isRecord(parsed.setup) ? parsed.setup : undefined;
  const ingest = isRecord(parsed.ingest) ? parsed.ingest : {};
  const ingestEmbeddings = isRecord(ingest.embeddings) ? ingest.embeddings : {};
  const ingestWorkUnits = isRecord(ingest.workUnits) ? ingest.workUnits : {};
  const agent = isRecord(parsed.agent) ? parsed.agent : {};
  const runResearch = isRecord(agent.run_research) ? agent.run_research : {};
  const memory = isRecord(parsed.memory) ? parsed.memory : {};
  const scan = isRecord(parsed.scan) ? parsed.scan : {};
  const scanEnrichment = isRecord(scan.enrichment) ? scan.enrichment : {};
  const scanRelationships = isRecord(scan.relationships) ? scan.relationships : {};
  if (isRecord(ingest.llm)) {
    throw new Error('Unsupported ingest.llm: use top-level llm.provider, llm.models, and ingest.workUnits');
  }
  if (scanEnrichment.backend !== undefined) {
    throw new Error('Unsupported scan.enrichment.backend: use scan.enrichment.mode');
  }
  if (isRecord(scanEnrichment.llm)) {
    throw new Error('Unsupported scan.enrichment.llm: use top-level llm.provider and llm.models');
  }

  const parsedLlm = parseProjectLlmConfig(llm, defaults.llm);
  const parsedIngestEmbeddings = parseProjectEmbeddingConfig(
    ingestEmbeddings,
    defaults.ingest.embeddings,
    'ingest.embeddings',
  );
  const parsedIngestWorkUnits = parseIngestWorkUnitsConfig(ingestWorkUnits, defaults.ingest.workUnits);
  const scanEmbeddings = parseProjectEmbeddingConfig(
    optionalStringRecord(scanEnrichment.embeddings),
    defaults.ingest.embeddings,
    'scan.enrichment.embeddings',
  );
  const parsedScanEnrichment: KtxScanEnrichmentConfig = {
    mode: scanEnrichmentMode(scanEnrichment.mode, defaults.scan.enrichment.mode),
    ...(isRecord(scanEnrichment.embeddings) ? { embeddings: scanEmbeddings } : {}),
  };
  const parsedScanRelationships = parseScanRelationshipConfig(scanRelationships, defaults.scan.relationships);

  return {
    project: project.trim(),
    ...(setup
      ? {
          setup: {
            database_connection_ids: stringArray(setup.database_connection_ids, []),
          },
        }
      : {}),
    connections: isRecord(parsed.connections)
      ? (parsed.connections as Record<string, KtxProjectConnectionConfig>)
      : defaults.connections,
    storage: {
      state: storage.state === 'sqlite' ? 'sqlite' : defaults.storage.state,
      search: storage.search === 'sqlite-fts5' ? 'sqlite-fts5' : defaults.storage.search,
      git: {
        auto_commit: booleanValue(storageGit.auto_commit, defaults.storage.git.auto_commit),
        author: stringValue(storageGit.author, defaults.storage.git.author),
      },
    },
    llm: parsedLlm,
    ingest: {
      adapters: stringArray(ingest.adapters, defaults.ingest.adapters),
      embeddings: parsedIngestEmbeddings,
      workUnits: parsedIngestWorkUnits,
    },
    agent: {
      run_research: {
        enabled: booleanValue(runResearch.enabled, defaults.agent.run_research.enabled),
        max_iterations: numberValue(runResearch.max_iterations, defaults.agent.run_research.max_iterations),
        default_toolset: stringArray(runResearch.default_toolset, defaults.agent.run_research.default_toolset),
      },
    },
    memory: {
      auto_commit: booleanValue(memory.auto_commit, defaults.memory.auto_commit),
    },
    scan: {
      enrichment: parsedScanEnrichment,
      relationships: parsedScanRelationships,
    },
  };
}

export function serializeKtxProjectConfig(config: KtxProjectConfig): string {
  return `${YAML.stringify(config, { indent: 2, lineWidth: 0 }).trimEnd()}\n`;
}
