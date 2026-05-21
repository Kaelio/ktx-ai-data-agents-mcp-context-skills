import { z } from 'zod';
import { connectionTypeSchema } from '../../../connections/connection-type.js';
import { parsedTargetTableSchema } from '../../parsed-target-table.js';

const lookerIdSchema = z.union([z.string(), z.number().int()]).transform(String);
const nullableLookerIdSchema = z.union([lookerIdSchema, z.null()]).default(null);

export const lookerConnectionIdSchema = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);

export const lookerRuntimeCursorsSchema = z.object({
  dashboardsLastSyncedAt: z.iso.datetime().nullable().default(null),
  looksLastSyncedAt: z.iso.datetime().nullable().default(null),
});

export type LookerRuntimeCursors = z.infer<typeof lookerRuntimeCursorsSchema>;

/** @internal */
export const lookerPullConfigSchema = z.object({
  lookerConnectionId: lookerConnectionIdSchema.optional(),
  instanceBaseUrl: z.url().optional(),
  dashboardUpdatedSince: z.iso.datetime().nullable().optional(),
  lookUpdatedSince: z.iso.datetime().nullable().optional(),
  connectionMappings: z.record(z.string(), lookerConnectionIdSchema).default({}),
  connectionTypes: z.record(z.string(), connectionTypeSchema).default({}),
  parsedTargetTables: z.record(z.string(), parsedTargetTableSchema).default({}),
});

export type LookerPullConfig = z.infer<typeof lookerPullConfigSchema>;

export function parseLookerPullConfig(raw: unknown): LookerPullConfig {
  return lookerPullConfigSchema.parse(raw ?? {});
}

export const stagedSyncConfigSchema = z.object({
  lookerConnectionId: lookerConnectionIdSchema,
  fetchedAt: z.iso.datetime(),
  instanceBaseUrl: z.url().optional(),
  previousCursors: lookerRuntimeCursorsSchema.default({
    dashboardsLastSyncedAt: null,
    looksLastSyncedAt: null,
  }),
  nextCursors: lookerRuntimeCursorsSchema.default({
    dashboardsLastSyncedAt: null,
    looksLastSyncedAt: null,
  }),
});

export const stagedLookerQuerySchema = z.object({
  id: lookerIdSchema.optional(),
  model: z.string(),
  view: z.string(),
  fields: z.array(z.string()).default([]),
  filters: z.record(z.string(), z.unknown()).default({}),
  sorts: z.array(z.string()).default([]),
  limit: z.union([z.string(), z.number()]).optional().nullable(),
  dynamicFields: z.string().optional().nullable(),
  targetWarehouseConnectionId: lookerConnectionIdSchema.nullable().default(null),
  targetTable: parsedTargetTableSchema.nullable().default(null),
});

export type StagedLookerQuery = z.infer<typeof stagedLookerQuerySchema>;

const stagedDashboardTileSchema = z.object({
  id: lookerIdSchema,
  title: z.string().nullable().default(null),
  lookId: nullableLookerIdSchema,
  query: stagedLookerQuerySchema.nullable().default(null),
});

export const stagedDashboardFileSchema = z.object({
  lookerId: lookerIdSchema,
  title: z.string(),
  description: z.string().nullable(),
  folderId: nullableLookerIdSchema,
  ownerId: nullableLookerIdSchema,
  updatedAt: z.string().nullable(),
  tiles: z.array(stagedDashboardTileSchema).default([]),
});

export type StagedDashboardFile = z.infer<typeof stagedDashboardFileSchema>;

export const stagedLookFileSchema = z.object({
  lookerId: lookerIdSchema,
  title: z.string(),
  description: z.string().nullable(),
  folderId: nullableLookerIdSchema,
  ownerId: nullableLookerIdSchema,
  updatedAt: z.string().nullable(),
  query: stagedLookerQuerySchema.nullable().default(null),
});

export type StagedLookFile = z.infer<typeof stagedLookFileSchema>;

const stagedFolderSchema = z.object({
  id: lookerIdSchema,
  name: z.string(),
  parentId: nullableLookerIdSchema,
  path: z.array(z.string()).default([]),
});

export const stagedFoldersTreeFileSchema = z.object({
  folders: z.array(stagedFolderSchema),
});

export type StagedFoldersTreeFile = z.infer<typeof stagedFoldersTreeFileSchema>;

export const stagedUserFileSchema = z.object({
  id: lookerIdSchema,
  displayName: z.string().nullable(),
  email: z.string().nullable().default(null),
});

export type StagedUserFile = z.infer<typeof stagedUserFileSchema>;

export const stagedGroupFileSchema = z.object({
  id: lookerIdSchema,
  name: z.string(),
});

export type StagedGroupFile = z.infer<typeof stagedGroupFileSchema>;

const stagedLookmlModelSchema = z.object({
  name: z.string(),
  label: z.string().nullable().default(null),
  explores: z.array(z.object({ name: z.string(), label: z.string().nullable().default(null) })),
});

