import { describe, expect, it, vi } from 'vitest';
import type { FetchContext } from '../../types.js';
import type { LookerSdkPort } from './client.js';
import {
  DefaultLookerClientFactory,
  DefaultLookerConnectionClientFactory,
  type LookerCredentialResolver,
} from './factory.js';
import type { LookerRuntimeClient } from './fetch.js';
import type { LookerPullConfig } from './types.js';

function sdk(): LookerSdkPort {
  return {
    me: vi.fn().mockResolvedValue({ id: '1', display_name: 'API User', email: 'api@example.com' }),
    search_dashboards: vi.fn().mockResolvedValue([{ id: '10' }]),
    dashboard: vi.fn(),
    search_looks: vi.fn().mockResolvedValue([]),
    search_scheduled_plans: vi.fn().mockResolvedValue([]),
    look: vi.fn(),
    all_folders: vi.fn().mockResolvedValue([]),
    all_users: vi.fn().mockResolvedValue([]),
    all_groups: vi.fn().mockResolvedValue([]),
    all_connections: vi.fn().mockResolvedValue([]),
    all_lookml_models: vi.fn().mockResolvedValue([]),
    lookml_model_explore: vi.fn(),
    run_inline_query: vi.fn().mockResolvedValue('[]'),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DefaultLookerConnectionClientFactory', () => {
  it('resolves credentials by Looker connection id and creates a KTX Looker client', async () => {
    const fakeSdk = sdk();
    const resolver: LookerCredentialResolver = {
      resolve: vi.fn().mockResolvedValue({
        base_url: 'https://example.looker.com',
        client_id: 'id',
        client_secret: 'credential', // pragma: allowlist secret
      }),
    };
    const factory = new DefaultLookerConnectionClientFactory(resolver, { sdkFactory: () => fakeSdk });

    const client = await factory.createClient('prod-looker');

    await expect(client.listDashboards()).resolves.toEqual([{ id: '10', updatedAt: null }]);
    expect(resolver.resolve).toHaveBeenCalledWith('prod-looker');
  });
});

describe('DefaultLookerClientFactory', () => {
  const ctx: FetchContext = { connectionId: 'ctx-looker', sourceKey: 'looker' };

  it('uses pullConfig.lookerConnectionId when present', async () => {
    const runtimeClient = { listDashboards: vi.fn() } as unknown as LookerRuntimeClient;
    const inner = { createClient: vi.fn().mockResolvedValue(runtimeClient) };
    const factory = new DefaultLookerClientFactory(inner);
    const config = { lookerConnectionId: 'prod-looker' } as LookerPullConfig;

    await expect(factory.createClient(config, ctx)).resolves.toBe(runtimeClient);

    expect(inner.createClient).toHaveBeenCalledWith('prod-looker');
  });

  it('falls back to ctx.connectionId when pullConfig.lookerConnectionId is absent', async () => {
    const runtimeClient = { listDashboards: vi.fn() } as unknown as LookerRuntimeClient;
    const inner = { createClient: vi.fn().mockResolvedValue(runtimeClient) };
    const factory = new DefaultLookerClientFactory(inner);
    const config = {} as LookerPullConfig;

    await expect(factory.createClient(config, ctx)).resolves.toBe(runtimeClient);

    expect(inner.createClient).toHaveBeenCalledWith('ctx-looker');
  });
});
