import { resolveNotionConnectionAuthToken } from '@ktx/context/connections';
import { type NotionApi, type NotionBotInfo, NotionClient } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import { profileMark } from './startup-profile.js';
import { buildInitialState, buildPickerTree, type NotionPickerPageInput } from './notion-page-picker-tree.js';
import {
  type NotionPickerTuiIo,
  type PickerRenderInput,
  type PickerRenderResult,
  renderNotionPickerTui,
} from './notion-page-picker-tui.js';

profileMark('module:notion-page-picker');

export interface PickNotionRootPagesArgs {
  connectionId: string;
  connection: KtxProjectConnectionConfig;
}

export type NotionPickerApi = Pick<NotionApi, 'search' | 'retrieveBotUser'>;
export type { PickerRenderInput, PickerRenderResult };

export type NotionRootPagePickResult =
  | { kind: 'selected'; rootPageIds: string[] }
  | { kind: 'back' }
  | { kind: 'unavailable'; message: string };

export interface NotionRootPagePickerDeps {
  env?: Record<string, string | undefined>;
  createNotionApi?: (authToken: string) => NotionPickerApi;
  renderPicker?: (input: PickerRenderInput, io: NotionPickerTuiIo) => Promise<PickerRenderResult>;
}

const NOTION_PICKER_PAGE_CAP = 5000;

function assertSafeNotionPickerConnectionId(connectionId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
}

export function normalizeNotionPageId(value: string): string {
  const trimmed = value.trim();
  const compact = trimmed.includes('-') ? trimmed.replace(/-/g, '') : trimmed;
  if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
    throw new Error(`Invalid Notion page UUID: ${value}`);
  }
  const lower = compact.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractTitleFromNotionPage(page: Record<string, unknown>): string {
  const properties = recordValue(page.properties);
  if (!properties) {
    return 'Untitled';
  }
  for (const property of Object.values(properties)) {
    const value = recordValue(property);
    if (!value || value.type !== 'title' || !Array.isArray(value.title)) {
      continue;
    }
    const text = value.title
      .map((part) => {
        const richText = recordValue(part);
        return typeof richText?.plain_text === 'string' ? richText.plain_text : '';
      })
      .join('')
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  return 'Untitled';
}

function extractParentPageId(page: Record<string, unknown>): string | null {
  const parent = recordValue(page.parent);
  if (!parent || parent.type !== 'page_id' || typeof parent.page_id !== 'string') {
    return null;
  }
  return normalizeNotionPageId(parent.page_id);
}

export function notionPickerPageFromSearchResult(result: Record<string, unknown>): NotionPickerPageInput {
  const id = typeof result.id === 'string' ? normalizeNotionPageId(result.id) : '';
  if (!id) {
    throw new Error('Notion page search result is missing id');
  }
  return {
    id,
    title: extractTitleFromNotionPage(result),
    archived: result.archived === true,
    parentId: extractParentPageId(result),
  };
}

export async function discoverNotionPickerPages(
  api: NotionPickerApi,
  options: { cap?: number } = {},
): Promise<{ pages: NotionPickerPageInput[]; cappedAtCount: number | null; warnings: string[] }> {
  const cap = options.cap ?? NOTION_PICKER_PAGE_CAP;
  const pages: NotionPickerPageInput[] = [];
  const warnings: string[] = [];
  let cursor: string | null | undefined = null;

  while (pages.length < cap) {
    let response: Awaited<ReturnType<NotionPickerApi['search']>>;
    try {
      response = await api.search('page', cursor, Math.min(100, cap - pages.length));
    } catch (error) {
      if (pages.length === 0) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Notion search stopped early: ${message}`);
      return { pages, cappedAtCount: null, warnings };
    }

    for (const result of response.results) {
      pages.push(notionPickerPageFromSearchResult(result));
      if (pages.length >= cap) {
        break;
      }
    }

    if (!response.hasMore || !response.nextCursor || pages.length >= cap) {
      return {
        pages,
        cappedAtCount: response.hasMore ? cap : null,
        warnings,
      };
    }
    cursor = response.nextCursor;
  }

  return { pages, cappedAtCount: cap, warnings };
}

export async function resolveNotionWorkspaceLabel(api: NotionPickerApi, connectionId: string): Promise<string> {
  try {
    const bot = (await api.retrieveBotUser()) as NotionBotInfo;
    const workspaceName = typeof bot.bot?.workspace_name === 'string' ? bot.bot.workspace_name.trim() : '';
    if (workspaceName.length > 0) {
      return workspaceName;
    }
    const name = typeof bot.name === 'string' ? bot.name.trim() : '';
    return name.length > 0 ? name : connectionId;
  } catch {
    return connectionId;
  }
}

function assertNotionConnection(connection: KtxProjectConnectionConfig, connectionId: string): void {
  if (connection.driver !== 'notion') {
    throw new Error(`Connection "${connectionId}" is not a Notion connection`);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function notionCrawlMode(connection: KtxProjectConnectionConfig): 'all_accessible' | 'selected_roots' {
  return connection.crawl_mode === 'all_accessible' ? 'all_accessible' : 'selected_roots';
}

export async function pickNotionRootPages(
  args: PickNotionRootPagesArgs,
  io: KtxCliIo = process,
  deps: NotionRootPagePickerDeps = {},
): Promise<NotionRootPagePickResult> {
  try {
    assertSafeNotionPickerConnectionId(args.connectionId);
    assertNotionConnection(args.connection, args.connectionId);
    const crawlMode = notionCrawlMode(args.connection);
    const authToken = await resolveNotionConnectionAuthToken(
      {
        auth_token: typeof args.connection.auth_token === 'string' ? args.connection.auth_token : null,
        auth_token_ref: typeof args.connection.auth_token_ref === 'string' ? args.connection.auth_token_ref : null,
      },
      { env: deps.env },
    );
    const api = deps.createNotionApi ? deps.createNotionApi(authToken) : new NotionClient(authToken);
    const discovery = await discoverNotionPickerPages(api);
    const tree = buildPickerTree(discovery.pages);
    const initialState = buildInitialState({
      tree,
      existingRootPageIds: stringArray(args.connection.root_page_ids),
      currentCrawlMode: crawlMode,
    });
    const preLoadWarnings = [...discovery.warnings, ...initialState.preLoadWarnings];
    const renderState =
      preLoadWarnings.length > 0
        ? {
            ...initialState,
            preLoadWarnings,
          }
        : initialState;
    for (const warning of preLoadWarnings) {
      io.stderr.write(`${warning}\n`);
    }
    const workspaceLabel = await resolveNotionWorkspaceLabel(api, args.connectionId);
    const result = await (deps.renderPicker ?? renderNotionPickerTui)(
      {
        initialState: renderState,
        connectionId: args.connectionId,
        workspaceLabel,
        cappedAtCount: discovery.cappedAtCount,
        currentCrawlMode: crawlMode,
      },
      io as NotionPickerTuiIo,
    );
    if (result.kind === 'quit') {
      return { kind: 'back' };
    }
    if (result.rootPageIds.length === 0) {
      return { kind: 'unavailable', message: 'Notion picker did not return any selected pages.' };
    }
    return { kind: 'selected', rootPageIds: result.rootPageIds };
  } catch (error) {
    return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}