export const stagedLookmlModelsFileSchema = z.object({
  models: z.array(stagedLookmlModelSchema),
});

export type StagedLookmlModelsFile = z.infer<typeof stagedLookmlModelsFileSchema>;

const stagedLookerFieldSchema = z.object({
  name: z.string(),
  label: z.string().nullable().default(null),
  type: z.string().nullable().default(null),
  sql: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
});

const stagedLookerJoinSchema = z.object({
  name: z.string(),
  type: z.string().nullable().default(null),
  relationship: z.string().nullable().default(null),
  rawSqlTableName: z.string().nullable().default(null),
  sqlOn: z.string().nullable().default(null),
  from: z.string().nullable().default(null),
  targetTable: parsedTargetTableSchema.nullable().default(null),
});

export const stagedExploreFileSchema = z.object({
  modelName: z.string(),
  exploreName: z.string(),
  label: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  rawSqlTableName: z.string().nullable().default(null),
  connectionName: z.string().nullable().default(null),
  viewName: z.string().nullable().default(null),
  fields: z.object({
    dimensions: z.array(stagedLookerFieldSchema).default([]),
    measures: z.array(stagedLookerFieldSchema).default([]),
  }),
  joins: z.array(stagedLookerJoinSchema).default([]),
  targetWarehouseConnectionId: lookerConnectionIdSchema.nullable().default(null),
  targetTable: parsedTargetTableSchema.nullable().default(null),
});

export type StagedExploreFile = z.infer<typeof stagedExploreFileSchema>;

const stagedUsageSignalSchema = z.object({
  contentId: lookerIdSchema,
  queryCount30d: z.number().int().nonnegative().default(0),
  uniqueUsers30d: z.number().int().nonnegative().default(0),
  lastRunAt: z.string().nullable().default(null),
  topUsers: z.array(lookerIdSchema).default([]),
});

const stagedScheduledPlanSignalSchema = z.object({
  contentId: lookerIdSchema,
  contentType: z.enum(['dashboard', 'look']),
  isScheduled: z.boolean(),
  scheduleCount: z.number().int().nonnegative().default(0),
  recipientCount: z.number().int().nonnegative().default(0),
});

const stagedFavoriteSignalSchema = z.object({
  contentId: lookerIdSchema,
  contentType: z.enum(['dashboard', 'look']),
  favoriteCount: z.number().int().nonnegative().default(0),
});

export const stagedLookerSignalsFileSchema = z.object({
  dashboardUsage: z.array(stagedUsageSignalSchema).default([]),
  lookUsage: z.array(stagedUsageSignalSchema).default([]),
  scheduledPlans: z.array(stagedScheduledPlanSignalSchema).default([]),
  favorites: z.array(stagedFavoriteSignalSchema).default([]),
});

export type StagedLookerSignalsFile = z.infer<typeof stagedLookerSignalsFileSchema>;

export const stagedLookerScopeFileSchema = z.object({
  mode: z.enum(['full', 'incremental']),
  knownCurrentRawPaths: z.array(z.string()).default([]),
  fetchedRawPaths: z.array(z.string()).default([]),
});

export type StagedLookerScopeFile = z.infer<typeof stagedLookerScopeFileSchema>;

const stagedLookerFetchIssueKindSchema = z.enum([
  'unmapped_looker_connection',
  'unparseable_sql_table_name',
  'looker_template_unresolved',
  'derived_table_not_supported',
  'lookml_connection_mismatch',
]);

export const stagedLookerFetchIssueSchema = z.object({
  rawPath: z.string().min(1),
  entityType: z.enum(['dashboard', 'look', 'explore', 'signals', 'lookml_models', 'looker_connection_mapping']),
  entityId: z.string().nullable().default(null),
  severity: z.enum(['warning', 'error']),
  statusCode: z.number().int().nullable().default(null),
  message: z.string().min(1),
  retryRecommended: z.boolean().default(false),
  kind: stagedLookerFetchIssueKindSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type StagedLookerFetchIssue = z.infer<typeof stagedLookerFetchIssueSchema>;

export const stagedLookerFetchReportSchema = z.object({
  status: z.enum(['success', 'partial']),
  retryRecommended: z.boolean().default(false),
  skipped: z.array(stagedLookerFetchIssueSchema).default([]),
  warnings: z.array(stagedLookerFetchIssueSchema).default([]),
});

export type StagedLookerFetchReport = z.infer<typeof stagedLookerFetchReportSchema>;

export const STAGED_FILES = {
  syncConfig: 'sync-config.json',
  scope: 'looker-scope.json',
  fetchReport: 'looker-fetch-report.json',
  evidenceRoot: 'evidence',
  lookmlModels: 'lookml_models.json',
  foldersTree: 'folders/tree.json',
  signals: {
    dashboardUsage: 'signals/dashboard_usage.json',
    lookUsage: 'signals/look_usage.json',
    scheduledPlans: 'signals/scheduled_plans.json',
    favorites: 'signals/favorites.json',
  },
} as const;
