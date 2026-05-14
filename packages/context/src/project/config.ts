import { KTX_MODEL_ROLES } from '@ktx/llm';
import YAML from 'yaml';
import * as z from 'zod';

const KTX_LLM_BACKENDS = ['none', 'anthropic', 'vertex', 'gateway'] as const;
const KTX_EMBEDDING_BACKENDS = ['none', 'deterministic', 'openai', 'sentence-transformers'] as const;
const KTX_PROMPT_CACHE_TTLS = ['5m', '1h'] as const;
const KTX_ENRICHMENT_MODES = ['none', 'deterministic', 'llm'] as const;
const KTX_WORK_UNIT_FAILURE_MODES = ['abort', 'continue'] as const;
const KTX_STORAGE_STATES = ['sqlite', 'postgres'] as const;
const KTX_SEARCH_BACKENDS = ['sqlite-fts5', 'postgres-hybrid'] as const;

const DEPRECATED_KEY_HINTS: Record<string, string> = {
  'llm.provider.provider': 'use llm.provider.backend',
  'ingest.llm': 'use top-level llm.provider, llm.models, and ingest.workUnits',
  'ingest.embeddings.provider': 'use ingest.embeddings.backend',
  'scan.enrichment.backend': 'use scan.enrichment.mode',
  'scan.enrichment.llm': 'use top-level llm.provider and llm.models',
  'scan.enrichment.embeddings.provider': 'use scan.enrichment.embeddings.backend',
};

const apiCredentialsSchema = z.strictObject({
  api_key: z.string().min(1).optional(),
  base_url: z.string().min(1).optional(),
});

const vertexProviderSchema = z.strictObject({
  project: z.string().min(1).optional(),
  location: z.string().default(''),
});

const sentenceTransformersSchema = z.strictObject({
  base_url: z.string().default(''),
  pathPrefix: z.string().optional(),
});

const llmProviderSchema = z.strictObject({
  backend: z.enum(KTX_LLM_BACKENDS).default('none'),
  vertex: vertexProviderSchema.optional(),
  anthropic: apiCredentialsSchema.optional(),
  gateway: apiCredentialsSchema.optional(),
});

const promptCachingSchema = z.strictObject({
  enabled: z.boolean().optional(),
  systemTtl: z.enum(KTX_PROMPT_CACHE_TTLS).optional(),
  toolsTtl: z.enum(KTX_PROMPT_CACHE_TTLS).optional(),
  historyTtl: z.enum(KTX_PROMPT_CACHE_TTLS).optional(),
  vertexFallbackTo5m: z.boolean().optional(),
});

const llmSchema = z.strictObject({
  provider: llmProviderSchema.prefault({}),
  models: z.partialRecord(z.enum(KTX_MODEL_ROLES), z.string().min(1)).default({}),
  promptCaching: promptCachingSchema.optional(),
});

const embeddingSchema = z.strictObject({
  backend: z.enum(KTX_EMBEDDING_BACKENDS).default('deterministic'),
  model: z.string().min(1).optional(),
  dimensions: z.int().positive().default(8),
  openai: apiCredentialsSchema.optional(),
  sentenceTransformers: sentenceTransformersSchema.optional(),
  batchSize: z.int().positive().optional(),
});

const workUnitsSchema = z.strictObject({
  stepBudget: z.int().positive().default(40),
  maxConcurrency: z.int().positive().default(1),
  failureMode: z.enum(KTX_WORK_UNIT_FAILURE_MODES).default('continue'),
});

const ingestSchema = z.strictObject({
  adapters: z.array(z.string().min(1)).default([]),
  embeddings: embeddingSchema.prefault({ backend: 'deterministic', model: 'deterministic' }),
  workUnits: workUnitsSchema.prefault({}),
});

const scanEnrichmentSchema = z.strictObject({
  mode: z.enum(KTX_ENRICHMENT_MODES).default('none'),
  embeddings: embeddingSchema.optional(),
});

const scanRelationshipsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  llmProposals: z.boolean().default(true),
  validationRequiredForManifest: z.boolean().default(true),
  acceptThreshold: z.number().min(0).max(1).default(0.85),
  reviewThreshold: z.number().min(0).max(1).default(0.55),
  maxLlmTablesPerBatch: z.int().positive().default(40),
  maxCandidatesPerColumn: z.int().positive().default(25),
  profileSampleRows: z.int().positive().default(10000),
  validationConcurrency: z.int().positive().default(4),
  validationBudget: z.union([z.literal('all'), z.int().nonnegative()]).optional(),
});

const scanSchema = z.strictObject({
  enrichment: scanEnrichmentSchema.prefault({}),
  relationships: scanRelationshipsSchema.prefault({}),
});

const setupSchema = z.strictObject({
  database_connection_ids: z.array(z.string().min(1)).default([]),
});

const storageGitSchema = z.strictObject({
  auto_commit: z.boolean().default(true),
  author: z.string().min(1).default('ktx <ktx@example.com>'),
});

const storageSchema = z.strictObject({
  state: z.enum(KTX_STORAGE_STATES).default('sqlite'),
  search: z.enum(KTX_SEARCH_BACKENDS).default('sqlite-fts5'),
  git: storageGitSchema.prefault({}),
});

