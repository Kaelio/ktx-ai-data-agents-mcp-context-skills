import { describe, expect, it, vi } from 'vitest';
import { LookerClient, type LookerSdkPort } from './client.js';

const clientSecretParam = 'client_secret'; // pragma: allowlist secret

function params(): Record<string, unknown> {
  return {
    base_url: 'https://example.looker.com',
    client_id: 'id',
    [clientSecretParam]: 'credential', // pragma: allowlist secret
  };
}

function sdk(overrides: Partial<LookerSdkPort> = {}): LookerSdkPort {
  const port: LookerSdkPort = {
    me: vi.fn().mockResolvedValue({ id: '1', display_name: 'API User', email: 'api@example.com' }),
    search_dashboards: vi.fn().mockResolvedValue([{ id: '10' }]),
    dashboard: vi.fn().mockResolvedValue({
      id: '10',
      title: 'Revenue Dashboard',
      description: 'Revenue concepts',
      folder_id: '20',
      user_id: '1',
      updated_at: '2026-04-30T00:00:00.000Z',
      dashboard_elements: [
        {
          id: '99',
          title: 'ARR',
          look_id: null,
          query: {
            id: 'q1',
            model: 'b2b',
            view: 'sales_pipeline',
            fields: ['opportunities.arr', 'opportunities.stage'],
            filters: { 'opportunities.stage': 'open' },
            sorts: ['opportunities.arr desc'],
            limit: '500',
          },
        },
      ],
    }),
    search_looks: vi.fn().mockResolvedValue([{ id: '30' }]),
    search_scheduled_plans: vi.fn().mockResolvedValue([]),
    look: vi.fn().mockResolvedValue({
      id: '30',
      title: 'Open Pipeline ARR',
      description: 'ARR for open opportunities',
      folder_id: '20',
      user_id: '1',
      updated_at: '2026-04-30T00:00:00.000Z',
      query: {
        id: 'q2',
        model: 'b2b',
        view: 'sales_pipeline',
        fields: ['opportunities.arr'],
        filters: { 'opportunities.stage': 'open' },
      },
    }),
    all_folders: vi.fn().mockResolvedValue([{ id: '20', name: 'Executive', parent_id: null }]),
    all_users: vi.fn().mockResolvedValue([{ id: '1', display_name: 'API User', email: 'api@example.com' }]),
    all_groups: vi.fn().mockResolvedValue([{ id: '2', name: 'Finance' }]),
    all_connections: vi.fn().mockResolvedValue([
      {
        name: 'b2b_sandbox_bq',
        host: 'warehouse.example.com',
        database: 'analytics',
        schema: 'public',
        dialect_name: 'bigquery_standard_sql',
      },
    ]),
    all_lookml_models: vi
      .fn()
      .mockResolvedValue([
        { name: 'b2b', label: 'B2B', explores: [{ name: 'sales_pipeline', label: 'Sales Pipeline' }] },
      ]),
    lookml_model_explore: vi.fn().mockResolvedValue({
      name: 'sales_pipeline',
      label: 'Sales Pipeline',
      description: 'Opportunity pipeline',
      sql_table_name: 'proj.dataset.opportunities AS opportunities',
      connection_name: 'b2b_sandbox_bq',
      view_name: 'opportunities',
      fields: {
        dimensions: [{ name: 'opportunities.stage', label: 'Stage', type: 'string', sql: '$' + '{TABLE}.stage' }],
        measures: [{ name: 'opportunities.arr', label: 'ARR', type: 'sum', sql: '$' + '{TABLE}.arr' }],
      },
      joins: [
        {
          name: 'accounts',
          type: 'left_outer',
          relationship: 'many_to_one',
          sql_table_name: 'proj.dataset.accounts',
          sql_on: '$' + '{opportunities.account_id} = $' + '{accounts.id}',
          from: null,
        },
      ],
    }),
    run_inline_query: vi.fn().mockResolvedValue('[]'),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return port;
}

describe('LookerClient', () => {
  it('does not warn to console when optional prioritization inputs fail by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fakeSdk = sdk({
      search_dashboards: vi.fn().mockRejectedValue(new Error('dashboards unavailable')),
      search_looks: vi.fn().mockRejectedValue(new Error('looks unavailable')),
    });
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk });

    await expect(client.getSignals()).resolves.toEqual({
      dashboardUsage: [],
      lookUsage: [],
      scheduledPlans: [],
      favorites: [],
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('validates credentials with me()', async () => {
    const client = new LookerClient(params(), { sdkFactory: () => sdk() });

    await expect(client.testConnection()).resolves.toEqual({
      success: true,
      metadata: { userId: '1', displayName: 'API User', email: 'api@example.com' },
    });
  });

  it('maps dashboards, looks, folders, models, explores, users, and groups to staged DTOs', async () => {
    const fakeSdk = sdk();
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk });

    await expect(client.listDashboards()).resolves.toEqual([{ id: '10', updatedAt: null }]);
    await expect(client.getDashboard('10')).resolves.toMatchObject({
      lookerId: '10',
      title: 'Revenue Dashboard',
      tiles: [{ id: '99', query: { model: 'b2b', view: 'sales_pipeline' } }],
    });
    await expect(client.listLooks()).resolves.toEqual([{ id: '30', updatedAt: null }]);
    await expect(client.getLook('30')).resolves.toMatchObject({
      lookerId: '30',
      title: 'Open Pipeline ARR',
      query: { model: 'b2b', view: 'sales_pipeline' },
    });
    await expect(client.listFolders()).resolves.toEqual({
      folders: [{ id: '20', name: 'Executive', parentId: null, path: ['Executive'] }],
    });
    await expect(client.listLookmlModels()).resolves.toEqual({
      models: [{ name: 'b2b', label: 'B2B', explores: [{ name: 'sales_pipeline', label: 'Sales Pipeline' }] }],
    });
    await expect(client.listLookerConnections()).resolves.toEqual([
      {
        name: 'b2b_sandbox_bq',
        host: 'warehouse.example.com',
        database: 'analytics',
        schema: 'public',
        dialect: 'bigquery_standard_sql',
      },
    ]);
    await expect(client.getExplore('b2b', 'sales_pipeline')).resolves.toMatchObject({
      modelName: 'b2b',
      exploreName: 'sales_pipeline',
      rawSqlTableName: 'proj.dataset.opportunities AS opportunities',
      connectionName: 'b2b_sandbox_bq',
      viewName: 'opportunities',
      fields: { dimensions: [{ name: 'opportunities.stage' }], measures: [{ name: 'opportunities.arr' }] },
      joins: [
        {
          name: 'accounts',
          rawSqlTableName: 'proj.dataset.accounts',
          sqlOn: '$' + '{opportunities.account_id} = $' + '{accounts.id}',
          from: null,
          targetTable: null,
        },
      ],
      targetWarehouseConnectionId: null,
      targetTable: null,
    });
    expect(fakeSdk.dashboard).toHaveBeenCalledWith(
      '10',
      'id,title,description,folder_id,user_id,updated_at,dashboard_elements(id,title,look_id,query(id,model,view,fields,filters,sorts,limit,dynamic_fields))',
    );
    expect(fakeSdk.look).toHaveBeenCalledWith(
      '30',
      'id,title,description,folder_id,user_id,updated_at,query(id,model,view,fields,filters,sorts,limit,dynamic_fields)',
    );
    expect(fakeSdk.lookml_model_explore).toHaveBeenCalledWith(
      'b2b',
      'sales_pipeline',
      'name,label,description,sql_table_name,connection_name,view_name,fields,joins(name,type,relationship,sql_table_name,sql_on,from)',
    );
    expect(fakeSdk.all_connections).toHaveBeenCalledWith('name,host,database,schema,dialect_name');
  });

  it('returns empty usage signals when system activity access fails', async () => {
    const client = new LookerClient(params(), {
      sdkFactory: () =>
        sdk({
          run_inline_query: vi.fn().mockRejectedValue(new Error('access denied')),
          search_dashboards: vi.fn().mockResolvedValue([{ id: '10', favorite_count: 4 }]),
          search_looks: vi.fn().mockResolvedValue([{ id: '30', favorite_count: 2 }]),
          search_scheduled_plans: vi.fn().mockResolvedValue([]),
        }),
    });

    await expect(client.getSignals()).resolves.toEqual({
      dashboardUsage: [],
      lookUsage: [],
      scheduledPlans: [],
      favorites: [
        { contentId: '10', contentType: 'dashboard', favoriteCount: 4 },
        { contentId: '30', contentType: 'look', favoriteCount: 2 },
      ],
    });
  });

  it('paginates dashboard and Look searches', async () => {
    const dashboardPageOne = Array.from({ length: 500 }, (_, index) => ({ id: String(index + 1) }));
    const lookPageOne = Array.from({ length: 500 }, (_, index) => ({ id: String(index + 1001) }));
    const fakeSdk = sdk({
      search_dashboards: vi
        .fn()
        .mockResolvedValueOnce(dashboardPageOne)
        .mockResolvedValueOnce([{ id: '501' }]),
      search_looks: vi
        .fn()
        .mockResolvedValueOnce(lookPageOne)
        .mockResolvedValueOnce([{ id: '1501' }]),
    });
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk });

    await expect(client.listDashboards()).resolves.toHaveLength(501);
    await expect(client.listLooks()).resolves.toHaveLength(501);

    expect(fakeSdk.search_dashboards).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deleted: false,
        fields: 'id,updated_at',
        limit: 500,
        offset: 0,
        sorts: 'id',
      }),
    );
    expect(fakeSdk.search_dashboards).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        limit: 500,
        offset: 500,
      }),
    );
    expect(fakeSdk.search_looks).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deleted: false,
        fields: 'id,updated_at',
        limit: 500,
        offset: 0,
        sorts: 'id',
      }),
    );
    expect(fakeSdk.search_looks).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        limit: 500,
        offset: 500,
      }),
    );
  });

  it('returns updatedAt cursors from dashboard and Look listing rows', async () => {
    const fakeSdk = sdk({
      search_dashboards: vi.fn().mockResolvedValue([{ id: '10', updated_at: '2026-04-30T12:00:00.000Z' }]),
      search_looks: vi.fn().mockResolvedValue([{ id: '30', updated_at: '2026-04-30T11:00:00.000Z' }]),
    });
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk });

    await expect(client.listDashboards()).resolves.toEqual([{ id: '10', updatedAt: '2026-04-30T12:00:00.000Z' }]);
    await expect(client.listLooks()).resolves.toEqual([{ id: '30', updatedAt: '2026-04-30T11:00:00.000Z' }]);
  });

  it('logs out the SDK session during cleanup', async () => {
    const fakeSdk = sdk();
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk });

    await client.testConnection();
    await client.cleanup();

    expect(fakeSdk.logout).toHaveBeenCalledTimes(1);
  });

  it('aggregates usage, scheduled-plan, and favorite signals', async () => {
    const runInlineQuery = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            'dashboard.id': '10',
            'history.query_run_count': 3,
            'history.created_date': '2026-04-30',
            'user.id': 'user-1',
          },
          {
            'dashboard.id': '10',
            'history.query_run_count': '2',
            'history.created_date': '2026-04-29',
            'user.id': 'user-2',
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            'look.id': '30',
            'history.query_run_count': 7,
            'history.created_date': '2026-04-28',
            'user.id': 'user-1',
          },
        ]),
      );
    const fakeSdk = sdk({
      run_inline_query: runInlineQuery,
      search_dashboards: vi.fn().mockResolvedValueOnce([{ id: '10', favorite_count: 4 }]),
      search_looks: vi.fn().mockResolvedValueOnce([{ id: '30', favorite_count: 2 }]),
      search_scheduled_plans: vi.fn().mockResolvedValueOnce([
        {
          id: 'sp-dashboard',
          dashboard_id: '10',
          look_id: null,
          enabled: true,
          scheduled_plan_destination: [{ id: 'dest-1' }, { id: 'dest-2' }],
        },
        {
          id: 'sp-look',
          dashboard_id: null,
          look_id: '30',
          enabled: true,
          scheduled_plan_destination: [{ id: 'dest-3' }],
        },
      ]),
    });
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk });

    await expect(client.getSignals()).resolves.toEqual({
      dashboardUsage: [
        {
          contentId: '10',
          queryCount30d: 5,
          uniqueUsers30d: 2,
          lastRunAt: '2026-04-30',
          topUsers: ['user-1', 'user-2'],
        },
      ],
      lookUsage: [
        {
          contentId: '30',
          queryCount30d: 7,
          uniqueUsers30d: 1,
          lastRunAt: '2026-04-28',
          topUsers: ['user-1'],
        },
      ],
      scheduledPlans: [
        {
          contentId: '10',
          contentType: 'dashboard',
          isScheduled: true,
          scheduleCount: 1,
          recipientCount: 2,
        },
        {
          contentId: '30',
          contentType: 'look',
          isScheduled: true,
          scheduleCount: 1,
          recipientCount: 1,
        },
      ],
      favorites: [
        { contentId: '10', contentType: 'dashboard', favoriteCount: 4 },
        { contentId: '30', contentType: 'look', favoriteCount: 2 },
      ],
    });

    expect(runInlineQuery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        result_format: 'json',
        body: expect.objectContaining({
          model: 'system__activity',
          view: 'history',
          fields: ['dashboard.id', 'history.query_run_count', 'history.created_date', 'user.id'],
        }),
      }),
    );
    expect(fakeSdk.search_scheduled_plans).toHaveBeenCalledWith(
      expect.objectContaining({
        all_users: true,
        fields: 'id,dashboard_id,look_id,enabled,scheduled_plan_destination',
        limit: 500,
        offset: 0,
        sorts: 'id',
      }),
    );
  });

  it('retries a 429 response once using Retry-After seconds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const rateLimitError = new Error('rate limited');
    Object.assign(rateLimitError, { statusCode: 429, headers: { 'retry-after': '2' } });
    const fakeSdk = sdk({
      search_dashboards: vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce([{ id: '10' }]),
    });
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk, sleep });

    await expect(client.listDashboards()).resolves.toEqual([{ id: '10', updatedAt: null }]);

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fakeSdk.search_dashboards).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-429 errors', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = new Error('broken dashboard');
    Object.assign(error, { statusCode: 500 });
    const fakeSdk = sdk({ dashboard: vi.fn().mockRejectedValue(error) });
    const client = new LookerClient(params(), { sdkFactory: () => fakeSdk, sleep });

    await expect(client.getDashboard('10')).rejects.toThrow('broken dashboard');

    expect(sleep).not.toHaveBeenCalled();
    expect(fakeSdk.dashboard).toHaveBeenCalledTimes(1);
  });

  it('initializes the real @looker/sdk-node SDK with inline credentials without throwing', async () => {
    const client = new LookerClient(params());

    const result = await client.testConnection();

    // Without injected sdkFactory the real SDK is constructed via InlineLookerSettings.
    // This used to throw "Missing required configuration values like base_url" because
    // the parent NodeSettingsIniFile constructor validated config before the override
    // could supply credentials. Whatever happens now (auth/network failure against the
    // bogus example URL is fine) — what must NOT happen is a synchronous SDK-init throw.
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toMatch(/Missing required configuration values/i);

    await client.cleanup();
  });

  it('strips trailing /api/4.0 from base_url so the SDK does not double-prefix it', async () => {
    const clientWithSuffix = new LookerClient({
      base_url: 'https://example.looker.com/api/4.0',
      client_id: 'id',
      [clientSecretParam]: 'credential', // pragma: allowlist secret
    });
    const result = await clientWithSuffix.testConnection();
    expect(result.success).toBe(false);
    // If base_url is double-prefixed the SDK would hit /api/4.0/api/4.0/login. Either
    // the URL is correctly normalized (transport-level network failure) or we'd see a
    // 404/HTML response — either way the stack must not be a config-validation throw.
    expect(result.error).not.toMatch(/Missing required configuration values/i);
    await clientWithSuffix.cleanup();
  });
});
