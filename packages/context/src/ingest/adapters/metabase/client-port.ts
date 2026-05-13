import type { FetchContext } from '../../types.js';
import type { MetabasePullConfig } from './types.js';

export interface TestConnectionResult {
  success: boolean;
  message?: string;
  details?: unknown;
  error?: string;
  metadata?: unknown;
}

export interface MetabaseClientConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  jitter: boolean;
  retryableStatuses: number[];
}

export interface MetabaseClientRuntimeConfig {
  apiUrl: string;
  apiKey: string;
  /**
   * Override the default authentication header name.
   * - API keys: `x-api-key` (default)
   * - Session tokens: `X-Metabase-Session`
   */
  authHeaderName?: string;
}

export interface MetabaseUser {
  id: number;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  common_name?: string | null;
  is_superuser?: boolean | null;
}

export interface MetabaseDatabase {
  id: number;
  name: string;
  engine?: string | null;
  details?: Record<string, unknown> | null;
  is_sample?: boolean | null;
}

export interface MetabaseCollection {
  id: number | 'root';
  name: string;
  parent_id?: number | 'root' | null;
  children?: MetabaseCollection[];
}

export interface MetabaseCollectionItem {
  id: number;
  model: 'card' | 'dataset' | 'metric' | string;
  name?: string | null;
  collection_id?: number | 'root' | null;
  database_id?: number | null;
}

export interface MetabaseCardSummary {
  id: number;
  name?: string | null;
  archived?: boolean;
  database_id?: number | null;
  collection_id?: number | 'root' | null;
}

export interface MetabaseResultMetadataColumn {
  name: string;
  base_type: string;
  semantic_type?: string | null;
  display_name?: string | null;
  description?: string | null;
  fk_target_field_id?: number | null;
  field_ref?: unknown[] | null;
}

export interface MetabaseParameter {
  id: string;
  name: string;
  type: string;
  slug?: string | null;
  default?: unknown;
  sectionId?: string | null;
}

export interface MetabaseTemplateTag {
  id?: string;
  name: string;
  type: string;
  display_name?: string | null;
  'display-name'?: string;
  default?: unknown;
  card_id?: number | null;
  'card-id'?: number;
  'snippet-name'?: string;
  'snippet-id'?: number;
  dimension?: unknown[];
  'widget-type'?: string;
}

export interface MetabaseResolvedTemplateTag {
  name: string;
  type: string;
  cardReference?: number | null;
  defaultValue?: string | null;
}

interface MetabaseNativeStage {
  'lib/type': 'mbql.stage/native';
  native: string;
  'template-tags'?: Record<string, MetabaseTemplateTag>;
}

export interface MetabaseDatasetQuery {
  'lib/type'?: 'mbql/query';
  database?: number;
  type?: 'native' | 'query';
  stages?: MetabaseNativeStage[];
}

export interface MetabaseNativeQueryResult {
  query: string;
}

export interface ResolvedSqlResult {
  resolvedSql: string;
  templateTags: MetabaseResolvedTemplateTag[];
  resolutionStatus: 'resolved' | 'fallback';
}

export interface MetabaseCard {
  id: number;
  name: string;
  description?: string | null;
  type: string;
  query_type?: 'native' | 'query';
  database_id: number;
  collection_id?: number | 'root' | null;
  archived?: boolean;
  result_metadata?: MetabaseResultMetadataColumn[] | null;
  dataset_query?: MetabaseDatasetQuery | null;
  parameters?: MetabaseParameter[] | null;
  last_run_at?: string | null;
  dashboard_count?: number | null;
}

export interface MetabaseRuntimeClient {
  testConnection(): Promise<TestConnectionResult>;
  getCurrentUser(): Promise<MetabaseUser>;
  getDatabases(): Promise<MetabaseDatabase[]>;
  getDatabase(id: number): Promise<MetabaseDatabase>;
  getCollectionTree(): Promise<MetabaseCollection[]>;
  getCollection(id: number | 'root'): Promise<MetabaseCollection>;
  getCollectionItems(
    collectionId: number | 'root',
    models?: ('card' | 'dataset' | 'metric')[],
  ): Promise<MetabaseCollectionItem[]>;
  getCard(id: number): Promise<MetabaseCard>;
  getAllCards(): Promise<MetabaseCardSummary[]>;
  convertMbqlToNative(datasetQuery: MetabaseDatasetQuery): Promise<MetabaseNativeQueryResult>;
  getNativeSql(card: MetabaseCard): string | null;
  getTemplateTags(card: MetabaseCard): Record<string, MetabaseTemplateTag>;
  getCardSql(card: MetabaseCard): Promise<string | null>;
  getResolvedSql(card: MetabaseCard): Promise<ResolvedSqlResult | null>;
  cleanup(): Promise<void>;
}

export interface MetabaseConnectionClientFactory {
  createClient(
    metabaseConnectionId: string,
    overrides?: Partial<MetabaseClientConfig>,
  ): Promise<MetabaseRuntimeClient> | MetabaseRuntimeClient;
}

export interface MetabaseClientFactory {
  createClient(config: MetabasePullConfig, ctx: FetchContext): Promise<MetabaseRuntimeClient> | MetabaseRuntimeClient;
}

export class IngestMetabaseClientFactory implements MetabaseClientFactory {
  constructor(private readonly connectionFactory: MetabaseConnectionClientFactory) {}

  async createClient(config: MetabasePullConfig, _ctx: FetchContext): Promise<MetabaseRuntimeClient> {
    return this.connectionFactory.createClient(config.metabaseConnectionId);
  }
}
