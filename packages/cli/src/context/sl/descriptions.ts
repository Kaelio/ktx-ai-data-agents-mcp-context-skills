const DESCRIPTION_SOURCES = ['user', 'ai', 'dbt', 'db'] as const;
type DescriptionSource = (typeof DESCRIPTION_SOURCES)[number];

type DescriptionSources = Record<string, string>;

interface DescriptionResolutionConfig {
  priority: string[];
}

export const DEFAULT_PRIORITY: DescriptionSource[] = [...DESCRIPTION_SOURCES];

/**
 * Resolves which description to surface based on a priority list.
 * Returns the first non-empty description matching a priority key,
 * falling back to the first available value for unknown sources.
 */
export function resolveDescription(
  descriptions: DescriptionSources | undefined,
  config: DescriptionResolutionConfig,
): string | null {
  if (!descriptions || Object.keys(descriptions).length === 0) {
    return null;
  }

  for (const source of config.priority) {
    const text = descriptions[source];
    if (text) {
      return text;
    }
  }

  // Fallback: first available value (for unknown future sources)
  return Object.values(descriptions).find(Boolean) ?? null;
}
