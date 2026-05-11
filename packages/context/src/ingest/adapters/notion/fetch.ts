import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeNotionBlocksToMarkdown, normalizeNotionPageMetadata } from './normalize.js';
import type { NotionApi, NotionDatabaseContainer } from './notion-client.js';
import {
  NOTION_API_VERSION,
  NOTION_SOURCE_KEY,
  notionCrawlCursorSchema,
  type NotionBlock,
  type NotionCrawlCursor,
  type NotionManifest,
  type NotionPullConfig,
} from './types.js';

export interface NotionFetchLogger {
  warn(message: string): void;
}

const noopNotionFetchLogger: NotionFetchLogger = {
  warn: () => undefined,
};

interface FetchNotionSnapshotParams {
  client: NotionApi;
  config: NotionPullConfig;
  stagedDir: string;
  logger?: NotionFetchLogger;
}

interface CrawlState {
  pageCount: number;
  databaseCount: number;
  dataSourceCount: number;
  capped: boolean;
  skipped: Array<{ externalId: string; reason: string }>;
  warnings: string[];
  materializedPageTargets: Set<string>;
  nextSuccessfulCursor: string | null;
  pageTargets: Map<string, { pageId: string; dir: string; links: NotionLinks }>;
}

interface BlockCollectionState {
  blocks: NotionBlock[];
  blockCountWarningWritten: boolean;
}

interface NotionLinks {
  children: string[];
  reverseLinks: string[];
  mentions: string[];
  databases: string[];
}

const DEFAULT_MAX_BLOCK_DEPTH = 10;
const DEFAULT_MAX_BLOCKS_PER_PAGE = 2000;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith('\n') ? value : `${value}\n`, 'utf-8');
}

function addWarning(
  warnings: string[],
  warning: string,
  options: { logWarning?: boolean; logger?: NotionFetchLogger } = {},
): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
    if (options.logWarning) {
      options.logger?.warn(warning);
    }
  }
}

function remainingPageBudget(state: CrawlState, config: NotionPullConfig): number {
  return Math.max(config.maxPagesPerRun - state.pageCount, 0);
}

function hasPageBudget(state: CrawlState, config: NotionPullConfig): boolean {
  return remainingPageBudget(state, config) > 0;
}

function markCapped(state: CrawlState, config: NotionPullConfig, cursor?: NotionCrawlCursor): void {
  state.capped = true;
  addWarning(state.warnings, `maxPagesPerRun reached at ${config.maxPagesPerRun}`);
  state.nextSuccessfulCursor = cursor ? JSON.stringify(cursor) : null;
}

function parseConfiguredCursor(config: NotionPullConfig): NotionCrawlCursor {
  if (!config.lastSuccessfulCursor) {
    return null;
  }
  try {
    return notionCrawlCursorSchema.parse(JSON.parse(config.lastSuccessfulCursor));
  } catch {
    return null;
  }
}

async function visitPaginated<T>(params: {
  load: (
    cursor: string | null,
    pageSize: number,
  ) => Promise<{ results: T[]; hasMore: boolean; nextCursor: string | null }>;
  startCursor?: string | null;
  pageSize: () => number;
  shouldContinue: () => boolean;
  visit: (item: T, nextCursor: string | null) => Promise<void>;
}): Promise<void> {
  let cursor = params.startCursor ?? null;
  do {
    if (!params.shouldContinue()) {
      return;
    }
    const page = await params.load(cursor, Math.max(1, Math.min(params.pageSize(), 100)));
    const nextCursor = page.hasMore ? page.nextCursor : null;
    for (const item of page.results) {
      if (!params.shouldContinue()) {
        return;
      }
      await params.visit(item, nextCursor);
    }
    cursor = nextCursor;
  } while (cursor);
}

function addBlockCountWarning(
  state: BlockCollectionState,
  warnings: string[],
  pageId: string,
  logger: NotionFetchLogger,
): void {
  if (state.blockCountWarningWritten) {
    return;
  }
  addWarning(warnings, `maxBlocksPerPage reached for page ${pageId} at ${DEFAULT_MAX_BLOCKS_PER_PAGE} blocks`, {
    logWarning: true,
    logger,
  });
  state.blockCountWarningWritten = true;
}

