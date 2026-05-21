import { parseMetabasePullConfig, type MetabasePullConfig } from './types.js';

interface MetabaseFanoutMappingInput {
  metabaseDatabaseId: number;
  targetConnectionId: string | null;
  syncEnabled: boolean;
}

export interface MetabaseFanoutChildPlan {
  metabaseConnectionId: string;
  metabaseDatabaseId: number;
  targetConnectionId: string;
  pullConfig: MetabasePullConfig;
}

export interface PlanMetabaseFanoutChildrenInput {
  metabaseConnectionId: string;
  mappings: MetabaseFanoutMappingInput[];
}

export function planMetabaseFanoutChildren(input: PlanMetabaseFanoutChildrenInput): MetabaseFanoutChildPlan[] {
  const children: MetabaseFanoutChildPlan[] = [];

  for (const mapping of input.mappings) {
    if (!mapping.syncEnabled || mapping.targetConnectionId === null) {
      continue;
    }

    const pullConfig = parseMetabasePullConfig({
      metabaseConnectionId: input.metabaseConnectionId,
      metabaseDatabaseId: mapping.metabaseDatabaseId,
    });

    children.push({
      metabaseConnectionId: input.metabaseConnectionId,
      metabaseDatabaseId: mapping.metabaseDatabaseId,
      targetConnectionId: mapping.targetConnectionId,
      pullConfig,
    });
  }

  if (children.length === 0) {
    throw new Error(
      `no sync-enabled mappings with a target connection for Metabase connection ${input.metabaseConnectionId}`,
    );
  }

  return children;
}
