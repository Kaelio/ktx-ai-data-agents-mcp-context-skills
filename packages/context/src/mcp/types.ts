import type { MemoryIngestService } from '../memory/index.js';
import type { KtxEntityDetailsInput, KtxEntityDetailsResponse } from '../scan/entity-details.js';
import type { KtxDiscoverDataInput, KtxDiscoverDataResponse } from '../search/index.js';
import type { KtxDictionarySearchInput, KtxDictionarySearchResponse, SemanticLayerQueryInput } from '../sl/index.js';
import type { WikiSearchLaneSummary, WikiSearchMatchReason } from '../wiki/index.js';

export interface KtxMcpTextContent {
  type: 'text';
  text: string;
}

export interface KtxMcpToolResult<T extends object = object> {
  content: KtxMcpTextContent[];
  structuredContent?: T;
  isError?: true;
}

export interface MemoryIngestPort {
  ingest: MemoryIngestService['ingest'];
  status: MemoryIngestService['status'];
}

export interface KtxMcpUserContext {
  userId: string;
}

export interface KtxMcpServerLike {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema: unknown;
    },
    handler: (input: Record<string, unknown>) => Promise<unknown>,
  ): void;
}

export interface KtxConnectionSummary {
  id: string;
  name: string;
  connectionType: string;
}

export interface KtxConnectionsMcpPort {
  list(): Promise<KtxConnectionSummary[]>;
}

export interface KtxKnowledgeSearchResult {
  key: string;
  path: string;
  scope: 'GLOBAL' | 'USER';
  summary: string;
  score: number;
  matchReasons?: WikiSearchMatchReason[];
  lanes?: WikiSearchLaneSummary[];
}

export interface KtxKnowledgeSearchResponse {
  results: KtxKnowledgeSearchResult[];
  totalFound: number;
}

export interface KtxKnowledgePage {
  key: string;
  summary: string;
  content: string;
  scope: 'GLOBAL' | 'USER';
  tags?: string[];
  refs?: string[];
  slRefs?: string[];
}

export interface KtxKnowledgeMcpPort {
  search(input: { userId: string; query: string; limit: number }): Promise<KtxKnowledgeSearchResponse>;
  read(input: { userId: string; key: string }): Promise<KtxKnowledgePage | null>;
}

export interface KtxSemanticLayerReadResponse {
  sourceName: string;
  yaml: string;
}

export interface KtxSemanticLayerQueryResponse {
  sql: string;
  headers: string[];
  rows: unknown[][];
  totalRows: number;
  plan?: Record<string, unknown>;
}

export interface KtxSemanticLayerMcpPort {
  readSource(input: { connectionId: string; sourceName: string }): Promise<KtxSemanticLayerReadResponse | null>;
  query(input: { connectionId?: string; query: SemanticLayerQueryInput }): Promise<KtxSemanticLayerQueryResponse>;
}

export interface KtxEntityDetailsMcpPort {
  read(input: KtxEntityDetailsInput): Promise<KtxEntityDetailsResponse>;
}

export interface KtxDictionarySearchMcpPort {
  search(input: KtxDictionarySearchInput): Promise<KtxDictionarySearchResponse>;
}

export interface KtxDiscoverDataMcpPort {
  search(input: KtxDiscoverDataInput): Promise<KtxDiscoverDataResponse>;
}

export interface KtxSqlExecutionResponse {
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface KtxSqlExecutionMcpPort {
  execute(input: { connectionId: string; sql: string; maxRows: number }): Promise<KtxSqlExecutionResponse>;
}

export interface KtxMcpContextPorts {
  connections?: KtxConnectionsMcpPort;
  knowledge?: KtxKnowledgeMcpPort;
  semanticLayer?: KtxSemanticLayerMcpPort;
  entityDetails?: KtxEntityDetailsMcpPort;
  dictionarySearch?: KtxDictionarySearchMcpPort;
  discover?: KtxDiscoverDataMcpPort;
  sqlExecution?: KtxSqlExecutionMcpPort;
  memoryIngest?: MemoryIngestPort;
}

export interface KtxMcpServerDeps {
  server: KtxMcpServerLike;
  userContext: KtxMcpUserContext;
  contextTools?: KtxMcpContextPorts;
}
