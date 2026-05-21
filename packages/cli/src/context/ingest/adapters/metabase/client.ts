import { CardReferenceCycleError, expandCardReferences } from './card-references.js';
import type {
  MetabaseCard,
  MetabaseCardSummary,
  MetabaseClientConfig,
  MetabaseClientRuntimeConfig,
  MetabaseCollection,
  MetabaseCollectionItem,
  MetabaseConnectionClientFactory,
  MetabaseDatabase,
  MetabaseDatasetQuery,
  MetabaseNativeQueryResult,
  MetabaseRuntimeClient,
  MetabaseTemplateTag,
  MetabaseUser,
  ResolvedSqlResult,
  TestConnectionResult,
} from './client-port.js';

export interface MetabaseClientLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

const defaultLogger: MetabaseClientLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface TemplateTagInfo {
  [key: string]: string | null;
  name: string;
  type: string;
  displayName: string;
  dummyValue: string | null;
}

interface NativeQuerySnippet {
  id: number;
  name: string;
  content: string;
  archived?: boolean | null;
}

interface CreateCardParams {
  name: string;
  databaseId: number;
  sql: string;
  collectionId?: number | null;
  display?: string;
  description?: string;
}

export const DEFAULT_METABASE_CLIENT_CONFIG: MetabaseClientConfig = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  timeoutMs: 60000,
  jitter: true,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/** Custom error class to preserve Metabase API error details */
class MetabaseApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: string,
    public readonly isRetryable: boolean,
  ) {
    super(message);
    this.name = 'MetabaseApiError';
  }
}

/**
 * Strip Metabase `[[ ... {{ var }} ... ]]` optional-clause blocks from native SQL.
 *
 * The bracketed blocks are emitted only when the embedded `{{ var }}` is supplied at
 * Metabase query time. For KTX semantic-layer ingest there's no such runtime
 * parameter — chat-time filters are composed by the SL query planner — so the optional
 * block must be removed before the SQL becomes a permanent SL source. Substituting a
 * dummy value (the alternative) bakes a placeholder filter into the source and silently
 * excludes rows.
 *
 * Only strips brackets that contain at least one `{{ }}` placeholder, so unrelated
 * `[[`/`]]` literals in string values or regex predicates are preserved. Metabase's
 * grammar disallows nested optional blocks (per docs), so non-greedy matching is safe.
 */
/** @internal */
export function stripOptionalClauses(sql: string): string {
  return sql.replace(/\[\[[\s\S]*?\]\]/g, (match) => (match.includes('{{') ? '' : match));
}

/**
 * Find every `{{ var }}` placeholder name still present in the SQL. Excludes `{{#N}}`
 * card references (those are handled separately by `expandCardReferences`).
 */
