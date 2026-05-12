import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN,
  type NotionPullConfig,
  notionPullConfigSchema,
} from '../ingest/adapters/notion/types.js';
import type { KtxProjectConnectionConfig } from '../project/config.js';

export const KTX_NOTION_ORG_KNOWLEDGE_WARNING =
  'Anything accessible to this Notion integration can become organization knowledge.';

type KtxNotionCrawlMode = 'all_accessible' | 'selected_roots';

export interface KtxNotionConnectionConfig extends KtxProjectConnectionConfig {
  driver: 'notion';
  auth_token: string | null;
  auth_token_ref: string | null;
  crawl_mode: KtxNotionCrawlMode;
  root_page_ids: string[];
  root_database_ids: string[];
  root_data_source_ids: string[];
  max_pages_per_run: number;
  max_knowledge_creates_per_run: number;
  max_knowledge_updates_per_run: number;
  last_successful_cursor: string | null;
}

export interface RedactedKtxNotionConnectionConfig {
  driver: 'notion';
  hasAuthToken: boolean;
  crawlMode: KtxNotionCrawlMode;
  rootPageIds: string[];
  rootDatabaseIds: string[];
  rootDataSourceIds: string[];
  maxPagesPerRun: number;
  maxKnowledgeCreatesPerRun: number;
  maxKnowledgeUpdatesPerRun: number;
  warning: typeof KTX_NOTION_ORG_KNOWLEDGE_WARNING;
}

interface ResolveNotionTokenOptions {
  env?: Record<string, string | undefined>;
  readTextFile?: (path: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Notion connection config must be an object');
  }
  return value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function integerWithFallback(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, name: string, min: number, max: number): number {
  const parsed = integerWithFallback(value, fallback, name);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

export function parseNotionConnectionConfig(raw: unknown): KtxNotionConnectionConfig {
  const input = record(raw);
  if (input.driver !== 'notion') {
    throw new Error('Notion connection config requires driver: notion');
  }
  const authToken = optionalString(input.auth_token);
  const authTokenRef = optionalString(input.auth_token_ref);
  if (!authToken && !authTokenRef) {
    throw new Error('Notion connection config requires auth_token or auth_token_ref');
  }
  if (authTokenRef && !authTokenRef.startsWith('env:') && !authTokenRef.startsWith('file:')) {
    throw new Error('Notion auth_token_ref must use env:NAME or file:/path');
  }

  const crawlMode = stringValue(input.crawl_mode, 'selected_roots');
  if (crawlMode !== 'selected_roots' && crawlMode !== 'all_accessible') {
    throw new Error(`Unsupported Notion crawl_mode: ${crawlMode}`);
  }
  const rootPageIds = stringArray(input.root_page_ids);
  const rootDatabaseIds = stringArray(input.root_database_ids);
  const rootDataSourceIds = stringArray(input.root_data_source_ids);
  if (crawlMode === 'selected_roots' && rootPageIds.length + rootDatabaseIds.length + rootDataSourceIds.length === 0) {
    throw new Error('selected_roots requires at least one root page, database, or data source id');
  }

  return {
    ...input,
    driver: 'notion',
    auth_token: authToken,
    auth_token_ref: authTokenRef,
    crawl_mode: crawlMode,
    root_page_ids: rootPageIds,
    root_database_ids: rootDatabaseIds,
    root_data_source_ids: rootDataSourceIds,
    max_pages_per_run: boundedInteger(input.max_pages_per_run, 1000, 'max_pages_per_run', 1, 10_000),
    max_knowledge_creates_per_run: boundedInteger(
      input.max_knowledge_creates_per_run,
      NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN,
      'max_knowledge_creates_per_run',
      0,
      25,
    ),
    max_knowledge_updates_per_run: boundedInteger(
      input.max_knowledge_updates_per_run,
      20,
      'max_knowledge_updates_per_run',
      0,
      100,
    ),
    last_successful_cursor: optionalString(input.last_successful_cursor),
  };
}

export function redactNotionConnectionConfig(config: KtxNotionConnectionConfig): RedactedKtxNotionConnectionConfig {
  return {
    driver: 'notion',
    hasAuthToken: Boolean(config.auth_token ?? config.auth_token_ref),
    crawlMode: config.crawl_mode,
    rootPageIds: config.root_page_ids,
    rootDatabaseIds: config.root_database_ids,
    rootDataSourceIds: config.root_data_source_ids,
    maxPagesPerRun: config.max_pages_per_run,
    maxKnowledgeCreatesPerRun: config.max_knowledge_creates_per_run,
    maxKnowledgeUpdatesPerRun: config.max_knowledge_updates_per_run,
    warning: KTX_NOTION_ORG_KNOWLEDGE_WARNING,
  };
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

export async function resolveNotionAuthToken(
  authTokenRef: string,
  options: ResolveNotionTokenOptions = {},
): Promise<string> {
  if (authTokenRef.startsWith('env:')) {
    const envName = authTokenRef.slice('env:'.length);
    const value = (options.env ?? process.env)[envName];
    if (!value) {
      throw new Error(`Notion token environment variable ${envName} is not set`);
    }
    return value.trim();
  }
  if (authTokenRef.startsWith('file:')) {
    const path = expandHome(authTokenRef.slice('file:'.length));
    const readTextFile = options.readTextFile ?? ((filePath: string) => readFile(filePath, 'utf-8'));
    const value = (await readTextFile(path)).trim();
    if (!value) {
      throw new Error(`Notion token file is empty: ${path}`);
    }
    return value;
  }
  throw new Error('Notion auth_token_ref must use env:NAME or file:/path');
}

export async function resolveNotionConnectionAuthToken(
  config: Pick<KtxNotionConnectionConfig, 'auth_token' | 'auth_token_ref'>,
  options: ResolveNotionTokenOptions = {},
): Promise<string> {
  return config.auth_token ?? (await resolveNotionAuthToken(config.auth_token_ref ?? '', options));
}

export async function notionConnectionToPullConfig(
  config: KtxNotionConnectionConfig,
  options: ResolveNotionTokenOptions = {},
): Promise<NotionPullConfig> {
  const authToken = await resolveNotionConnectionAuthToken(config, options);
  return notionPullConfigSchema.parse({
    authToken,
    crawlMode: config.crawl_mode,
    rootPageIds: config.root_page_ids,
    rootDatabaseIds: config.root_database_ids,
    rootDataSourceIds: config.root_data_source_ids,
    maxPagesPerRun: config.max_pages_per_run,
    maxKnowledgeCreatesPerRun: config.max_knowledge_creates_per_run,
    maxKnowledgeUpdatesPerRun: config.max_knowledge_updates_per_run,
    lastSuccessfulCursor: config.last_successful_cursor,
  });
}
