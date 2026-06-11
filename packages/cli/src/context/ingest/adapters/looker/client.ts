import type {
  IRequestRunInlineQuery,
  IRequestSearchDashboards,
  IRequestSearchLooks,
  IRequestSearchScheduledPlans,
} from '@looker/sdk';
import type { IApiSection, IApiSettings } from '@looker/sdk-rtl';
import { LookerNodeSDK, NodeSettings } from '@looker/sdk-node';
import type { LookerRuntimeClient } from './fetch.js';
import type {
  StagedDashboardFile,
  StagedExploreFile,
  StagedFoldersTreeFile,
  StagedGroupFile,
  StagedLookerQuery,
  StagedLookerSignalsFile,
  StagedLookFile,
  StagedLookmlModelsFile,
  StagedUserFile,
} from './types.js';

type LookerRecord = Record<string, unknown>;

export interface TestConnectionResult {
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface LookerConnectionParams extends Record<string, unknown> {
  base_url: string;
  client_id: string;
  client_secret: string;
}

export interface LookerWarehouseConnectionInfo {
  name: string;
  host: string | null;
  database: string | null;
  schema: string | null;
  dialect: string | null;
}

const LOOKER_PAGE_SIZE = 500;
const LOOKER_DASHBOARD_FIELDS =
  'id,title,description,folder_id,user_id,updated_at,dashboard_elements(id,title,look_id,query(id,model,view,fields,filters,sorts,limit,dynamic_fields))';
const LOOKER_LOOK_FIELDS =
  'id,title,description,folder_id,user_id,updated_at,query(id,model,view,fields,filters,sorts,limit,dynamic_fields)';
const LOOKER_EXPLORE_FIELDS =
  'name,label,description,sql_table_name,connection_name,view_name,fields,joins(name,type,relationship,sql_table_name,sql_on,from)';

export interface LookerSdkPort {
  me(fields?: string): Promise<LookerRecord>;
  search_dashboards(request?: LookerRecord): Promise<LookerRecord[]>;
  dashboard(id: string, fields?: string): Promise<LookerRecord>;
  search_looks(request?: LookerRecord): Promise<LookerRecord[]>;
  search_scheduled_plans(request?: LookerRecord): Promise<LookerRecord[]>;
  look(id: string, fields?: string): Promise<LookerRecord>;
  all_folders(fields?: string): Promise<LookerRecord[]>;
  all_users(fields?: string): Promise<LookerRecord[]>;
  all_groups(fields?: string): Promise<LookerRecord[]>;
  all_connections(fields?: string): Promise<LookerRecord[]>;
  all_lookml_models(fields?: string): Promise<LookerRecord[]>;
  lookml_model_explore(modelName: string, exploreName: string, fields?: string): Promise<LookerRecord>;
  run_inline_query(request: IRequestRunInlineQuery): Promise<string>;
  logout(): Promise<void>;
}

export interface LookerClientLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface LookerClientDeps {
  sdkFactory?: (params: LookerConnectionParams) => LookerSdkPort;
  sleep?: (ms: number) => Promise<void>;
  logger?: LookerClientLogger;
}

const defaultLogger: LookerClientLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

class InlineLookerSettings extends NodeSettings {
  constructor(private readonly params: LookerConnectionParams) {
    // @looker/sdk-rtl boundary: NodeSettings consumes a string-valued config
    // section (read back via the readConfig override below), but its constructor
    // is typed to accept a fully-realized IApiSettings. The string record is the
    // shape the library actually reads, so narrow to IApiSection first.
    const settings: IApiSection = {
      base_url: normalizeBaseUrl(params.base_url),
      client_id: params.client_id,
      client_secret: params.client_secret, // pragma: allowlist secret
      verify_ssl: 'true',
      timeout: '120',
    };
    super('', settings as IApiSection & IApiSettings);
  }

