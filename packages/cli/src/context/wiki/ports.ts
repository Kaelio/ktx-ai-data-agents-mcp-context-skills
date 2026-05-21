
export interface UpsertPageParams {
  scope: string;
  scopeId: string | null;
  pageKey: string;
  summary: string;
  usageMode: string;
  sortOrder: number;
  searchText: string;
  embedding: number[] | null;
  contentHash?: string | null;
  sourceRunId?: string | null;
}

export interface KnowledgeIndexPageListing {
  id?: string;
  page_key: string;
  summary: string;
  scope: string;
  scope_id: string | null;
  tags: string[];
}

export interface KnowledgeIndexPort {
  upsertPage(params: UpsertPageParams): Promise<void>;
  applyDiffTransactional(params: {
    runId: string;
    upserts: UpsertPageParams[];
    deletes: Array<{ scope: string; scopeId: string | null; pageKey: string }>;
  }): Promise<void>;
  getExistingSearchTexts(
    scope: string,
    scopeId: string | null,
  ): Promise<Map<string, { searchText: string; hasEmbedding: boolean }>>;
  deleteStale(scope: string, scopeId: string | null, keepKeys: string[]): Promise<number>;
  deleteByScope(scope: string, scopeId: string | null): Promise<number>;
  deleteByKey(scope: string, scopeId: string | null, pageKey: string): Promise<number>;
  findPageByKey(
    scope: string,
    scopeId: string | null,
    pageKey: string,
  ): Promise<{ id?: string; page_key: string } | null | undefined>;
  listPagesForUser(userId: string): Promise<KnowledgeIndexPageListing[]>;
  getUserPageCount(userId: string): Promise<number>;
  incrementUsageCount(pageIds: string[]): Promise<void>;
  searchRRF(
    userId: string,
    queryEmbedding: number[] | null,
    queryText: string,
    limit: number,
  ): Promise<Array<{ pageKey: string; summary: string; rrfScore: number }>>;
}

export interface KnowledgeEventPort {
  createEvent(params: {
    blockId: string | null;
    eventType: string;
    actorId: string;
    chatId?: string | null;
    messageId?: string | null;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface KnowledgeGitDiffPort {
  diffNameStatus(
    fromSha: string,
    toSha: string,
    pathPrefix?: string,
  ): Promise<Array<{ status: string; path: string }>>;
  getFileAtCommit(path: string, sha: string): Promise<string>;
}
