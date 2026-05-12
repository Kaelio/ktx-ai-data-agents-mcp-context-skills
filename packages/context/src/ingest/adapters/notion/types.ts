import { z } from 'zod';

export const NOTION_API_VERSION = '2026-03-11';
export const NOTION_SOURCE_KEY = 'notion';
export const NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN = 25;

export const notionPullConfigSchema = z.object({
  authToken: z.string().min(1),
  crawlMode: z.enum(['all_accessible', 'selected_roots']),
  rootPageIds: z.array(z.string().min(1)).default([]),
  rootDatabaseIds: z.array(z.string().min(1)).default([]),
  rootDataSourceIds: z.array(z.string().min(1)).default([]),
  maxPagesPerRun: z.number().int().min(1).max(10_000).default(1000),
  maxKnowledgeCreatesPerRun: z.number().int().min(0).max(25).default(NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN),
  maxKnowledgeUpdatesPerRun: z.number().int().min(0).max(100).default(20),
  lastSuccessfulCursor: z.string().nullable().default(null),
});
export type NotionPullConfig = z.infer<typeof notionPullConfigSchema>;

export const notionCrawlCursorSchema = z
  .discriminatedUnion('phase', [
    z.object({ phase: z.literal('all_accessible_pages'), cursor: z.string().nullable() }),
    z.object({ phase: z.literal('all_accessible_data_sources'), cursor: z.string().nullable() }),
    z.object({
      phase: z.literal('all_accessible_data_source_rows'),
      dataSourceId: z.string(),
      dataSourceSearchCursor: z.string().nullable(),
      rowCursor: z.string().nullable(),
    }),
  ])
  .nullable();
export type NotionCrawlCursor = z.infer<typeof notionCrawlCursorSchema>;

const notionObjectTypeSchema = z.enum(['page', 'database', 'data_source', 'data_source_row']);
export type NotionObjectType = z.infer<typeof notionObjectTypeSchema>;

export const notionManifestSchema = z.object({
  source: z.literal(NOTION_SOURCE_KEY),
  apiVersion: z.literal(NOTION_API_VERSION),
  crawlMode: z.enum(['all_accessible', 'selected_roots']),
  rootPageIds: z.array(z.string()),
  rootDatabaseIds: z.array(z.string()),
  rootDataSourceIds: z.array(z.string()),
  fetchedAt: z.string().datetime(),
  pageCount: z.number().int(),
  databaseCount: z.number().int(),
  dataSourceCount: z.number().int(),
  capped: z.boolean().default(false),
  continuedFromCursor: z.boolean().default(false),
  partialSnapshot: z.boolean().default(false),
  maxPagesPerRun: z.number().int(),
  maxKnowledgeCreatesPerRun: z.number().int(),
  maxKnowledgeUpdatesPerRun: z.number().int(),
  nextSuccessfulCursor: z.string().nullable().default(null),
  skipped: z.array(z.object({ externalId: z.string(), reason: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});
export type NotionManifest = z.infer<typeof notionManifestSchema>;

export const notionMetadataSchema = z.object({
  objectType: notionObjectTypeSchema,
  id: z.string(),
  title: z.string(),
  path: z.string(),
  url: z.string().nullable().default(null),
  parentId: z.string().nullable().default(null),
  databaseId: z.string().nullable().default(null),
  dataSourceId: z.string().nullable().default(null),
  lastEditedAt: z.string().datetime().nullable().default(null),
  lastEditedBy: z.string().nullable().default(null),
  properties: z.record(z.string(), z.unknown()).default({}),
});
export type NotionMetadata = z.infer<typeof notionMetadataSchema>;

export interface NotionRichText {
  plain_text?: string;
  href?: string | null;
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}