  override readConfig(_section?: string): IApiSection {
    return {
      base_url: normalizeBaseUrl(this.params.base_url),
      client_id: this.params.client_id,
      client_secret: this.params.client_secret, // pragma: allowlist secret
      verify_ssl: 'true',
      timeout: '120',
    };
  }
}

function createLookerSdkPort(params: LookerConnectionParams): LookerSdkPort {
  const sdk = LookerNodeSDK.init40(new InlineLookerSettings(params));
  return {
    me: (fields) => sdk.ok(sdk.me(fields)).then(toRecord),
    search_dashboards: (request) =>
      sdk.ok(sdk.search_dashboards((request ?? {}) as IRequestSearchDashboards)).then(toRecordArray),
    dashboard: (id, fields) => sdk.ok(sdk.dashboard(id, fields)).then(toRecord),
    search_looks: (request) => sdk.ok(sdk.search_looks((request ?? {}) as IRequestSearchLooks)).then(toRecordArray),
    search_scheduled_plans: (request) =>
      sdk.ok(sdk.search_scheduled_plans((request ?? {}) as IRequestSearchScheduledPlans)).then(toRecordArray),
    look: (id, fields) => sdk.ok(sdk.look(id, fields)).then(toRecord),
    all_folders: (fields) => sdk.ok(sdk.all_folders(fields)).then(toRecordArray),
    all_users: (fields) => sdk.ok(sdk.all_users({ fields })).then(toRecordArray),
    all_groups: (fields) => sdk.ok(sdk.all_groups({ fields })).then(toRecordArray),
    all_connections: (fields) => sdk.ok(sdk.all_connections(fields)).then(toRecordArray),
    all_lookml_models: (fields) => sdk.ok(sdk.all_lookml_models({ fields })).then(toRecordArray),
    lookml_model_explore: (modelName, exploreName, fields) =>
      sdk
        .ok(sdk.lookml_model_explore({ lookml_model_name: modelName, explore_name: exploreName, fields }))
        .then(toRecord),
    run_inline_query: (request) => sdk.ok(sdk.run_inline_query(request)),
    logout: async () => {
      await sdk.authSession.logout();
    },
  };
}

export class LookerClient implements LookerRuntimeClient {
  private readonly logger: LookerClientLogger;
  private readonly params: LookerConnectionParams;
  private sdkInstance: LookerSdkPort | null = null;

  constructor(
    connectionParams: Record<string, unknown>,
    private readonly deps: LookerClientDeps = {},
  ) {
    this.logger = deps.logger ?? defaultLogger;
    this.params = parseLookerConnectionParams(connectionParams);
  }

