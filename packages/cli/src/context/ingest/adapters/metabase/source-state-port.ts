import type { MetabaseSyncMode } from './types.js';

export interface MetabaseSourceStateSelection {
  selectionType: 'collection' | 'item';
  metabaseObjectId: number;
}

interface MetabaseSourceStateMapping {
  metabaseDatabaseId: number;
  metabaseDatabaseName: string | null;
  metabaseEngine: string | null;
  metabaseHost?: string | null;
  metabaseDbName?: string | null;
  targetConnectionId: string | null;
  syncEnabled: boolean;
}

export interface MetabaseSourceState {
  syncMode: MetabaseSyncMode;
  selections: MetabaseSourceStateSelection[];
  defaultTagNames: string[];
  mappings: MetabaseSourceStateMapping[];
}

export interface MetabaseSourceStateReader {
  getSourceState(connectionId: string): Promise<MetabaseSourceState>;
}