const connectionSchema = z.looseObject({
  driver: z.string().min(1),
  url: z.string().optional(),
});

const agentSchema = z.strictObject({
  run_research: z
    .strictObject({
      enabled: z.boolean().default(false),
      max_iterations: z.number().int().nonnegative().default(20),
      default_toolset: z.array(z.string().min(1)).default(['sl_query', 'wiki_search', 'sl_read_source']),
    })
    .prefault({}),
});

const memorySchema = z.strictObject({
  auto_commit: z.boolean().default(true),
});

const ktxProjectConfigSchema = z.strictObject({
  project: z
    .string({ error: 'ktx.yaml field "project" is required' })
    .trim()
    .min(1, 'ktx.yaml field "project" is required'),
  setup: setupSchema.optional(),
  connections: z.record(z.string(), connectionSchema).default({}),
  storage: storageSchema.prefault({}),
  llm: llmSchema.prefault({}),
  ingest: ingestSchema.prefault({}),
  agent: agentSchema.prefault({}),
  memory: memorySchema.prefault({}),
  scan: scanSchema.prefault({}),
});

export type KtxProjectConfig = z.infer<typeof ktxProjectConfigSchema>;
export type KtxProjectLlmConfig = z.infer<typeof llmSchema>;
export type KtxProjectLlmProviderConfig = z.infer<typeof llmProviderSchema>;
export type KtxProjectEmbeddingConfig = z.infer<typeof embeddingSchema>;
export type KtxScanEnrichmentConfig = z.infer<typeof scanEnrichmentSchema>;
export type KtxIngestWorkUnitsConfig = z.infer<typeof workUnitsSchema>;
export type KtxScanRelationshipConfig = z.infer<typeof scanRelationshipsSchema>;
export type KtxProjectScanConfig = z.infer<typeof scanSchema>;
export type KtxProjectConnectionConfig = z.infer<typeof connectionSchema>;
export type KtxProjectSetupConfig = z.infer<typeof setupSchema>;
export type KtxStorageState = z.infer<typeof storageSchema>['state'];
export type KtxSearchBackend = z.infer<typeof storageSchema>['search'];

export interface KtxConfigIssue {
  path: string;
  message: string;
  fix?: string;
}

export interface KtxConfigValidation {
  ok: boolean;
  issues: KtxConfigIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dottedPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((segment) => String(segment)).join('.');
}

function valueAtPath(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor;
}

function formatIssue(issue: z.core.$ZodIssue, input: unknown): KtxConfigIssue[] {
  const basePath = dottedPath(issue.path);

  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as { keys?: readonly string[] }).keys ?? [];
    return keys.map((key) => {
      const fullPath = basePath.length > 0 ? `${basePath}.${key}` : key;
      const hint = DEPRECATED_KEY_HINTS[fullPath];
      if (hint !== undefined) {
        return { path: fullPath, message: `Unsupported ${fullPath}: ${hint}`, fix: hint };
      }
      return { path: fullPath, message: `Unsupported ${fullPath}: unknown field` };
    });
  }

  const lastSegment = issue.path[issue.path.length - 1];
  if (lastSegment === 'backend' && (issue.code === 'invalid_value' || issue.code === 'invalid_type')) {
    const value = valueAtPath(input, issue.path);
    return [{ path: basePath, message: `Unsupported ${basePath}: ${String(value)}` }];
  }

  return [{ path: basePath, message: basePath.length > 0 ? `${basePath}: ${issue.message}` : issue.message }];
}

function collectIssues(error: z.ZodError, input: unknown): KtxConfigIssue[] {
  return error.issues.flatMap((issue) => formatIssue(issue, input));
}

function formatZodError(error: z.ZodError, input: unknown): string {
  return collectIssues(error, input)
    .map((issue) => issue.message)
    .join('\n');
}

export function buildDefaultKtxProjectConfig(projectName = 'ktx-project'): KtxProjectConfig {
  return ktxProjectConfigSchema.parse({ project: projectName });
}

export function parseKtxProjectConfig(raw: string): KtxProjectConfig {
  const parsed = YAML.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('ktx.yaml must contain a YAML object');
  }
  const result = ktxProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(result.error, parsed));
  }
  return result.data;
}

export function validateKtxProjectConfig(raw: string): KtxConfigValidation {
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: '', message: `ktx.yaml parse error: ${message}` }] };
  }
  if (!isRecord(parsed)) {
    return { ok: false, issues: [{ path: '', message: 'ktx.yaml must contain a YAML object' }] };
  }
  const result = ktxProjectConfigSchema.safeParse(parsed);
  if (result.success) {
    return { ok: true, issues: [] };
  }
  return { ok: false, issues: collectIssues(result.error, parsed) };
}

export function serializeKtxProjectConfig(config: KtxProjectConfig): string {
  const serializedConfig =
    config.ingest.adapters.length === 0
      ? {
          ...config,
          ingest: {
            embeddings: config.ingest.embeddings,
            workUnits: config.ingest.workUnits,
          },
        }
      : config;
  return `${YAML.stringify(serializedConfig, { indent: 2, lineWidth: 0 }).trimEnd()}\n`;
}
