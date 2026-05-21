import type { KtxProjectConfig, KtxProjectConnectionConfig, KtxProjectEmbeddingConfig } from './context/project/config.js';
import type { KtxRuntimeFeature } from './managed-python-runtime.js';
import type { KtxPublicIngestPlan } from './public-ingest.js';

type KtxRuntimeRequirementReason =
  | 'query-history'
  | 'looker-source'
  | 'database-introspection'
  | 'local-embeddings';

interface KtxRuntimeRequirement {
  feature: KtxRuntimeFeature;
  reason: KtxRuntimeRequirementReason;
  detail: string;
}

export interface KtxRuntimeRequirements {
  features: KtxRuntimeFeature[];
  requirements: KtxRuntimeRequirement[];
}

export interface KtxProjectRuntimeRequirementOptions {
  databaseIntrospectionFallback?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface KtxPublicIngestRuntimeRequirementOptions {
  config?: KtxProjectConfig;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

function normalizeDriver(driver: unknown): string {
  return String(driver ?? '').trim().toLowerCase();
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function hasEnabledQueryHistory(connection: KtxProjectConnectionConfig): boolean {
  const context = recordValue(recordValue(connection).context);
  const queryHistory = recordValue(context.queryHistory);
  return queryHistory.enabled === true;
}

function hasDaemonOverride(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return typeof env.KTX_DAEMON_URL === 'string' && env.KTX_DAEMON_URL.trim().length > 0;
}

function hasSqlAnalysisOverride(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return (
    (typeof env.KTX_SQL_ANALYSIS_URL === 'string' && env.KTX_SQL_ANALYSIS_URL.trim().length > 0) ||
    hasDaemonOverride(env)
  );
}

function requiresManagedLocalEmbeddings(embeddings: KtxProjectEmbeddingConfig): boolean {
  if (embeddings.backend !== 'sentence-transformers') {
    return false;
  }
  const baseUrl = embeddings.sentenceTransformers?.base_url;
  return baseUrl === undefined || baseUrl === '';
}

function uniqueRequirements(requirements: KtxRuntimeRequirement[]): KtxRuntimeRequirements {
  const seen = new Set<string>();
  const deduped: KtxRuntimeRequirement[] = [];
  for (const requirement of requirements) {
    const key = `${requirement.feature}:${requirement.reason}:${requirement.detail}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(requirement);
  }
  const features = [...new Set(deduped.map((requirement) => requirement.feature))].sort((left, right) =>
    left.localeCompare(right),
  );
  return { features, requirements: deduped };
}

export function resolveProjectRuntimeRequirements(
  config: KtxProjectConfig,
  options: KtxProjectRuntimeRequirementOptions = {},
): KtxRuntimeRequirements {
  const env = options.env ?? process.env;
  const requirements: KtxRuntimeRequirement[] = [];

  if (options.databaseIntrospectionFallback === true && !hasDaemonOverride(env)) {
    requirements.push({
      feature: 'core',
      reason: 'database-introspection',
      detail: 'Database introspection fallback uses the KTX daemon.',
    });
  }

  for (const [connectionId, connection] of Object.entries(config.connections)) {
    const driver = normalizeDriver(connection.driver);
    if ((driver === 'looker' || driver === 'local_looker') && !hasDaemonOverride(env)) {
      requirements.push({
        feature: 'core',
        reason: 'looker-source',
        detail: `${connectionId} uses Looker identifier parsing.`,
      });
    }

    if (hasEnabledQueryHistory(connection) && !hasSqlAnalysisOverride(env)) {
      requirements.push({
        feature: 'core',
        reason: 'query-history',
        detail: `${connectionId} has query history enabled.`,
      });
    }
  }

  if (requiresManagedLocalEmbeddings(config.ingest.embeddings)) {
    requirements.push({
      feature: 'local-embeddings',
      reason: 'local-embeddings',
      detail: 'Local sentence-transformers embeddings use the managed Python runtime.',
    });
  }

  return uniqueRequirements(requirements);
}

export function resolvePublicIngestRuntimeRequirements(
  plan: KtxPublicIngestPlan,
  options: KtxPublicIngestRuntimeRequirementOptions = {},
): KtxRuntimeRequirements {
  const env = options.env ?? process.env;
  const requirements: KtxRuntimeRequirement[] = [];

  for (const target of plan.targets) {
    const driver = normalizeDriver(target.driver);
    const adapter = normalizeDriver(target.adapter);
    if (target.queryHistory?.enabled === true && !hasSqlAnalysisOverride(env)) {
      requirements.push({
        feature: 'core',
        reason: 'query-history',
        detail: `${target.connectionId} query-history ingest uses SQL analysis.`,
      });
    }
    if ((driver === 'looker' || driver === 'local_looker' || adapter === 'looker') && !hasDaemonOverride(env)) {
      requirements.push({
        feature: 'core',
        reason: 'looker-source',
        detail: `${target.connectionId} uses Looker identifier parsing.`,
      });
    }
  }

  if (options.config && requiresManagedLocalEmbeddings(options.config.ingest.embeddings)) {
    requirements.push({
      feature: 'local-embeddings',
      reason: 'local-embeddings',
      detail: 'Local sentence-transformers embeddings use the managed Python runtime.',
    });
  }

  return uniqueRequirements(requirements);
}
