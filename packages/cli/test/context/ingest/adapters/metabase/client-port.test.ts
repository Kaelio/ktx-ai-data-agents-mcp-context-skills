import { describe, expect, it, vi } from 'vitest';
import type { FetchContext } from '../../../../../src/context/ingest/types.js';
import {
  IngestMetabaseClientFactory,
  type MetabaseCard,
  type MetabaseConnectionClientFactory,
  type MetabaseDatasetQuery,
  type MetabaseRuntimeClient,
  type MetabaseTemplateTag,
  type TestConnectionResult,
} from '../../../../../src/context/ingest/adapters/metabase/client-port.js';
import type { MetabasePullConfig } from '../../../../../src/context/ingest/adapters/metabase/types.js';

function makeRuntimeClient(): MetabaseRuntimeClient {
  return {
    testConnection: vi.fn(),
    getCurrentUser: vi.fn(),
    getDatabases: vi.fn(),
    getDatabase: vi.fn(),
    getCollectionTree: vi.fn(),
    getCollection: vi.fn(),
    getCollectionItems: vi.fn(),
    getCard: vi.fn(),
    getAllCards: vi.fn(),
    convertMbqlToNative: vi.fn(),
    getNativeSql: vi.fn(),
    getTemplateTags: vi.fn(),
    getCardSql: vi.fn(),
    getResolvedSql: vi.fn(),
    cleanup: vi.fn(),
  };
}

describe('IngestMetabaseClientFactory', () => {
  const config: MetabasePullConfig = {
    metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
    metabaseDatabaseId: 42,
  };

  const ctx: FetchContext = {
    connectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
    sourceKey: 'metabase',
  };

  it('delegates to the connection-level factory with the Metabase source connection id, not ctx.connectionId', async () => {
    const runtimeClient = makeRuntimeClient();
    const connectionFactory: MetabaseConnectionClientFactory = {
      createClient: vi.fn().mockResolvedValue(runtimeClient),
    };
    const factory = new IngestMetabaseClientFactory(connectionFactory);

    await expect(factory.createClient(config, ctx)).resolves.toBe(runtimeClient);

    expect(connectionFactory.createClient).toHaveBeenCalledTimes(1);
    expect(connectionFactory.createClient).toHaveBeenCalledWith(config.metabaseConnectionId);
    expect(connectionFactory.createClient).not.toHaveBeenCalledWith(ctx.connectionId);
  });

  it('supports synchronous connection-level factories', async () => {
    const runtimeClient = makeRuntimeClient();
    const connectionFactory: MetabaseConnectionClientFactory = {
      createClient: vi.fn().mockReturnValue(runtimeClient),
    };
    const factory = new IngestMetabaseClientFactory(connectionFactory);

    await expect(factory.createClient(config, ctx)).resolves.toBe(runtimeClient);
  });
});

it('allows the concrete client result shapes used by the relocated Metabase client', () => {
  const connectionResult: TestConnectionResult = {
    success: false,
    error: 'API key is invalid',
    metadata: { databases: [] },
  };
  expect(connectionResult.success).toBe(false);

  const templateTag: MetabaseTemplateTag = {
    id: 'tag-1',
    name: 'created_at',
    type: 'dimension',
    'display-name': 'Created At',
    'widget-type': 'date/range',
  };
  expect(templateTag['widget-type']).toBe('date/range');

  const datasetQuery: MetabaseDatasetQuery = {
    type: 'native',
    database: 42,
    stages: [
      {
        'lib/type': 'mbql.stage/native',
        native: 'SELECT * FROM orders WHERE created_at > {{ created_at }}',
        'template-tags': { created_at: templateTag },
      },
    ],
  };
  const card: MetabaseCard = {
    id: 1,
    name: 'Orders',
    type: 'model',
    query_type: 'native',
    database_id: 42,
    dataset_query: datasetQuery,
  };
  expect(card.dataset_query).toBe(datasetQuery);
});