function collectRemainingPlaceholderNames(sql: string): Set<string> {
  const names = new Set<string>();
  for (const match of sql.matchAll(/\{\{\s*([^#}\s][^}]*?)\s*\}\}/g)) {
    names.add(match[1].trim());
  }
  return names;
}

function collectRemainingSnippetNames(sql: string): Set<string> {
  const names = new Set<string>();
  for (const match of sql.matchAll(/\{\{\s*snippet:\s*([^}]+?)\s*\}\}/gi)) {
    names.add(match[1].trim());
  }
  return names;
}

function normalizeSnippetName(name: string | null | undefined): string {
  return (name ?? '').replace(/^snippet:\s*/i, '').trim().toLowerCase();
}

function parseNativeQuerySnippets(value: unknown): NativeQuerySnippet[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : [];
  const snippets: NativeQuerySnippet[] = [];
  for (const item of rawItems) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'number' || typeof rec.name !== 'string' || typeof rec.content !== 'string') {
      continue;
    }
    snippets.push({
      id: rec.id,
      name: rec.name,
      content: rec.content,
      ...(typeof rec.archived === 'boolean' ? { archived: rec.archived } : {}),
    });
  }
  return snippets;
}

function injectNativeSql(datasetQuery: MetabaseDatasetQuery, sql: string): MetabaseDatasetQuery {
  if (datasetQuery?.stages?.[0]?.native !== undefined) {
    const stages = [...(datasetQuery.stages ?? [])];
    stages[0] = { ...stages[0], native: sql };
    return { ...datasetQuery, stages };
  }
  if (datasetQuery?.native?.query !== undefined) {
    return { ...datasetQuery, native: { ...datasetQuery.native, query: sql } };
  }
  return datasetQuery;
}

/**
 * Picks a dummy `parameters[].value` for a `dimension`-type template tag based on its
 * `widget-type`. Metabase's `/api/dataset/native` dispatches widget-types to substitution
 * functions whose value-shape contracts differ — date widgets need a string in the widget's
 * format, number widgets need a string scalar, identifier/enum widgets accept `[string]`.
 * Sending `['placeholder']` for a date widget triggers a ClassCastException → HTTP 500.
 */
/** @internal */
export function getDummyValueForWidgetType(widgetType: string | undefined): string | string[] {
  switch (widgetType) {
    case 'date/range':
    case 'date/all-options':
      return '2020-01-01~2020-12-31';
    case 'date/single':
      return '2020-01-01';
    case 'date/relative':
      return 'past30days';
    case 'date/month-year':
      return '2020-01';
    case 'date/quarter-year':
      return 'Q1-2020';
    case 'number/=':
    case 'number/!=':
    case 'number/>=':
    case 'number/<=':
    case 'number/between':
      return '1';
    default:
      return ['placeholder'];
  }
}

export class MetabaseClient implements MetabaseRuntimeClient {
  private readonly runtime: MetabaseClientRuntimeConfig;
  private readonly logger: MetabaseClientLogger;
  private readonly baseUrl: string;
  private readonly config: MetabaseClientConfig;
  private snippetCache: Promise<NativeQuerySnippet[]> | null = null;

  constructor(
    runtime: MetabaseClientRuntimeConfig,
    config?: Partial<MetabaseClientConfig>,
    logger: MetabaseClientLogger = defaultLogger,
  ) {
    this.runtime = runtime;
    this.baseUrl = runtime.apiUrl.replace(/\/+$/, '');
    this.config = { ...DEFAULT_METABASE_CLIENT_CONFIG, ...config };
    this.logger = logger;
  }

  async cleanup(): Promise<void> {
    // Proxy cleanup stays server-only in v1. The no-op keeps the runtime-client contract stable.
  }

  get dataSourceType(): string {
    return 'metabase';
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const [user, databases] = await Promise.all([this.getCurrentUser(), this.getDatabases()]);

      return {
        success: true,
        metadata: {
          user: {
            email: user.email,
            name: user.common_name,
            isSuperuser: user.is_superuser,
          },
          databases: databases
            .filter((db) => !db.is_sample)
            .map((db) => ({
              id: db.id,
              name: db.name,
              engine: db.engine,
              host: db.details?.host ?? null,
              dbName: db.details?.dbname ?? db.details?.db ?? null,
            })),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async getCurrentUser(): Promise<MetabaseUser> {
    return this.request<MetabaseUser>('GET', '/api/user/current');
  }

  async createSession(username: string, password: string): Promise<string> {
    const response = await this.request<{ id?: unknown }>('POST', '/api/session', { username, password });
    if (typeof response.id !== 'string' || response.id.trim().length === 0) {
      throw new Error('Metabase login did not return a session id');
    }
    return response.id;
  }

  async getPermissionGroups(): Promise<Array<{ id: number; name: string }>> {
    return this.request<Array<{ id: number; name: string }>>('GET', '/api/permissions/group');
  }

  async createApiKey(params: { name: string; groupId: number }): Promise<string> {
    const response = await this.request<{ unmasked_key?: unknown }>('POST', '/api/api-key', {
      name: params.name,
      group_id: params.groupId,
    });
    if (typeof response.unmasked_key !== 'string' || response.unmasked_key.trim().length === 0) {
      throw new Error('Metabase did not return the newly created API key');
    }
    return response.unmasked_key;
  }

  async getDatabases(): Promise<MetabaseDatabase[]> {
    const response = await this.request<{ data: MetabaseDatabase[] }>('GET', '/api/database/');
    return response.data;
  }

  async getDatabase(id: number): Promise<MetabaseDatabase> {
    return this.request<MetabaseDatabase>('GET', `/api/database/${id}`);
  }

  async getCollectionTree(): Promise<MetabaseCollection[]> {
    return this.request<MetabaseCollection[]>('GET', '/api/collection/tree');
  }

  async getCollection(id: number | 'root'): Promise<MetabaseCollection> {
    return this.request<MetabaseCollection>('GET', `/api/collection/${id}`);
  }

  async getCollectionItems(
    collectionId: number | 'root',
    models: ('card' | 'dataset' | 'metric')[] = ['card', 'dataset', 'metric'],
  ): Promise<MetabaseCollectionItem[]> {
    const modelsParam = models.map((m) => `models=${m}`).join('&');
    const response = await this.request<{ data: MetabaseCollectionItem[] }>(
      'GET',
      `/api/collection/${collectionId}/items?${modelsParam}`,
    );
    return response.data;
  }

  async getCard(id: number): Promise<MetabaseCard> {
    return this.request<MetabaseCard>('GET', `/api/card/${id}`);
  }

  async getAllCards(): Promise<MetabaseCardSummary[]> {
    return this.request<MetabaseCardSummary[]>('GET', '/api/card/?f=all');
  }

  private getNativeQuerySnippets(): Promise<NativeQuerySnippet[]> {
    this.snippetCache ??= this.request<unknown>('GET', '/api/native-query-snippet').then(parseNativeQuerySnippets);
    return this.snippetCache;
  }

  private async inlineNativeQuerySnippets(
    sql: string,
    templateTags: MetabaseTemplateTag[],
    cardId: number,
  ): Promise<{ sql: string; unresolved: string[] }> {
    const names = collectRemainingSnippetNames(sql);
    if (names.size === 0) {
      return { sql, unresolved: [] };
    }

    let snippets: NativeQuerySnippet[];
    try {
      snippets = await this.getNativeQuerySnippets();
    } catch (error) {
      this.logger.warn(
        `[metabase] failed to load native query snippets for card ${cardId}; leaving snippet placeholders unresolved: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { sql, unresolved: [...names] };
    }

    const snippetsById = new Map<number, NativeQuerySnippet>();
    const snippetsByName = new Map<string, NativeQuerySnippet>();
    for (const snippet of snippets) {
      if (snippet.archived === true) {
        continue;
      }
      snippetsById.set(snippet.id, snippet);
      snippetsByName.set(normalizeSnippetName(snippet.name), snippet);
    }

    const snippetTags = templateTags.filter((tag) => tag.type === 'snippet');
    const unresolved = new Set<string>();
    const inlinedSql = sql.replace(/\{\{\s*snippet:\s*([^}]+?)\s*\}\}/gi, (match, rawName: string) => {
      const normalizedName = normalizeSnippetName(rawName);
      const tag = snippetTags.find(
        (candidate) =>
          normalizeSnippetName(candidate['snippet-name']) === normalizedName ||
          normalizeSnippetName(candidate.name) === normalizedName,
      );
      const snippet =
        (typeof tag?.['snippet-id'] === 'number' ? snippetsById.get(tag['snippet-id']) : undefined) ??
        snippetsByName.get(normalizedName);
      if (!snippet) {
        unresolved.add(rawName.trim());
        return match;
      }
      return snippet.content;
    });

    return { sql: inlinedSql, unresolved: [...unresolved] };
  }

  async convertMbqlToNative(datasetQuery: MetabaseDatasetQuery): Promise<MetabaseNativeQueryResult> {
    return this.request<MetabaseNativeQueryResult>('POST', '/api/dataset/native', {
      ...datasetQuery,
      pretty: true,
    });
  }

  getNativeSql(card: MetabaseCard): string | null {
    return card.dataset_query?.stages?.[0]?.native ?? card.dataset_query?.native?.query ?? null;
  }

  getTemplateTags(card: MetabaseCard): Record<string, MetabaseTemplateTag> {
    return card.dataset_query?.stages?.[0]?.['template-tags'] ?? card.dataset_query?.native?.['template-tags'] ?? {};
  }

  async getCardSql(card: MetabaseCard): Promise<string | null> {
    if (card.query_type === 'native') {
      const sql = this.getNativeSql(card);
      if (!sql) {
        this.logger.warn(`Card ${card.id}: no native SQL found in dataset_query`);
      }
      return sql;
    }

    try {
      if (!card.dataset_query) {
        this.logger.warn(`Card ${card.id}: no dataset_query found for MBQL conversion`);
        return null;
      }
      const result = await this.convertMbqlToNative(card.dataset_query);
      return result.query;
    } catch (error) {
      this.logger.warn(`Failed to convert MBQL for card ${card.id}: ${error}`);
      return null;
    }
  }

  async getResolvedSql(card: MetabaseCard): Promise<ResolvedSqlResult | null> {
    const rawTemplateTags = this.getTemplateTags(card);
    const templateTagEntries = Object.values(rawTemplateTags);

    // For MBQL queries or native queries without template tags, use simple conversion
    if (card.query_type !== 'native' || templateTagEntries.length === 0) {
      const sql = await this.getCardSql(card);
      return sql ? { resolvedSql: sql, templateTags: [], resolutionStatus: 'resolved' } : null;
    }

    const nativeQuery = this.getNativeSql(card);
    if (!nativeQuery) {
      return null;
    }

    const templateTags: TemplateTagInfo[] = templateTagEntries.map((tag) => ({
      name: tag.name,
      type: tag.type,
      displayName: tag['display-name'] ?? tag.name,
      dummyValue: tag.type === 'snippet' ? null : this.formatDummyValueForDisplay(tag),
    }));

    // Step 1: drop optional [[ ... {{ var }} ... ]] blocks. Semantic-layer sources
    // have no parameters; chat-time SL filters compose narrowing WHERE clauses
    // dynamically, so any clause the original card author flagged as optional must
    // not bake into the persistent SL source SQL (substituting a dummy value would
    // silently filter rows out — see incident with auction_seller_bidder_pair_suspicion).
    let processedSql = stripOptionalClauses(nativeQuery);

    // Step 2: inline native-query snippets. Metabase's substitution endpoint does not
    // always expand {{snippet: name}} for fetched card SQL, but the snippets API does.
    const snippetResult = await this.inlineNativeQuerySnippets(processedSql, templateTagEntries, card.id);
    processedSql = snippetResult.sql;
    if (snippetResult.unresolved.length > 0) {
      this.logger.warn(
        `[metabase] card ${card.id} has unresolved SQL snippets: ${snippetResult.unresolved.join(', ')}`,
      );
      return { resolvedSql: processedSql, templateTags, resolutionStatus: 'fallback' };
    }

    // Step 3: inline {{#CARD_ID}} card references locally. Recursively strip optional
    // clauses in referenced cards too — the same reasoning applies all the way down.
    try {
      processedSql = await expandCardReferences(processedSql, {
        fetchCard: async (id) => {
          const referenced = await this.getCard(id as number);
          const referencedNative = this.getNativeSql(referenced);
          if (!referencedNative) {
            throw new Error(`referenced card ${id} has no native query`);
          }
          const referencedSnippetResult = await this.inlineNativeQuerySnippets(
            stripOptionalClauses(referencedNative),
            Object.values(this.getTemplateTags(referenced)),
            referenced.id,
          );
          if (referencedSnippetResult.unresolved.length > 0) {
            throw new Error(
              `referenced card ${id} has unresolved SQL snippets: ${referencedSnippetResult.unresolved.join(', ')}`,
            );
          }
          return { native_query: referencedSnippetResult.sql };
        },
      });
    } catch (err) {
      if (err instanceof CardReferenceCycleError) {
        this.logger.warn(`[metabase] card ${card.id} has a reference cycle; cannot resolve SQL: ${err.message}`);
        return null;
      }
      throw err;
    }

    // Step 4: collect template tags that still appear in the SQL after strip + inline.
    // Anything bracketed-only is gone now; anything card-referenced is inlined.
    const remainingNames = collectRemainingPlaceholderNames(processedSql);
    const remainingTags = templateTagEntries.filter((tag) => tag.type !== 'snippet' && remainingNames.has(tag.name));

    if (remainingTags.length === 0) {
      return { resolvedSql: processedSql, templateTags, resolutionStatus: 'resolved' };
    }

    // Step 5: dummy-substitute the remaining naked {{ var }} placeholders via Metabase's
    // substitution endpoint. Only required because we can't translate dimension-tag
    // bindings to warehouse columns ourselves. Prepend a SQL comment listing every
    // dummy substitution so downstream consumers (the metabase_ingest LLM) know which
    // values are placeholders and not real filters.
    if (!card.dataset_query) {
      return null;
    }
    const datasetQuery = injectNativeSql(card.dataset_query, processedSql);
    const parameters = remainingTags.map((tag) => ({
      id: tag.id,
      type: this.getParamTypeForTag(tag),
      value: this.getDummyValueForTag(tag),
      target:
        tag.type === 'dimension' ? ['dimension', ['template-tag', tag.name]] : ['variable', ['template-tag', tag.name]],
    }));

    try {
      // Don't retry 500 errors for SQL resolution - they're deterministic failures
      // (invalid dimension filters, bad field references, etc.)
      // Still retry 429 (rate limit) and 502/503/504 (gateway errors)
      const response = await this.requestWithCustomRetry<MetabaseNativeQueryResult>(
        'POST',
        '/api/dataset/native',
        { ...datasetQuery, parameters, pretty: true },
        [429, 502, 503, 504],
      );

      const warning = this.buildPlaceholderWarningComment(remainingTags);
      return {
        resolvedSql: warning + response.query,
        templateTags,
        resolutionStatus: 'resolved',
      };
    } catch (error) {
      this.logger.warn(
        `[metabase] SQL resolution failed for card ${card.id} after expansion; falling back to unresolved native SQL. Downstream consumers will see resolutionStatus='fallback'. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { resolvedSql: nativeQuery, templateTags, resolutionStatus: 'fallback' };
    }
  }

  private buildPlaceholderWarningComment(tags: MetabaseTemplateTag[]): string {
    const lines = [
      '-- KTX_PLACEHOLDER_WARNING: this SQL was extracted from a Metabase card with',
      '-- unbound template parameters. The placeholders below were substituted with DUMMY',
      "-- values to satisfy Metabase's parser — they DO NOT represent intended filters.",
      '-- Drop the corresponding clauses (or expose them as runtime SL filters) before',
      '-- persisting this SQL as a semantic-layer source.',
    ];
    for (const tag of tags) {
      const widget = tag.type === 'dimension' ? `, widget=${tag['widget-type'] ?? '?'}` : '';
      const dummy = this.formatDummyValueForDisplay(tag);
      lines.push(`--   {{ ${tag.name} }} (type=${tag.type}${widget}) → ${dummy}`);
    }
    return `${lines.join('\n')}\n`;
  }

  private getParamTypeForTag(tag: MetabaseTemplateTag): string {
    if (tag.type === 'dimension') {
      return tag['widget-type'] ?? 'string/=';
    }
    if (tag.type === 'number') {
      return 'number/=';
    }
    if (tag.type === 'date') {
      return 'date/single';
    }
    return 'string/=';
  }

  private getDummyValueForTag(tag: MetabaseTemplateTag): string | string[] {
    if (tag.type === 'number') {
      return '1';
    }
    if (tag.type === 'date') {
      return '2020-01-01';
    }
    if (tag.type === 'dimension') {
      return getDummyValueForWidgetType(tag['widget-type']);
    }
    return 'placeholder';
  }

  private formatDummyValueForDisplay(tag: MetabaseTemplateTag): string {
    const value = this.getDummyValueForTag(tag);
    if (Array.isArray(value)) {
      return value.map((v) => `'${v}'`).join(', ');
    }
    if (tag.type === 'number') {
      return value;
    }
    return `'${value}'`;
  }

  async createCard(params: CreateCardParams): Promise<MetabaseCard> {
    const body = {
      name: params.name,
      display: params.display ?? 'table',
      visualization_settings: {},
      dataset_query: {
        type: 'native',
        native: {
          query: params.sql,
        },
        database: params.databaseId,
      },
      collection_id: params.collectionId ?? null,
      description: params.description,
    };

    return this.request<MetabaseCard>('POST', '/api/card', body);
  }

  async deleteCard(id: number): Promise<void> {
    await this.request<void>('DELETE', `/api/card/${id}`);
  }

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return this.requestWithRetry<T>(method, path, body);
  }

  /**
   * Make a request with custom retryable status codes.
   * Useful for endpoints where certain errors are deterministic and shouldn't be retried.
   */
  private async requestWithCustomRetry<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    retryableStatuses: number[],
  ): Promise<T> {
    return this.requestWithRetry<T>(method, path, body, retryableStatuses);
  }

  private async requestWithRetry<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    retryableStatusesOverride?: number[],
  ): Promise<T> {
    const retryableStatuses = retryableStatusesOverride ?? this.config.retryableStatuses;
    let lastError: Error | null = null;
    let attempts = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      attempts = attempt + 1;
      try {
        return await this.executeRequest<T>(method, path, body);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryableError(lastError, retryableStatuses)) {
          throw lastError;
        }

        if (attempt >= this.config.maxRetries) {
          break;
        }

        const delay = this.calculateDelay(attempt);
        this.logger.warn(
          `Metabase request failed (attempt ${attempt + 1}/${this.config.maxRetries + 1}), ` +
            `retrying in ${delay}ms: ${method} ${path}`,
        );
        await this.sleep(delay);
      }
    }

    throw this.wrapExhaustedError(lastError as Error, method, path, attempts);
  }

  private wrapExhaustedError(
    cause: Error,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    attempts: number,
  ): Error {
    // Only mention the attempt count when retries actually happened — "1 attempt" adds no info.
    const retryNote = attempts > 1 ? ` (${attempts} attempts)` : '';
    const wrapped = new Error(`Metabase request failed${retryNote}: ${method} ${path} — ${cause.message}`, {
      cause,
    });
    const causeCode = (cause as NodeJS.ErrnoException).code;
    if (causeCode) {
      (wrapped as NodeJS.ErrnoException).code = causeCode;
    }
    wrapped.name =
      cause.name === 'Error' ? 'MetabaseRetryExhaustedError' : `MetabaseRetryExhaustedError(${cause.name})`;
    return wrapped;
  }

  /**
   * Calculate delay with exponential backoff and jitter.
   * Uses "full jitter" algorithm recommended by AWS:
   * https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * 2 ** attempt;
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);

    if (!this.config.jitter) {
      return cappedDelay;
    }

    // Full jitter: random between baseDelay and cappedDelay
    const jitterRange = cappedDelay - this.config.baseDelayMs;
    return Math.floor(Math.random() * jitterRange) + this.config.baseDelayMs;
  }

  private async executeRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.runtime.apiKey) {
      headers[this.runtime.authHeaderName ?? 'x-api-key'] = this.runtime.apiKey;
    }

    const url = `${this.baseUrl}${path}`;
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : isHttps ? 443 : 80;

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const isRetryable = this.isRetryableStatus(response.status);

        // Log full error details at debug level for diagnostics
        this.logger.debug?.(
          `Metabase API error: ${method} ${path} -> ${response.status}, body: ${errorBody.slice(0, 500)}`,
        );

        throw new MetabaseApiError(
          this.getErrorMessage(response.status, errorBody),
          response.status,
          errorBody,
          isRetryable,
        );
      }

      return response.json() as Promise<T>;
    } catch (error) {
      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new Error(`Request timeout after ${this.config.timeoutMs}ms: ${method} ${path}`);
        (timeoutError as NodeJS.ErrnoException).code = 'ETIMEDOUT';
        throw timeoutError;
      }
      // Undici (Node fetch) emits a stable message when the socket is closed mid-TLS handshake.
      // Fetch hides socket events, so this narrow message check is the only signal we have.
      if (isHttps && error instanceof Error && error.message.includes('before secure TLS connection was established')) {
        throw this.classifyHttpError(error, {
          tcpConnected: true,
          tlsCompleted: false,
          isHttps: true,
          host: parsedUrl.hostname,
          port,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Wrap a network error with a phase-aware message so users see "TLS handshake didn't complete"
   * instead of "read ECONNRESET". Preserves the original error via cause + code so retry
   * detection (isRetryableError) and other code-based branching keep working.
   */
  private classifyHttpError(
    cause: Error,
    phase: {
      tcpConnected: boolean;
      tlsCompleted: boolean;
      isHttps: boolean;
      host: string;
      port: number | string;
    },
  ): Error {
    if (!phase.tcpConnected) {
      return this.wrapWithCause(
        cause,
        `Cannot reach ${phase.host}:${phase.port}: ${cause.message}`,
        'MetabaseTcpConnectError',
      );
    }
    if (phase.isHttps && !phase.tlsCompleted) {
      return this.wrapWithCause(
        cause,
        `TLS handshake to ${phase.host} did not complete — the upstream server may be down or unresponsive: ${cause.message}`,
        'MetabaseTlsHandshakeError',
      );
    }
    return cause;
  }

  private wrapWithCause(cause: Error, message: string, name: string): Error {
    const wrapped = new Error(message, { cause });
    wrapped.name = name;
    const causeCode = (cause as NodeJS.ErrnoException).code;
    if (causeCode) {
      (wrapped as NodeJS.ErrnoException).code = causeCode;
    }
    return wrapped;
  }

  private isRetryableStatus(status: number): boolean {
    return this.config.retryableStatuses.includes(status);
  }

  private getErrorMessage(status: number, body: string): string {
    switch (status) {
      case 401:
        return 'API key is invalid or expired. Please update your Metabase connection settings.';
      case 403:
        return 'Access denied. The API key does not have permission to perform this action.';
      case 404:
        return 'Resource not found. The requested item may have been deleted.';
      case 429:
        return 'Rate limited by Metabase. Please try again later.';
      default:
        if (status >= 500) {
          return `Metabase server error (${status}). Please try again later.`;
        }
        return `Metabase API error (${status}): ${body || 'Unknown error'}`;
    }
  }

  private isRetryableError(error: Error, retryableStatuses: number[]): boolean {
    // Custom MetabaseApiError - check status against provided list
    if (error instanceof MetabaseApiError) {
      return retryableStatuses.includes(error.status);
    }

    const code = (error as NodeJS.ErrnoException).code;

    // Timeout errors are retryable
    if (code === 'ETIMEDOUT' || code === 'TIMEOUT') {
      return true;
    }

    // Check HTTP status codes
    if (code?.startsWith('HTTP_')) {
      const status = parseInt(code.replace('HTTP_', ''), 10);
      return retryableStatuses.includes(status);
    }

    // Network errors are retryable
    const message = error.message.toLowerCase();
    return (
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('econnrefused') ||
      message.includes('socket hang up') ||
      message.includes('network') ||
      message.includes('abort')
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class DefaultMetabaseConnectionClientFactory implements MetabaseConnectionClientFactory {
  constructor(
    private readonly resolveCredentials: (
      metabaseConnectionId: string,
    ) => Promise<MetabaseClientRuntimeConfig> | MetabaseClientRuntimeConfig,
    private readonly defaultClientConfig: MetabaseClientConfig = DEFAULT_METABASE_CLIENT_CONFIG,
    private readonly logger: MetabaseClientLogger = defaultLogger,
  ) {}

  async createClient(
    metabaseConnectionId: string,
    overrides?: Partial<MetabaseClientConfig>,
  ): Promise<MetabaseRuntimeClient> {
    const runtime = await this.resolveCredentials(metabaseConnectionId);
    const mergedConfig = { ...this.defaultClientConfig, ...(overrides ?? {}) };
    return new MetabaseClient(runtime, mergedConfig, this.logger);
  }
}
