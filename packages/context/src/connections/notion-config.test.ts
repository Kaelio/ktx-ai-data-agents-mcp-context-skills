import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  notionConnectionToPullConfig,
  parseNotionConnectionConfig,
  redactNotionConnectionConfig,
  resolveNotionAuthToken,
} from './notion-config.js';

describe('standalone Notion connection config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-notion-config-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses selected-root Notion config with safe defaults', () => {
    const parsed = parseNotionConnectionConfig({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'selected_roots',
      root_page_ids: ['page-1'],
    });

    expect(parsed).toEqual({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'selected_roots',
      root_page_ids: ['page-1'],
      root_database_ids: [],
      root_data_source_ids: [],
      max_pages_per_run: 1000,
      max_knowledge_creates_per_run: 5,
      max_knowledge_updates_per_run: 20,
      last_successful_cursor: null,
    });
  });

  it('redacts token references from display output', () => {
    expect(
      redactNotionConnectionConfig(
        parseNotionConnectionConfig({
          driver: 'notion',
          auth_token_ref: 'file:/Users/example/.config/notion-token',
          crawl_mode: 'all_accessible',
          max_pages_per_run: 80,
        }),
      ),
    ).toEqual({
      driver: 'notion',
      hasAuthToken: true,
      crawlMode: 'all_accessible',
      rootPageIds: [],
      rootDatabaseIds: [],
      rootDataSourceIds: [],
      maxPagesPerRun: 80,
      maxKnowledgeCreatesPerRun: 5,
      maxKnowledgeUpdatesPerRun: 20,
      warning: 'Anything accessible to this Notion integration can become organization knowledge.',
    });
  });

  it('requires at least one selected root in selected_roots mode', () => {
    expect(() =>
      parseNotionConnectionConfig({
        driver: 'notion',
        auth_token_ref: 'env:NOTION_TOKEN',
        crawl_mode: 'selected_roots',
      }),
    ).toThrow('selected_roots requires at least one root page, database, or data source id');
  });

  it('resolves env and file token references without exposing the reference in errors', async () => {
    const tokenPath = join(tempDir, 'notion-token.txt');
    await writeFile(tokenPath, 'ntn_file_token\n', 'utf-8');

    await expect(
      resolveNotionAuthToken('env:NOTION_TOKEN', {
        env: { NOTION_TOKEN: 'ntn_env_token' },
      }),
    ).resolves.toBe('ntn_env_token');
    await expect(resolveNotionAuthToken(`file:${tokenPath}`)).resolves.toBe('ntn_file_token');
    await expect(resolveNotionAuthToken('env:MISSING_NOTION_TOKEN', { env: {} })).rejects.toThrow(
      'Notion token environment variable MISSING_NOTION_TOKEN is not set',
    );
  });

  it('converts standalone config into adapter pull config', async () => {
    const pullConfig = await notionConnectionToPullConfig(
      parseNotionConnectionConfig({
        driver: 'notion',
        auth_token_ref: 'env:NOTION_TOKEN',
        crawl_mode: 'all_accessible',
        max_pages_per_run: 12,
        max_knowledge_creates_per_run: 2,
        max_knowledge_updates_per_run: 7,
        last_successful_cursor: '{"phase":"all_accessible_pages","cursor":"cursor-1"}',
      }),
      { env: { NOTION_TOKEN: 'ntn_env_token' } },
    );

    expect(pullConfig).toEqual({
      authToken: 'ntn_env_token',
      crawlMode: 'all_accessible',
      rootPageIds: [],
      rootDatabaseIds: [],
      rootDataSourceIds: [],
      maxPagesPerRun: 12,
      maxKnowledgeCreatesPerRun: 2,
      maxKnowledgeUpdatesPerRun: 7,
      lastSuccessfulCursor: '{"phase":"all_accessible_pages","cursor":"cursor-1"}',
    });
  });
});
