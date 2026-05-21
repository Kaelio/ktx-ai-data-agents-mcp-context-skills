import { Client } from '@notionhq/client';
import { NOTION_API_VERSION, type NotionBlock } from './types.js';

interface NotionSearchResult {
  id: string;
  object: 'page' | 'data_source' | string;
  [key: string]: unknown;
}

export interface NotionDatabaseContainer {
  id: string;
  title?: unknown[];
  data_sources?: Array<{ id: string; name?: string }>;
  [key: string]: unknown;
}

export interface NotionBotInfo {
  id?: string;
  name?: string | null;
  bot?: {
    workspace_name?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NotionApi {
  search(
    filterValue: 'page' | 'data_source',
    startCursor?: string | null,
    pageSize?: number,
  ): Promise<{
    results: NotionSearchResult[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
  retrieveBotUser(): Promise<NotionBotInfo>;
  retrievePage(pageId: string): Promise<Record<string, unknown>>;
  retrieveDatabase(databaseId: string): Promise<NotionDatabaseContainer>;
  queryDataSource(
    dataSourceId: string,
    startCursor?: string | null,
    pageSize?: number,
  ): Promise<{
    results: Record<string, unknown>[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
  listBlockChildren(
    blockId: string,
    startCursor?: string | null,
    pageSize?: number,
  ): Promise<{
    results: NotionBlock[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
}

interface RetryOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  authToken?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const transientStatusCodes = new Set([500, 502, 503]);
const transientErrorCodes = new Set(['internal_server_error', 'service_unavailable', 'gateway_timeout']);
const MAX_RETRY_SLEEP_MS = 60_000;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const status =
    (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

function shouldRetryNotionError(error: unknown): boolean {
  const code = errorCode(error);
  const status = errorStatus(error);
  return code === 'rate_limited' || transientErrorCodes.has(code ?? '') || transientStatusCodes.has(status ?? 0);
}

export async function retryNotionRequest<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!shouldRetryNotionError(error) || attempt === maxAttempts) {
        break;
      }
      const headers = typeof error === 'object' && error !== null ? (error as { headers?: unknown }).headers : null;
      const retryAfter =
        headers && typeof headers === 'object'
          ? Number(
              (headers as Record<string, unknown>)['retry-after'] ??
                (headers as Record<string, unknown>)['Retry-After'],
            )
          : NaN;
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
      const fallbackBackoffMs = 1000 * 2 ** (attempt - 1);
      await sleep(Math.min(retryAfterMs ?? fallbackBackoffMs, MAX_RETRY_SLEEP_MS));
    }
  }

  const raw =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === 'object' &&
          lastError !== null &&
          typeof (lastError as { message?: unknown }).message === 'string'
        ? (lastError as { message: string }).message
        : String(lastError);
  const sanitized = options.authToken ? raw.split(options.authToken).join('***') : raw;
  throw new Error(sanitized);
}

export class NotionClient implements NotionApi {
  private readonly client: Client;

  constructor(private readonly authToken: string) {
    this.client = new Client({
      auth: authToken,
      notionVersion: NOTION_API_VERSION,
    });
  }

  async search(filterValue: 'page' | 'data_source', startCursor?: string | null, pageSize = 100) {
    const response = await retryNotionRequest(
      () =>
        this.client.search({
          filter: { property: 'object', value: filterValue },
          start_cursor: startCursor ?? undefined,
          page_size: pageSize,
        }) as Promise<{ results: NotionSearchResult[]; has_more: boolean; next_cursor: string | null }>,
      { authToken: this.authToken },
    );
    return { results: response.results, hasMore: response.has_more, nextCursor: response.next_cursor };
  }

  async retrieveBotUser(): Promise<NotionBotInfo> {
    return retryNotionRequest(() => this.client.users.me({}) as Promise<NotionBotInfo>, {
      authToken: this.authToken,
    });
  }

  async retrievePage(pageId: string): Promise<Record<string, unknown>> {
    return retryNotionRequest(
      () => this.client.pages.retrieve({ page_id: pageId }) as Promise<Record<string, unknown>>,
      {
        authToken: this.authToken,
      },
    );
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabaseContainer> {
    return retryNotionRequest(
      () =>
        this.client.request({
          method: 'get',
          path: `databases/${databaseId}`,
        }) as Promise<NotionDatabaseContainer>,
      { authToken: this.authToken },
    );
  }

  async queryDataSource(dataSourceId: string, startCursor?: string | null, pageSize = 100) {
    const response = await retryNotionRequest(
      () =>
        this.client.request({
          method: 'post',
          path: `data_sources/${dataSourceId}/query`,
          body: { start_cursor: startCursor ?? undefined, page_size: pageSize },
        }) as Promise<{ results: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null }>,
      { authToken: this.authToken },
    );
    return { results: response.results, hasMore: response.has_more, nextCursor: response.next_cursor };
  }

  async listBlockChildren(blockId: string, startCursor?: string | null, pageSize = 100) {
    const response = await retryNotionRequest(
      () =>
        this.client.blocks.children.list({
          block_id: blockId,
          start_cursor: startCursor ?? undefined,
          page_size: pageSize,
        }) as Promise<{ results: NotionBlock[]; has_more: boolean; next_cursor: string | null }>,
      { authToken: this.authToken },
    );
    return { results: response.results, hasMore: response.has_more, nextCursor: response.next_cursor };
  }
}