async function collectBlockChildren(params: {
  client: NotionApi;
  blockId: string;
  pageId: string;
  depth: number;
  warnings: string[];
  state: BlockCollectionState;
  logger: NotionFetchLogger;
}): Promise<void> {
  let cursor: string | null = null;
  do {
    const remainingBlocks = DEFAULT_MAX_BLOCKS_PER_PAGE - params.state.blocks.length;
    if (remainingBlocks <= 0) {
      addBlockCountWarning(params.state, params.warnings, params.pageId, params.logger);
      return;
    }
    const page = await params.client.listBlockChildren(params.blockId, cursor, Math.min(remainingBlocks, 100));
    for (let index = 0; index < page.results.length; index += 1) {
      if (params.state.blocks.length >= DEFAULT_MAX_BLOCKS_PER_PAGE) {
        addBlockCountWarning(params.state, params.warnings, params.pageId, params.logger);
        return;
      }

      const block = page.results[index];
      const blockDepth = params.depth + 1;
      params.state.blocks.push(block);

      if (block.has_children) {
        if (blockDepth >= DEFAULT_MAX_BLOCK_DEPTH) {
          addWarning(
            params.warnings,
            `maxBlockDepth reached for page ${params.pageId} at depth ${DEFAULT_MAX_BLOCK_DEPTH}`,
            { logWarning: true, logger: params.logger },
          );
        } else if (params.state.blocks.length >= DEFAULT_MAX_BLOCKS_PER_PAGE) {
          addBlockCountWarning(params.state, params.warnings, params.pageId, params.logger);
          return;
        } else {
          await collectBlockChildren({
            client: params.client,
            blockId: block.id,
            pageId: params.pageId,
            depth: blockDepth,
            warnings: params.warnings,
            state: params.state,
            logger: params.logger,
          });
        }
      }

      if (
        params.state.blocks.length >= DEFAULT_MAX_BLOCKS_PER_PAGE &&
        (index < page.results.length - 1 || page.hasMore)
      ) {
        addBlockCountWarning(params.state, params.warnings, params.pageId, params.logger);
        return;
      }
    }
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
}

async function collectBlockTree(
  client: NotionApi,
  pageId: string,
  warnings: string[],
  logger: NotionFetchLogger,
): Promise<NotionBlock[]> {
  const state: BlockCollectionState = { blocks: [], blockCountWarningWritten: false };
  await collectBlockChildren({
    client,
    blockId: pageId,
    pageId,
    depth: 0,
    warnings,
    state,
    logger,
  });
  return state.blocks;
}

interface ScopedLinkTarget {
  pageId: string;
  dir: string;
  children: string[];
  reverseLinks: string[];
  mentions: string[];
  databases: string[];
}

function indexTargetsByPageId(targets: Iterable<ScopedLinkTarget>): Map<string, ScopedLinkTarget[]> {
  const targetsByPageId = new Map<string, ScopedLinkTarget[]>();
  for (const target of targets) {
    const existing = targetsByPageId.get(target.pageId) ?? [];
    existing.push(target);
    targetsByPageId.set(target.pageId, existing);
  }
  return targetsByPageId;
}

function addUnique(target: string[], value: unknown): void {
  if (typeof value === 'string' && value && !target.includes(value)) {
    target.push(value);
  }
}

function collectLinkedIds(value: unknown, links: NotionLinks): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLinkedIds(item, links);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  const typed = value as Record<string, unknown>;
  if (typed.type === 'relation' && Array.isArray(typed.relation)) {
    for (const relation of typed.relation) {
      addUnique(links.mentions, (relation as { id?: unknown }).id);
    }
  }
  if (typed.type === 'page' && typed.page && typeof typed.page === 'object') {
    addUnique(links.mentions, (typed.page as { id?: unknown }).id);
  }
  if (typed.type === 'link_to_page' && typed.link_to_page && typeof typed.link_to_page === 'object') {
    const link = typed.link_to_page as Record<string, unknown>;
    addUnique(links.mentions, link.page_id);
    addUnique(links.databases, link.database_id);
  }

  for (const nested of Object.values(typed)) {
    collectLinkedIds(nested, links);
  }
}

function extractLinks(page: Record<string, unknown>, blocks: NotionBlock[]): NotionLinks {
  const links: NotionLinks = { children: [], reverseLinks: [], mentions: [], databases: [] };
  collectLinkedIds(page.properties, links);
  for (const block of blocks) {
    if (block.type === 'child_page') {
      addUnique(links.children, block.id);
    }
    collectLinkedIds(block, links);
  }
  return links;
}

function parentDataSourceId(page: Record<string, unknown>): string | null {
  const parent = page.parent;
  if (!parent || typeof parent !== 'object') {
    return null;
  }
  const typed = parent as Record<string, unknown>;
  return typed.type === 'data_source_id' && typeof typed.data_source_id === 'string' ? typed.data_source_id : null;
}

