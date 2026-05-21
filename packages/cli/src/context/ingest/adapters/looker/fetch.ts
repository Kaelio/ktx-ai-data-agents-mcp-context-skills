import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ParsedTargetTable } from '../../parsed-target-table.js';
import type { FetchContext } from '../../types.js';
import { writeLookerEvidenceDocuments } from './evidence-documents.js';
import { writeLookerFetchReport } from './fetch-report.js';
import {
  type LookerPullConfig,
  parseLookerPullConfig,
  STAGED_FILES,
  type StagedDashboardFile,
  type StagedExploreFile,
  type StagedFoldersTreeFile,
  type StagedGroupFile,
  type StagedLookerFetchIssue,
  type StagedLookerFetchReport,
  type StagedLookerQuery,
  type StagedLookerSignalsFile,
  type StagedLookFile,
  type StagedLookmlModelsFile,
  type StagedUserFile,
  stagedDashboardFileSchema,
  stagedExploreFileSchema,
  stagedFoldersTreeFileSchema,
  stagedGroupFileSchema,
  stagedLookerScopeFileSchema,
  stagedLookerSignalsFileSchema,
  stagedLookFileSchema,
  stagedLookmlModelsFileSchema,
  stagedSyncConfigSchema,
  stagedUserFileSchema,
} from './types.js';

interface LookerEntityRef {
  id: string;
  updatedAt?: string | null;
}

export interface LookerRuntimeClient {
  listDashboards(): Promise<LookerEntityRef[]>;
  getDashboard(id: string): Promise<StagedDashboardFile>;
  listLooks(): Promise<LookerEntityRef[]>;
  getLook(id: string): Promise<StagedLookFile>;
  listFolders(): Promise<StagedFoldersTreeFile>;
  listUsers(): Promise<StagedUserFile[]>;
  listGroups(): Promise<StagedGroupFile[]>;
  listLookmlModels(): Promise<StagedLookmlModelsFile>;
  getExplore(modelName: string, exploreName: string): Promise<StagedExploreFile>;
  getSignals?(): Promise<StagedLookerSignalsFile>;
  cleanup?(): Promise<void>;
}

export interface LookerClientFactory {
  createClient(config: LookerPullConfig, ctx: FetchContext): Promise<LookerRuntimeClient> | LookerRuntimeClient;
}

interface ExploreTargetSummary {
  targetWarehouseConnectionId: string | null;
  targetTable: ParsedTargetTable | null;
}

interface StampedExploreResult {
  explore: StagedExploreFile;
  targetSummary: ExploreTargetSummary;
}

interface StagedJsonFile<T> {
  rawPath: string;
  value: T;
}

type ParsedTargetTableFailureReason = Extract<ParsedTargetTable, { ok: false }>['reason'];

interface FetchLookerRuntimeBundleParams {
  pullConfig: unknown;
  stagedDir: string;
  ctx: FetchContext;
  clientFactory: LookerClientFactory;
  now?: () => Date;
}

