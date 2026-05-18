import type { KtxProjectConfig, KtxProjectConnectionConfig } from '@ktx/context/project';

export type KtxDatabaseContextDepth = 'fast' | 'deep';

const KTX_DATABASE_DRIVER_IDS = new Set([
  'sqlite',
  'duckdb',
  'postgres',
  'postgresql',
  'mysql',
  'clickhouse',
  'sqlserver',
  'bigquery',
  'snowflake',
]);

export function normalizeConnectionDriver(connection: KtxProjectConnectionConfig): string {
  return String(connection.driver ?? '')
    .trim()
    .toLowerCase();
}

export function isDatabaseDriver(driver: string): boolean {
  return KTX_DATABASE_DRIVER_IDS.has(driver.trim().toLowerCase());
}

function connectionContextRecord(connection: KtxProjectConnectionConfig): Record<string, unknown> {
  const context = connection.context;
  return typeof context === 'object' && context !== null && !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : {};
}

export function databaseContextDepth(connection: KtxProjectConnectionConfig): KtxDatabaseContextDepth | undefined {
  const depth = connectionContextRecord(connection).depth;
  return depth === 'fast' || depth === 'deep' ? depth : undefined;
}

export function withDatabaseContextDepth(
  connection: KtxProjectConnectionConfig,
  depth: KtxDatabaseContextDepth,
): KtxProjectConnectionConfig {
  return {
    ...connection,
    context: {
      ...connectionContextRecord(connection),
      depth,
    },
  };
}

export function deepReadinessGaps(config: KtxProjectConfig): string[] {
  const gaps: string[] = [];
  if (config.llm.provider.backend === 'none' || !config.llm.models.default) {
    gaps.push('model configuration');
  }

  if (config.scan.enrichment.mode !== 'llm') {
    gaps.push('scan enrichment mode');
  }

  const embeddings = config.scan.enrichment.embeddings;
  if (
    !embeddings ||
    embeddings.backend === 'none' ||
    embeddings.backend === 'deterministic' ||
    !embeddings.model ||
    embeddings.dimensions <= 0
  ) {
    gaps.push('scan embeddings');
  }

  return gaps;
}

export function recommendedDatabaseContextDepth(config: KtxProjectConfig): KtxDatabaseContextDepth {
  return deepReadinessGaps(config).length === 0 ? 'deep' : 'fast';
}