  get dataSourceType(): string {
    return 'LOOKER';
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const me = await this.withRateLimitRetry(() => this.sdk().me('id,display_name,email'));
      return {
        success: true,
        metadata: {
          userId: stringValue(me.id),
          displayName: nullableString(me.display_name),
          email: nullableString(me.email),
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listDashboards(): Promise<Array<{ id: string; updatedAt: string | null }>> {
    const dashboards = await this.collectPaged((offset) =>
      this.sdk().search_dashboards({
        deleted: false,
        fields: 'id,updated_at',
        limit: LOOKER_PAGE_SIZE,
        offset,
        sorts: 'id',
      }),
    );
    return dashboards.flatMap(entityRef);
  }

  async getDashboard(id: string): Promise<StagedDashboardFile> {
    const dashboard = await this.withRateLimitRetry(() => this.sdk().dashboard(id, LOOKER_DASHBOARD_FIELDS));
    const elements = arrayValue(dashboard.dashboard_elements);
    return {
      lookerId: stringValue(dashboard.id),
      title: stringValue(dashboard.title),
      description: nullableString(dashboard.description),
      folderId: nullableString(dashboard.folder_id),
      ownerId: nullableString(dashboard.user_id),
      updatedAt: nullableString(dashboard.updated_at),
      tiles: elements.map((tile) => ({
        id: stringValue(tile.id),
        title: nullableString(tile.title),
        lookId: nullableString(tile.look_id),
        query: queryValue(tile.query),
      })),
    };
  }

  async listLooks(): Promise<Array<{ id: string; updatedAt: string | null }>> {
    const looks = await this.collectPaged((offset) =>
      this.sdk().search_looks({
        deleted: false,
        fields: 'id,updated_at',
        limit: LOOKER_PAGE_SIZE,
        offset,
        sorts: 'id',
      }),
    );
    return looks.flatMap(entityRef);
  }

  async getLook(id: string): Promise<StagedLookFile> {
    const look = await this.withRateLimitRetry(() => this.sdk().look(id, LOOKER_LOOK_FIELDS));
    return {
      lookerId: stringValue(look.id),
      title: stringValue(look.title),
      description: nullableString(look.description),
      folderId: nullableString(look.folder_id),
      ownerId: nullableString(look.user_id),
      updatedAt: nullableString(look.updated_at),
      query: queryValue(look.query),
    };
  }

  async listFolders(): Promise<StagedFoldersTreeFile> {
    const folders = await this.withRateLimitRetry(() => this.sdk().all_folders('id,name,parent_id'));
    const byId = new Map<string, LookerRecord>();
    for (const folder of folders) {
      byId.set(stringValue(folder.id), folder);
    }
    return {
      folders: folders.map((folder) => ({
        id: stringValue(folder.id),
        name: stringValue(folder.name),
        parentId: nullableString(folder.parent_id),
        path: folderPath(folder, byId),
      })),
    };
  }

  async listUsers(): Promise<StagedUserFile[]> {
    const users = await this.withRateLimitRetry(() => this.sdk().all_users('id,display_name,email'));
    return users.map((user) => ({
      id: stringValue(user.id),
      displayName: nullableString(user.display_name),
      email: nullableString(user.email),
    }));
  }

  async listGroups(): Promise<StagedGroupFile[]> {
    const groups = await this.withRateLimitRetry(() => this.sdk().all_groups('id,name'));
    return groups.map((group) => ({
      id: stringValue(group.id),
      name: stringValue(group.name),
    }));
  }

  async listLookmlModels(): Promise<StagedLookmlModelsFile> {
    const models = await this.withRateLimitRetry(() => this.sdk().all_lookml_models('name,label,explores'));
    return {
      models: models.map((model) => ({
        name: stringValue(model.name),
        label: nullableString(model.label),
        explores: arrayValue(model.explores).map((explore) => ({
          name: stringValue(explore.name),
          label: nullableString(explore.label),
        })),
      })),
    };
  }

  async listLookerConnections(): Promise<LookerWarehouseConnectionInfo[]> {
    const connections = await this.withRateLimitRetry(() =>
      this.sdk().all_connections('name,host,database,schema,dialect_name'),
    );
    return connections.map((connection) => ({
      name: stringValue(connection.name),
      host: nullableString(connection.host),
      database: nullableString(connection.database),
      schema: nullableString(connection.schema),
      dialect: nullableString(connection.dialect_name ?? connection.dialect),
    }));
  }

  async getExplore(modelName: string, exploreName: string): Promise<StagedExploreFile> {
    const explore = await this.withRateLimitRetry(() =>
      this.sdk().lookml_model_explore(modelName, exploreName, LOOKER_EXPLORE_FIELDS),
    );
    const fields = recordValue(explore.fields);
    return {
      modelName,
      exploreName: stringValue(explore.name),
      label: nullableString(explore.label),
      description: nullableString(explore.description),
      rawSqlTableName: nullableString(explore.sql_table_name ?? explore.sqlTableName),
      connectionName: nullableString(explore.connection_name ?? explore.connectionName),
      viewName: nullableString(explore.view_name ?? explore.viewName),
      fields: {
        dimensions: arrayValue(fields.dimensions).map(stagedField),
        measures: arrayValue(fields.measures).map(stagedField),
      },
      joins: arrayValue(explore.joins).map((join) => ({
        name: stringValue(join.name),
        type: nullableString(join.type),
        relationship: nullableString(join.relationship),
        rawSqlTableName: nullableString(join.sql_table_name ?? join.sqlTableName),
        sqlOn: nullableString(join.sql_on ?? join.sqlOn),
        from: nullableString(join.from),
        targetTable: null,
      })),
      targetWarehouseConnectionId: null,
      targetTable: null,
    };
  }

  async getSignals(): Promise<StagedLookerSignalsFile> {
    const [dashboardUsage, lookUsage, scheduledPlans, favorites] = await Promise.all([
      this.getUsageSignals('dashboard').catch((error) =>
        this.warnAndReturnEmpty('Looker system__activity dashboard usage unavailable', error),
      ),
      this.getUsageSignals('look').catch((error) =>
        this.warnAndReturnEmpty('Looker system__activity Look usage unavailable', error),
      ),
      this.getScheduledPlanSignals().catch((error) =>
        this.warnAndReturnEmpty('Looker scheduled-plan signals unavailable', error),
      ),
      this.getFavoriteSignals().catch((error) => this.warnAndReturnEmpty('Looker favorite signals unavailable', error)),
    ]);

    return { dashboardUsage, lookUsage, scheduledPlans, favorites };
  }

  async cleanup(): Promise<void> {
    const sdk = this.sdkInstance;
    if (!sdk) {
      return;
    }
    await sdk.logout();
    this.sdkInstance = null;
  }

  private async getUsageSignals(contentType: 'dashboard' | 'look'): Promise<StagedLookerSignalsFile['dashboardUsage']> {
    const idField = contentType === 'dashboard' ? 'dashboard.id' : 'look.id';
    const raw = await this.withRateLimitRetry(() =>
      this.sdk().run_inline_query({
        result_format: 'json',
        body: {
          model: 'system__activity',
          view: 'history',
          fields: [idField, 'history.query_run_count', 'history.created_date', 'user.id'],
          filters: {
            'history.created_date': '30 days',
            [idField]: '-NULL',
          },
          sorts: ['history.query_run_count desc'],
          limit: '5000',
        },
      }),
    );

    return aggregateUsageRows(parseJsonRows(raw), idField);
  }

  private async getScheduledPlanSignals(): Promise<StagedLookerSignalsFile['scheduledPlans']> {
    const plans = await this.collectPaged((offset) =>
      this.sdk().search_scheduled_plans({
        all_users: true,
        fields: 'id,dashboard_id,look_id,enabled,scheduled_plan_destination',
        limit: LOOKER_PAGE_SIZE,
        offset,
        sorts: 'id',
      }),
    );
    const byContent = new Map<
      string,
      {
        contentId: string;
        contentType: 'dashboard' | 'look';
        isScheduled: boolean;
        scheduleCount: number;
        recipientCount: number;
      }
    >();

    for (const plan of plans) {
      const dashboardId = nullableString(plan.dashboard_id);
      const lookId = nullableString(plan.look_id);
      const contentType = dashboardId ? 'dashboard' : lookId ? 'look' : null;
      const contentId = dashboardId ?? lookId;
      if (!contentType || !contentId) {
        continue;
      }
      const key = `${contentType}:${contentId}`;
      const current =
        byContent.get(key) ??
        ({
          contentId,
          contentType,
          isScheduled: false,
          scheduleCount: 0,
          recipientCount: 0,
        } satisfies StagedLookerSignalsFile['scheduledPlans'][number]);
      if (plan.enabled !== false) {
        current.isScheduled = true;
        current.scheduleCount += 1;
        current.recipientCount += arrayValue(plan.scheduled_plan_destination).length;
      }
      byContent.set(key, current);
    }

    return [...byContent.values()].filter((signal) => signal.scheduleCount > 0).sort(compareContentSignals);
  }

  private async getFavoriteSignals(): Promise<StagedLookerSignalsFile['favorites']> {
    const dashboards = await this.collectPaged((offset) =>
      this.sdk().search_dashboards({
        deleted: false,
        fields: 'id,favorite_count',
        limit: LOOKER_PAGE_SIZE,
        offset,
        sorts: 'id',
      }),
    );
    const looks = await this.collectPaged((offset) =>
      this.sdk().search_looks({
        deleted: false,
        fields: 'id,favorite_count',
        limit: LOOKER_PAGE_SIZE,
        offset,
        sorts: 'id',
      }),
    );

    return [
      ...dashboards.flatMap((dashboard) => favoriteSignal(dashboard, 'dashboard')),
      ...looks.flatMap((look) => favoriteSignal(look, 'look')),
    ].sort(compareContentSignals);
  }

  private warnAndReturnEmpty(message: string, error: unknown): never[] {
    this.logger.warn(`${message}; continuing without that prioritization input: ${errorMessage(error)}`);
    return [];
  }

  private async collectPaged(loadPage: (offset: number) => Promise<LookerRecord[]>): Promise<LookerRecord[]> {
    const rows: LookerRecord[] = [];
    for (let offset = 0; ; offset += LOOKER_PAGE_SIZE) {
      const page = await this.withRateLimitRetry(() => loadPage(offset));
      rows.push(...page);
      if (page.length < LOOKER_PAGE_SIZE) {
        return rows;
      }
    }
  }

  private async withRateLimitRetry<T>(load: () => Promise<T>): Promise<T> {
    try {
      return await load();
    } catch (error) {
      if (lookerStatusCode(error) !== 429) {
        throw error;
      }
      await (this.deps.sleep ?? sleep)(retryAfterMs(error));
      return load();
    }
  }

  private sdk(): LookerSdkPort {
    if (!this.sdkInstance) {
      this.sdkInstance = this.deps.sdkFactory?.(this.params) ?? createLookerSdkPort(this.params);
    }
    return this.sdkInstance;
  }
}

function parseLookerConnectionParams(raw: Record<string, unknown>): LookerConnectionParams {
  const baseUrl = raw.base_url;
  const clientId = raw.client_id;
  const apiCredential = raw.client_secret; // pragma: allowlist secret
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('Looker base_url is required');
  }
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new Error('Looker client_id is required');
  }
  if (typeof apiCredential !== 'string' || apiCredential.trim() === '') {
    throw new Error('Looker client_secret is required'); // pragma: allowlist secret
  }
  return { base_url: baseUrl, client_id: clientId, client_secret: apiCredential }; // pragma: allowlist secret
}

function toRecord(value: object): LookerRecord {
  return value as LookerRecord;
}

function toRecordArray(values: object[]): LookerRecord[] {
  return values.map(toRecord);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/(4\.0|3\.1)$/, '');
}

function entityRef(row: LookerRecord): Array<{ id: string; updatedAt: string | null }> {
  if (row.id === null || row.id === undefined) {
    return [];
  }
  return [{ id: String(row.id), updatedAt: nullableString(row.updated_at) }];
}

function queryValue(value: unknown): StagedLookerQuery | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as LookerRecord;
  if (typeof record.model !== 'string' || typeof record.view !== 'string') {
    return null;
  }
  return {
    id: nullableString(record.id) ?? undefined,
    model: record.model,
    view: record.view,
    fields: stringArray(record.fields),
    filters: recordValue(record.filters),
    sorts: stringArray(record.sorts),
    limit: typeof record.limit === 'string' || typeof record.limit === 'number' ? record.limit : null,
    dynamicFields: nullableString(record.dynamic_fields ?? record.dynamicFields),
    targetWarehouseConnectionId: null,
    targetTable: null,
  };
}