async function writeScopedLinks(stagedRoot: string, state: CrawlState): Promise<void> {
  const scopedPageIds = new Set([...state.pageTargets.values()].map((target) => target.pageId));
  const linksByTarget = new Map<string, ScopedLinkTarget>(
    [...state.pageTargets].map(([targetKey, target]) => [
      targetKey,
      {
        pageId: target.pageId,
        dir: target.dir,
        children: target.links.children.filter((id) => scopedPageIds.has(id)).sort(),
        reverseLinks: [] as string[],
        mentions: target.links.mentions.filter((id) => scopedPageIds.has(id)).sort(),
        databases: [...new Set(target.links.databases)].sort(),
      },
    ]),
  );
  const targetsByPageId = indexTargetsByPageId(linksByTarget.values());

  for (const source of linksByTarget.values()) {
    for (const targetPageId of source.mentions) {
      for (const target of targetsByPageId.get(targetPageId) ?? []) {
        addUnique(target.reverseLinks, source.pageId);
      }
    }
  }

  for (const target of linksByTarget.values()) {
    target.reverseLinks.sort();
    await writeJson(join(stagedRoot, target.dir, 'links.json'), {
      children: target.children,
      reverseLinks: target.reverseLinks,
      mentions: target.mentions,
      databases: target.databases,
    });
  }
}

