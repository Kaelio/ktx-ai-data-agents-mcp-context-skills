import type { MemoryAction } from '../../memory/index.js';
import type { TouchedSlSource } from '../../tools/index.js';

interface StageIndexWorkUnit {
  unitKey: string;
  rawFiles: string[];
  status: 'success' | 'failed';
  reason?: string;
  actions: MemoryAction[];
  touchedSlSources: TouchedSlSource[];
  slDisallowed?: boolean;
  slDisallowedReason?: 'lookml_connection_mismatch';
}

export interface ConflictResolvedRecord {
  unitKey?: string;
  kind: 'structural_duplicate' | 'near_duplicate' | 'definitional_contradiction' | 're_ingest_change';
  contestedKey?: string;
  artifactKey: string;
  detail: string;
  flaggedForHuman: boolean;
}

export interface EvictionAppliedRecord {
  rawPath: string;
  artifactKind: 'sl' | 'wiki';
  artifactKey: string;
  action: 'removed';
  reason: string;
}

export type UnmappedFallbackReason =
  | 'no_connection_mapping'
  | 'looker_template_unresolved'
  | 'derived_table_not_supported'
  | 'no_physical_table'
  | 'multiple_table_references'
  | 'unsupported_dialect'
  | 'parse_error'
  | 'missing_target_table'
  | 'cumulative_metric_unsupported'
  | 'conversion_metric_unsupported';

export interface UnmappedFallbackRecord {
  rawPath: string;
  reason: UnmappedFallbackReason;
  detail?: string;
  fallback: 'sql_standalone' | 'wiki_only' | 'flagged';
}

export interface ArtifactResolutionRecord {
  rawPath: string;
  artifactKind: 'sl' | 'wiki';
  artifactKey: string;
  actionType: 'merged' | 'subsumed';
  reason: string;
}

export interface StageIndex {
  jobId: string;
  connectionId: string;
  workUnits: StageIndexWorkUnit[];
  conflictsResolved: ConflictResolvedRecord[];
  evictionsApplied: EvictionAppliedRecord[];
  unmappedFallbacks: UnmappedFallbackRecord[];
  artifactResolutions?: ArtifactResolutionRecord[];
}