function parseJsonRows(raw: string): LookerRecord[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.filter((row): row is LookerRecord => !!row && typeof row === 'object') : [];
}

function aggregateUsageRows(
  rows: LookerRecord[],
  idField: 'dashboard.id' | 'look.id',
): StagedLookerSignalsFile['dashboardUsage'] {
  const byContent = new Map<
    string,
    {
      contentId: string;
      queryCount30d: number;
      lastRunAt: string | null;
      users: Set<string>;
    }
  >();

  for (const row of rows) {
    const contentId = nullableString(row[idField]);
    if (!contentId) {
      continue;
    }
    const current = byContent.get(contentId) ?? {
      contentId,
      queryCount30d: 0,
      lastRunAt: null,
      users: new Set<string>(),
    };
    current.queryCount30d += numberValue(row['history.query_run_count']);
    const userId = nullableString(row['user.id']);
    if (userId) {
      current.users.add(userId);
    }
    const lastRunAt = nullableString(row['history.created_date']);
    if (lastRunAt && (!current.lastRunAt || lastRunAt > current.lastRunAt)) {
      current.lastRunAt = lastRunAt;
    }
    byContent.set(contentId, current);
  }

  return [...byContent.values()]
    .map((signal) => ({
      contentId: signal.contentId,
      queryCount30d: signal.queryCount30d,
      uniqueUsers30d: signal.users.size,
      lastRunAt: signal.lastRunAt,
      topUsers: [...signal.users].sort().slice(0, 5),
    }))
    .sort((a, b) => a.contentId.localeCompare(b.contentId));
}