async function materializePage(params: {
  client: NotionApi;
  pageId: string;
  stagedRoot: string;
  fallbackPath: string[];
  state: CrawlState;
  config: NotionPullConfig;
  databaseId?: string | null;
  dataSourceId?: string | null;
  rowPath?: string | null;
  page?: Record<string, unknown> | null;
  skipDataSourceRows?: boolean;
  logger: NotionFetchLogger;
}): Promise<void> {
  const dir = params.rowPath ?? join('pages', params.pageId);
  if (params.state.materializedPageTargets.has(dir)) {
    return;
  }
  if (!hasPageBudget(params.state, params.config)) {
    markCapped(params.state, params.config);
    return;
  }
  params.state.materializedPageTargets.add(dir);

  try {
    const page = params.page ?? (await params.client.retrievePage(params.pageId));
    if (params.skipDataSourceRows && !params.dataSourceId && parentDataSourceId(page)) {
      return;
    }
    const blocks = await collectBlockTree(params.client, params.pageId, params.state.warnings, params.logger);
    const metadata = normalizeNotionPageMetadata({
      page,
      fallbackPath: params.fallbackPath,
      objectType: params.dataSourceId ? 'data_source_row' : 'page',
      databaseId: params.databaseId ?? null,
      dataSourceId: params.dataSourceId ?? null,
    });
    const markdownBody = normalizeNotionBlocksToMarkdown(blocks);
    const pageMarkdown = [`# ${metadata.title}`, '', markdownBody].filter(Boolean).join('\n\n');
    await writeJson(join(params.stagedRoot, dir, 'metadata.json'), metadata);
    await writeText(join(params.stagedRoot, dir, 'page.md'), pageMarkdown);
    await writeJson(join(params.stagedRoot, dir, 'blocks.json'), blocks);
    const links = extractLinks(page, blocks);
    params.state.pageTargets.set(dir, { pageId: params.pageId, dir, links });
    params.state.pageCount += 1;

    if (!params.dataSourceId) {
      for (const childPageId of links.children) {
        if (params.state.capped) {
          break;
        }
        await materializePage({
          client: params.client,
          pageId: childPageId,
          stagedRoot: params.stagedRoot,
          fallbackPath: [...params.fallbackPath, metadata.title],
          state: params.state,
          config: params.config,
          logger: params.logger,
        });
      }
    }
  } catch (error) {
    params.logger.warn(`Skipping Notion page ${params.pageId}: ${error instanceof Error ? error.message : String(error)}`);
    params.state.skipped.push({
      externalId: params.pageId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function materializeDataSource(params: {
  client: NotionApi;
  dataSourceId: string;
  stagedRoot: string;
  fallbackPath: string[];
  state: CrawlState;
  config: NotionPullConfig;
  databaseId?: string | null;
  dataSourceSearchCursorAfterThis?: string | null;
  rowStartCursor?: string | null;
  logger: NotionFetchLogger;
}): Promise<void> {
  const baseDir = params.databaseId
    ? join('databases', params.databaseId, 'data-sources', params.dataSourceId)
    : join('data-sources', params.dataSourceId);
  await writeJson(join(params.stagedRoot, baseDir, 'metadata.json'), {
    objectType: 'data_source',
    id: params.dataSourceId,
    title: params.dataSourceId,
    path: [...params.fallbackPath, params.dataSourceId].join(' / '),
    url: null,
    parentId: params.databaseId ?? null,
    databaseId: params.databaseId ?? null,
    dataSourceId: params.dataSourceId,
    lastEditedAt: null,
    lastEditedBy: null,
    properties: {},
  });
  params.state.dataSourceCount += 1;

  await visitPaginated({
    load: (cursor, pageSize) => params.client.queryDataSource(params.dataSourceId, cursor, pageSize),
    startCursor: params.rowStartCursor ?? null,
    pageSize: () => remainingPageBudget(params.state, params.config),
    shouldContinue: () => hasPageBudget(params.state, params.config),
    visit: async (row, nextCursor) => {
      if (typeof row.id !== 'string') {
        return;
      }
      await materializePage({
        client: params.client,
        pageId: row.id,
        stagedRoot: params.stagedRoot,
        fallbackPath: params.fallbackPath,
        state: params.state,
        config: params.config,
        databaseId: params.databaseId ?? null,
        dataSourceId: params.dataSourceId,
        rowPath: join(baseDir, 'rows', row.id),
        page: row,
        logger: params.logger,
      });
      if (!hasPageBudget(params.state, params.config) && nextCursor) {
        markCapped(
          params.state,
          params.config,
          params.dataSourceSearchCursorAfterThis === undefined
            ? undefined
            : {
                phase: 'all_accessible_data_source_rows',
                dataSourceId: params.dataSourceId,
                dataSourceSearchCursor: params.dataSourceSearchCursorAfterThis ?? null,
                rowCursor: nextCursor,
              },
        );
      }
    },
  });
}

async function materializeDatabase(params: {
  client: NotionApi;
  databaseId: string;
  stagedRoot: string;
  state: CrawlState;
  config: NotionPullConfig;
  logger: NotionFetchLogger;
}): Promise<void> {
  const database: NotionDatabaseContainer = await params.client.retrieveDatabase(params.databaseId);
  await writeJson(join(params.stagedRoot, 'databases', params.databaseId, 'metadata.json'), {
    objectType: 'database',
    id: params.databaseId,
    title: params.databaseId,
    path: params.databaseId,
    url: null,
    parentId: null,
    databaseId: params.databaseId,
    dataSourceId: null,
    lastEditedAt: null,
    lastEditedBy: null,
    properties: {},
  });
  params.state.databaseCount += 1;

  for (const dataSource of database.data_sources ?? []) {
    if (params.state.capped) {
      return;
    }
    await materializeDataSource({
      client: params.client,
      dataSourceId: dataSource.id,
      stagedRoot: params.stagedRoot,
      fallbackPath: [params.databaseId, dataSource.name ?? dataSource.id],
      state: params.state,
      config: params.config,
      databaseId: params.databaseId,
      logger: params.logger,
    });
  }
}

export async function fetchNotionSnapshot(params: FetchNotionSnapshotParams): Promise<NotionManifest> {
  const logger = params.logger ?? noopNotionFetchLogger;
  await mkdir(params.stagedDir, { recursive: true });
  const configuredCursor = params.config.crawlMode === 'all_accessible' ? parseConfiguredCursor(params.config) : null;
  const continuedFromCursor = configuredCursor !== null;
  const state: CrawlState = {
    pageCount: 0,
    databaseCount: 0,
    dataSourceCount: 0,
    capped: false,
    skipped: [],
    warnings: [],
    materializedPageTargets: new Set(),
    nextSuccessfulCursor: null,
    pageTargets: new Map(),
  };

  if (params.config.crawlMode === 'all_accessible') {
    // Known v1 limitation: with Notion API 2026-03-11, search exposes page and data_source objects but not
    // database containers. If container search becomes available, add a database pass before data-source rows here.
    const startWithDataSources =
      configuredCursor?.phase === 'all_accessible_data_sources' ||
      configuredCursor?.phase === 'all_accessible_data_source_rows';

    if (configuredCursor?.phase === 'all_accessible_data_source_rows') {
      await materializeDataSource({
        client: params.client,
        dataSourceId: configuredCursor.dataSourceId,
        stagedRoot: params.stagedDir,
        fallbackPath: [configuredCursor.dataSourceId],
        state,
        config: params.config,
        dataSourceSearchCursorAfterThis: configuredCursor.dataSourceSearchCursor,
        rowStartCursor: configuredCursor.rowCursor,
        logger,
      });
      if (!hasPageBudget(state, params.config) && !state.capped && configuredCursor.dataSourceSearchCursor) {
        markCapped(state, params.config, {
          phase: 'all_accessible_data_sources',
          cursor: configuredCursor.dataSourceSearchCursor,
        });
      }
    }

    if (!startWithDataSources && !state.capped) {
      await visitPaginated({
        load: (cursor, pageSize) => params.client.search('page', cursor, pageSize),
        startCursor: configuredCursor?.phase === 'all_accessible_pages' ? configuredCursor.cursor : null,
        pageSize: () => remainingPageBudget(state, params.config),
        shouldContinue: () => hasPageBudget(state, params.config),
        visit: async (page, nextCursor) => {
          await materializePage({
            client: params.client,
            pageId: page.id,
            stagedRoot: params.stagedDir,
            fallbackPath: [],
            state,
            config: params.config,
            skipDataSourceRows: true,
            logger,
          });
          if (!hasPageBudget(state, params.config) && nextCursor) {
            markCapped(state, params.config, { phase: 'all_accessible_pages', cursor: nextCursor });
          }
        },
      });
      if (!hasPageBudget(state, params.config) && state.nextSuccessfulCursor === null) {
        markCapped(state, params.config, { phase: 'all_accessible_data_sources', cursor: null });
      }
    }

    if (!state.capped) {
      await visitPaginated({
        load: (cursor) => params.client.search('data_source', cursor, 1),
        startCursor:
          configuredCursor?.phase === 'all_accessible_data_sources'
            ? configuredCursor.cursor
            : configuredCursor?.phase === 'all_accessible_data_source_rows'
              ? configuredCursor.dataSourceSearchCursor
              : null,
        pageSize: () => 1,
        shouldContinue: () => hasPageBudget(state, params.config),
        visit: async (dataSource, nextCursor) => {
          await materializeDataSource({
            client: params.client,
            dataSourceId: dataSource.id,
            stagedRoot: params.stagedDir,
            fallbackPath: [dataSource.id],
            state,
            config: params.config,
            dataSourceSearchCursorAfterThis: nextCursor,
            logger,
          });
          if (!hasPageBudget(state, params.config) && state.nextSuccessfulCursor === null) {
            markCapped(state, params.config, { phase: 'all_accessible_data_sources', cursor: nextCursor });
          }
        },
      });
    }
  } else {
    for (const pageId of params.config.rootPageIds) {
      if (state.capped) {
        break;
      }
      await materializePage({
        client: params.client,
        pageId,
        stagedRoot: params.stagedDir,
        fallbackPath: [],
        state,
        config: params.config,
        logger,
      });
    }
    for (const databaseId of params.config.rootDatabaseIds) {
      if (state.capped) {
        break;
      }
      await materializeDatabase({
        client: params.client,
        databaseId,
        stagedRoot: params.stagedDir,
        state,
        config: params.config,
        logger,
      });
    }
    for (const dataSourceId of params.config.rootDataSourceIds) {
      if (state.capped) {
        break;
      }
      await materializeDataSource({
        client: params.client,
        dataSourceId,
        stagedRoot: params.stagedDir,
        fallbackPath: [dataSourceId],
        state,
        config: params.config,
        logger,
      });
    }
  }

  await writeScopedLinks(params.stagedDir, state);

  const manifest: NotionManifest = {
    source: NOTION_SOURCE_KEY,
    apiVersion: NOTION_API_VERSION,
    crawlMode: params.config.crawlMode,
    rootPageIds: params.config.rootPageIds,
    rootDatabaseIds: params.config.rootDatabaseIds,
    rootDataSourceIds: params.config.rootDataSourceIds,
    fetchedAt: new Date().toISOString(),
    pageCount: state.pageCount,
    databaseCount: state.databaseCount,
    dataSourceCount: state.dataSourceCount,
    capped: state.capped,
    continuedFromCursor,
    partialSnapshot: state.capped || continuedFromCursor,
    maxPagesPerRun: params.config.maxPagesPerRun,
    maxKnowledgeCreatesPerRun: params.config.maxKnowledgeCreatesPerRun,
    maxKnowledgeUpdatesPerRun: params.config.maxKnowledgeUpdatesPerRun,
    nextSuccessfulCursor: state.capped ? state.nextSuccessfulCursor : null,
    skipped: state.skipped,
    warnings: state.warnings,
  };
  await writeJson(join(params.stagedDir, 'manifest.json'), manifest);
  return manifest;
}
