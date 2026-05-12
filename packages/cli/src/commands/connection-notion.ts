import { parseNotionConnectionConfig, resolveNotionConnectionAuthToken } from '@ktx/context/connections';
import { type NotionApi, type NotionBotInfo, NotionClient } from '@ktx/context/ingest';
import {
  type KtxLocalProject,
  type KtxProjectConnectionConfig,
  loadKtxProject,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import type { KtxCliIo } from '../index.js';
import { profileMark } from '../startup-profile.js';
import { buildInitialState, buildPickerTree, type NotionPickerPageInput } from './connection-notion-tree.js';
import {
  type NotionPickerTuiIo,
  type PickerRenderInput,
  type PickerRenderResult,
  renderNotionPickerTui,
} from './connection-notion-tui.js';

profileMark('module:commands/connection-notion');

export type KtxConnectionNotionArgs =
  | {
      command: 'pick';
      projectDir: string;
      connectionId: string;
      mode: 'interactive';
    }
  | {
      command: 'pick';
      projectDir: string;
      connectionId: string;
      mode: 'non-interactive';
      rootPageIds: string[];
    };

export type NotionPickerApi = Pick<NotionApi, 'search' | 'retrieveBotUser'>;
export type { PickerRenderInput, PickerRenderResult };

interface KtxConnectionNotionDeps {
  env?: Record<string, string | undefined>;
  loadProject?: typeof loadKtxProject;
  createNotionApi?: (authToken: string) => NotionPickerApi;
  renderPicker?: (input: PickerRenderInput, io: NotionPickerTuiIo) => Promise<PickerRenderResult>;
}

const NOTION_PICKER_PAGE_CAP = 5000;

function assertSafeConnectionId(connectionId: string): void {
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

function notionConnection(project: KtxLocalProject, connectionId: string): KtxProjectConnectionConfig {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" not found`);
  }
  if (connection.driver !== 'notion') {
    throw new Error(`Connection "${connectionId}" is not a Notion connection`);
  }
  return connection;
}

export async function applyNotionPickerWriteback(
  project: KtxLocalProject,
  connectionId: string,
  rootPageIds: string[],
): Promise<void> {
  if (rootPageIds.length === 0) {
    throw new Error('connection notion pick requires at least one root page id');
  }

  const existing = notionConnection(project, connectionId);
  const nextConfig = {
    ...project.config,
    connections: {
      ...project.config.connections,
      [connectionId]: {
        ...existing,
        crawl_mode: 'selected_roots',
        root_page_ids: rootPageIds,
      },
    },
  };

  await project.fileStore.writeFile(
    'ktx.yaml',
    serializeKtxProjectConfig(nextConfig),
    'ktx',
    'ktx@example.com',
    `Pick Notion roots: ${connectionId} (${rootPageIds.length} pages)`,
  );
}

export async function runKtxConnectionNotion(
  args: KtxConnectionNotionArgs,
  io: KtxCliIo = process,
  deps: KtxConnectionNotionDeps = {},
): Promise<number> {
  try {
    assertSafeConnectionId(args.connectionId);
    const loadProject = deps.loadProject ?? loadKtxProject;

    if (args.mode === 'interactive') {
      const project = await loadProject({ projectDir: args.projectDir });
      const rawConnection = notionConnection(project, args.connectionId);
      const notion = parseNotionConnectionConfig(rawConnection);
      const authToken = await resolveNotionConnectionAuthToken(notion, { env: deps.env });
      const api = deps.createNotionApi ? deps.createNotionApi(authToken) : new NotionClient(authToken);
      const discovery = await discoverNotionPickerPages(api);
      const tree = buildPickerTree(discovery.pages);
      const initialState = buildInitialState({
        tree,
        existingRootPageIds: notion.root_page_ids,
        currentCrawlMode: notion.crawl_mode,
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
          currentCrawlMode: notion.crawl_mode,
        },
        io as NotionPickerTuiIo,
      );
      if (result.kind === 'quit') {
        io.stdout.write('No changes saved.\n');
        return 0;
      }
      await applyNotionPickerWriteback(project, args.connectionId, result.rootPageIds);
      io.stdout.write(`Connection: ${args.connectionId}\n`);
      io.stdout.write(`rootPageIds: ${result.rootPageIds.length}\n`);
      io.stdout.write('crawlMode: selected_roots\n');
      return 0;
    }

    const project = await loadProject({ projectDir: args.projectDir });
    await applyNotionPickerWriteback(project, args.connectionId, args.rootPageIds);
    io.stdout.write(`Connection: ${args.connectionId}\n`);
    io.stdout.write(`rootPageIds: ${args.rootPageIds.length}\n`);
    io.stdout.write('crawlMode: selected_roots\n');
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