export async function fetchLookerRuntimeBundle(params: FetchLookerRuntimeBundleParams): Promise<void> {
  const config = parseLookerPullConfig(params.pullConfig);
  const connectionId = config.lookerConnectionId ?? params.ctx.connectionId;
  const client = await params.clientFactory.createClient(config, params.ctx);
  try {
  const now = params.now ?? (() => new Date());
  const skipped: StagedLookerFetchIssue[] = [];
  const warnings: StagedLookerFetchIssue[] = [];
  let dashboardFetchHadSkips = false;
  let lookFetchHadSkips = false;
  const fetchedDashboards: Array<StagedJsonFile<StagedDashboardFile>> = [];
  const fetchedLooks: Array<StagedJsonFile<StagedLookFile>> = [];

  const previousCursors = {
    dashboardsLastSyncedAt: config.dashboardUpdatedSince ?? null,
    looksLastSyncedAt: config.lookUpdatedSince ?? null,
  };

  const dashboards = await client.listDashboards();
  const dashboardRawPaths = dashboards.map((dashboardRef) => `dashboards/${safePathSegment(dashboardRef.id)}.json`);
  const dashboardsToFetch = dashboards.filter((dashboardRef) =>
    shouldFetchEntity(dashboardRef, previousCursors.dashboardsLastSyncedAt),
  );
  const fetchedRawPaths: string[] = [];
  for (const dashboardRef of dashboardsToFetch) {
    const rawPath = `dashboards/${safePathSegment(dashboardRef.id)}.json`;
    try {
      const dashboard = stagedDashboardFileSchema.parse(await client.getDashboard(dashboardRef.id));
      const dashboardRawPath = `dashboards/${safePathSegment(dashboard.lookerId)}.json`;
      fetchedRawPaths.push(dashboardRawPath);
      fetchedDashboards.push({ rawPath: dashboardRawPath, value: dashboard });
    } catch (error) {
      dashboardFetchHadSkips = true;
      skipped.push(issueForFetchError({ rawPath, entityType: 'dashboard', entityId: dashboardRef.id, error }));
    }
  }

  const looks = await client.listLooks();
  const lookRawPaths = looks.map((lookRef) => `looks/${safePathSegment(lookRef.id)}.json`);
  const looksToFetch = looks.filter((lookRef) => shouldFetchEntity(lookRef, previousCursors.looksLastSyncedAt));
  for (const lookRef of looksToFetch) {
    const rawPath = `looks/${safePathSegment(lookRef.id)}.json`;
    try {
      const look = stagedLookFileSchema.parse(await client.getLook(lookRef.id));
      const lookRawPath = `looks/${safePathSegment(look.lookerId)}.json`;
      fetchedRawPaths.push(lookRawPath);
      fetchedLooks.push({ rawPath: lookRawPath, value: look });
    } catch (error) {
      lookFetchHadSkips = true;
      skipped.push(issueForFetchError({ rawPath, entityType: 'look', entityId: lookRef.id, error }));
    }
  }

  const nextCursors = {
    dashboardsLastSyncedAt: dashboardFetchHadSkips
      ? previousCursors.dashboardsLastSyncedAt
      : maxUpdatedAt(dashboards, previousCursors.dashboardsLastSyncedAt),
    looksLastSyncedAt: lookFetchHadSkips
      ? previousCursors.looksLastSyncedAt
      : maxUpdatedAt(looks, previousCursors.looksLastSyncedAt),
  };
  const fetchMode =
    previousCursors.dashboardsLastSyncedAt || previousCursors.looksLastSyncedAt ? 'incremental' : 'full';

  await writeJson(
    params.stagedDir,
    STAGED_FILES.syncConfig,
    stagedSyncConfigSchema.parse({
      lookerConnectionId: connectionId,
      fetchedAt: now().toISOString(),
      ...(config.instanceBaseUrl ? { instanceBaseUrl: config.instanceBaseUrl } : {}),
      previousCursors,
      nextCursors,
    }),
  );

  await writeJson(
    params.stagedDir,
    STAGED_FILES.scope,
    stagedLookerScopeFileSchema.parse({
      mode: fetchMode,
      knownCurrentRawPaths: [...dashboardRawPaths, ...lookRawPaths].sort(),
      fetchedRawPaths: fetchedRawPaths.sort(),
    }),
  );

  const folders = stagedFoldersTreeFileSchema.parse(await client.listFolders());
  await writeJson(params.stagedDir, STAGED_FILES.foldersTree, folders);

  const users = await client.listUsers();
  for (const rawUser of users) {
    const user = stagedUserFileSchema.parse(rawUser);
    await writeJson(params.stagedDir, `users/${safePathSegment(user.id)}.json`, user);
  }

  const groups = await client.listGroups();
  for (const rawGroup of groups) {
    const group = stagedGroupFileSchema.parse(rawGroup);
    await writeJson(params.stagedDir, `groups/${safePathSegment(group.id)}.json`, group);
  }

  let models: StagedLookmlModelsFile;
  try {
    models = stagedLookmlModelsFileSchema.parse(await client.listLookmlModels());
  } catch (error) {
    warnings.push(
      issueForFetchError({
        rawPath: STAGED_FILES.lookmlModels,
        entityType: 'lookml_models',
        entityId: null,
        error,
        severity: 'warning',
      }),
    );
    models = stagedLookmlModelsFileSchema.parse({ models: [] });
  }
  await writeJson(params.stagedDir, STAGED_FILES.lookmlModels, models);
  const exploreTargetsByKey = new Map<string, ExploreTargetSummary>();
  const stagedExplores: StagedExploreFile[] = [];
  for (const model of models.models) {
    for (const exploreRef of model.explores) {
      const rawPath = `explores/${safePathSegment(model.name)}/${safePathSegment(exploreRef.name)}.json`;
      try {
        const result = stampExploreWarehouseTarget(await client.getExplore(model.name, exploreRef.name), config);
        stagedExplores.push(result.explore);
        exploreTargetsByKey.set(exploreKey(result.explore.modelName, result.explore.exploreName), result.targetSummary);
        await writeJson(
          params.stagedDir,
          `explores/${safePathSegment(result.explore.modelName)}/${safePathSegment(result.explore.exploreName)}.json`,
          result.explore,
        );
      } catch (error) {
        skipped.push(
          issueForFetchError({
            rawPath,
            entityType: 'explore',
            entityId: `${model.name}.${exploreRef.name}`,
            error,
          }),
        );
      }
    }
  }
  warnings.push(...warehouseTargetWarnings(stagedExplores));

  for (const dashboard of fetchedDashboards) {
    await writeJson(params.stagedDir, dashboard.rawPath, stampDashboardQueries(dashboard.value, exploreTargetsByKey));
  }

  for (const look of fetchedLooks) {
    await writeJson(params.stagedDir, look.rawPath, stampLookQuery(look.value, exploreTargetsByKey));
  }

  let signals: StagedLookerSignalsFile;
  try {
    signals = stagedLookerSignalsFileSchema.parse(client.getSignals ? await client.getSignals() : {});
  } catch (error) {
    warnings.push(
      issueForFetchError({
        rawPath: STAGED_FILES.signals.dashboardUsage,
        entityType: 'signals',
        entityId: null,
        error,
      }),
    );
    signals = stagedLookerSignalsFileSchema.parse({});
  }
  await writeJson(params.stagedDir, STAGED_FILES.signals.dashboardUsage, signals.dashboardUsage);
  await writeJson(params.stagedDir, STAGED_FILES.signals.lookUsage, signals.lookUsage);
  await writeJson(params.stagedDir, STAGED_FILES.signals.scheduledPlans, signals.scheduledPlans);
  await writeJson(params.stagedDir, STAGED_FILES.signals.favorites, signals.favorites);

  await writeLookerEvidenceDocuments(params.stagedDir);
  await writeLookerFetchReport(params.stagedDir, buildFetchReport(skipped, warnings));
  } finally {
    await client.cleanup?.();
  }
}