function favoriteSignal(row: LookerRecord, contentType: 'dashboard' | 'look'): StagedLookerSignalsFile['favorites'] {
  const contentId = nullableString(row.id);
  if (!contentId) {
    return [];
  }
  return [{ contentId, contentType, favoriteCount: numberValue(row.favorite_count) }];
}

function compareContentSignals(
  a: { contentType?: string; contentId: string },
  b: { contentType?: string; contentId: string },
): number {
  return `${a.contentType ?? ''}:${a.contentId}`.localeCompare(`${b.contentType ?? ''}:${b.contentId}`);
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function lookerStatusCode(error: unknown): number | null {
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
    return lookerStatusCode(response);
  }
  return null;
}

function retryAfterMs(error: unknown): number {
  const value = retryAfterHeader(error);
  if (!value) {
    return 1000;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 1000;
}

function retryAfterHeader(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const record = error as Record<string, unknown>;
  const response = record.response;
  const responseRecord = response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
  const headers = record.headers ?? responseRecord?.headers;
  if (!headers || typeof headers !== 'object') {
    return null;
  }
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = getter.call(headers, 'retry-after');
    return typeof value === 'string' ? value : null;
  }
  const headerRecord = headers as Record<string, unknown>;
  const direct = headerRecord['retry-after'] ?? headerRecord['Retry-After'];
  return typeof direct === 'string' ? direct : null;
}

function stagedField(value: LookerRecord) {
  return {
    name: stringValue(value.name),
    label: nullableString(value.label),
    type: nullableString(value.type),
    sql: nullableString(value.sql),
    description: nullableString(value.description),
  };
}

function folderPath(folder: LookerRecord, byId: Map<string, LookerRecord>): string[] {
  const path: string[] = [];
  let current: LookerRecord | undefined = folder;
  const seen = new Set<string>();
  while (current) {
    const id = stringValue(current.id);
    if (seen.has(id)) {
      break;
    }
    seen.add(id);
    path.unshift(stringValue(current.name));
    const parentId = nullableString(current.parent_id);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return path;
}

function arrayValue(value: unknown): LookerRecord[] {
  return Array.isArray(value) ? value.filter((item): item is LookerRecord => !!item && typeof item === 'object') : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}