async function writeJson(stagedDir: string, relPath: string, value: unknown): Promise<void> {
  const abs = join(stagedDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function safePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Unsafe Looker staged path segment: ${value}`);
  }
  return value;
}

function shouldFetchEntity(ref: LookerEntityRef, updatedSince: string | null): boolean {
  if (!updatedSince) {
    return true;
  }
  if (!ref.updatedAt) {
    return true;
  }
  return Date.parse(ref.updatedAt) > Date.parse(updatedSince);
}

function maxUpdatedAt(refs: LookerEntityRef[], fallback: string | null): string | null {
  let max = fallback;
  for (const ref of refs) {
    if (!ref.updatedAt) {
      continue;
    }
    if (!max || Date.parse(ref.updatedAt) > Date.parse(max)) {
      max = ref.updatedAt;
    }
  }
  if (!max) {
    return null;
  }
  const ms = Date.parse(max);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function stampExploreWarehouseTarget(rawExplore: unknown, config: LookerPullConfig): StampedExploreResult {
  const parsed = stagedExploreFileSchema.parse(rawExplore);
  const key = exploreKey(parsed.modelName, parsed.exploreName);
  const targetWarehouseConnectionId = connectionMappingFor(parsed.connectionName, config);
  const targetTable = targetTableFor({
    key,
    rawSqlTableName: parsed.rawSqlTableName,
    targetWarehouseConnectionId,
    config,
    entityLabel: `Looker explore ${key}`,
  });

  const explore = stagedExploreFileSchema.parse({
    ...parsed,
    targetWarehouseConnectionId,
    targetTable,
    joins: parsed.joins.map((join) => ({
      ...join,
      targetTable: join.rawSqlTableName
        ? targetTableFor({
            key: `${key}.${join.name}`,
            rawSqlTableName: join.rawSqlTableName,
            targetWarehouseConnectionId,
            config,
            entityLabel: `Looker join ${key}.${join.name}`,
          })
        : null,
    })),
  });

  return {
    explore,
    targetSummary: {
      targetWarehouseConnectionId: explore.targetWarehouseConnectionId,
      targetTable: explore.targetTable,
    },
  };
}

function connectionMappingFor(connectionName: string | null, config: LookerPullConfig): string | null {
  if (!connectionName) {
    return null;
  }
  return config.connectionMappings[connectionName] ?? null;
}

function targetTableFor(input: {
  key: string;
  rawSqlTableName: string | null;
  targetWarehouseConnectionId: string | null;
  config: LookerPullConfig;
  entityLabel: string;
}): ParsedTargetTable | null {
  if (!input.rawSqlTableName && !input.targetWarehouseConnectionId) {
    return null;
  }

  if (!input.targetWarehouseConnectionId) {
    return {
      ok: false,
      reason: 'no_connection_mapping',
      detail: `${input.entityLabel} has no mapped warehouse connection.`,
    };
  }

  const parsed = input.config.parsedTargetTables[input.key];
  if (parsed) {
    return parsed;
  }

  if (!input.rawSqlTableName) {
    return null;
  }

  return {
    ok: false,
    reason: 'parse_error',
    detail: `${input.entityLabel} has raw sql_table_name but no parsedTargetTables entry for key ${input.key}.`,
  };
}

function exploreKey(modelName: string, exploreName: string): string {
  return `${modelName}.${exploreName}`;
}

function stampQueryWarehouseTarget(
  query: StagedLookerQuery | null,
  exploreTargetsByKey: Map<string, ExploreTargetSummary>,
): StagedLookerQuery | null {
  if (!query) {
    return null;
  }

  const target = exploreTargetsByKey.get(exploreKey(query.model, query.view));
  if (!target) {
    return query;
  }

  return {
    ...query,
    targetWarehouseConnectionId: target.targetWarehouseConnectionId,
    targetTable: target.targetTable,
  };
}

function stampDashboardQueries(
  dashboard: StagedDashboardFile,
  exploreTargetsByKey: Map<string, ExploreTargetSummary>,
): StagedDashboardFile {
  return stagedDashboardFileSchema.parse({
    ...dashboard,
    tiles: dashboard.tiles.map((tile) => ({
      ...tile,
      query: stampQueryWarehouseTarget(tile.query, exploreTargetsByKey),
    })),
  });
}

function stampLookQuery(look: StagedLookFile, exploreTargetsByKey: Map<string, ExploreTargetSummary>): StagedLookFile {
  return stagedLookFileSchema.parse({
    ...look,
    query: stampQueryWarehouseTarget(look.query, exploreTargetsByKey),
  });
}

function warehouseTargetWarnings(explores: StagedExploreFile[]): StagedLookerFetchIssue[] {
  const unmapped = new Map<string, string[]>();
  const warnings: StagedLookerFetchIssue[] = [];

  for (const explore of explores) {
    const targetTable = explore.targetTable;
    if (!targetTable || targetTable.ok) {
      continue;
    }

    const sourceKey = exploreKey(explore.modelName, explore.exploreName);
    const lookerConnectionName = explore.connectionName ?? 'missing_connection_name';

    if (targetTable.reason === 'no_connection_mapping') {
      const existing = unmapped.get(lookerConnectionName) ?? [];
      existing.push(sourceKey);
      unmapped.set(lookerConnectionName, existing);
      continue;
    }

    warnings.push({
      rawPath: `looker_connection_mappings/${safeWarningPathSegment(lookerConnectionName)}`,
      entityType: 'looker_connection_mapping',
      entityId: explore.connectionName,
      severity: 'warning',
      statusCode: null,
      message: `Looker explore ${sourceKey} has sql_table_name that cannot be mapped to a physical warehouse table: ${targetTable.reason}.`,
      retryRecommended: false,
      kind: warningKindForReason(targetTable.reason),
      details: {
        lookerConnectionName,
        rawSqlTableName: explore.rawSqlTableName,
        reason: targetTable.reason,
      },
    });
  }

  for (const [lookerConnectionName, affectedExplores] of [...unmapped.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sortedAffectedExplores = [...affectedExplores].sort();
    warnings.push({
      rawPath: `looker_connection_mappings/${safeWarningPathSegment(lookerConnectionName)}`,
      entityType: 'looker_connection_mapping',
      entityId: lookerConnectionName === 'missing_connection_name' ? null : lookerConnectionName,
      severity: 'warning',
      statusCode: null,
      message: `Looker connection ${lookerConnectionName} is not mapped to a warehouse connection; ${sortedAffectedExplores.length} explore${sortedAffectedExplores.length === 1 ? '' : 's'} will be wiki-only.`,
      retryRecommended: false,
      kind: 'unmapped_looker_connection',
      details: {
        lookerConnectionName,
        affectedExplores: sortedAffectedExplores,
      },
    });
  }

  return warnings;
}

function warningKindForReason(reason: ParsedTargetTableFailureReason): StagedLookerFetchIssue['kind'] {
  if (reason === 'looker_template_unresolved') {
    return 'looker_template_unresolved';
  }
  if (reason === 'derived_table_not_supported') {
    return 'derived_table_not_supported';
  }
  return 'unparseable_sql_table_name';
}

function safeWarningPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function issueForFetchError(input: {
  rawPath: string;
  entityType: StagedLookerFetchIssue['entityType'];
  entityId: string | null;
  error: unknown;
  severity?: StagedLookerFetchIssue['severity'];
}): StagedLookerFetchIssue {
  const statusCode = errorStatusCode(input.error);
  return {
    rawPath: input.rawPath,
    entityType: input.entityType,
    entityId: input.entityId,
    severity: input.severity ?? (input.entityType === 'signals' ? 'warning' : 'error'),
    statusCode,
    message: errorMessage(input.error),
    retryRecommended: statusCode === 429,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const record = error as Record<string, unknown>;
  const direct = record.statusCode ?? record.status;
  if (typeof direct === 'number') {
    return direct;
  }
  if (typeof direct === 'string') {
    const parsed = Number(direct);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const response = record.response;
  if (response && typeof response === 'object') {
    return errorStatusCode(response);
  }
  return null;
}

function buildFetchReport(
  skipped: StagedLookerFetchIssue[],
  warnings: StagedLookerFetchIssue[],
): StagedLookerFetchReport {
  const retryRecommended = [...skipped, ...warnings].some((issue) => issue.retryRecommended);
  const hasWarehouseTargetWarnings = warnings.some((issue) => issue.entityType === 'looker_connection_mapping');
  return {
    status: skipped.length > 0 || hasWarehouseTargetWarnings ? 'partial' : 'success',
    retryRecommended,
    skipped,
    warnings,
  };
}
