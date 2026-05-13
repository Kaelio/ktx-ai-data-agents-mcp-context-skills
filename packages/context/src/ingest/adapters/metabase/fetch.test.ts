import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchContext } from '../../types.js';
import { fetchMetabaseBundle } from './fetch.js';

const metabaseConnectionId = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const targetConnectionId = 'b2c3d4e5-f6a7-4890-abcd-ef0123456789';

function makeMockClient() {
  return {
    getAllCards: vi.fn().mockResolvedValue([
      { id: 1, name: 'Orders', archived: false, database_id: 42, collection_id: 5 },
      { id: 2, name: 'Old orders (archived)', archived: true, database_id: 42, collection_id: 5 },
      { id: 3, name: 'Wrong DB', archived: false, database_id: 999, collection_id: 5 },
    ]),
    getCard: vi.fn().mockImplementation((id: number) =>
      Promise.resolve({
        id,
        name: `Card ${id}`,
        description: null,
        type: 'model',
        database_id: 42,
        collection_id: 5,
        archived: false,
        result_metadata: [{ name: 'id', base_type: 'type/Integer' }],
      }),
    ),
    getResolvedSql: vi.fn().mockImplementation((card: { id: number }) =>
      Promise.resolve({
        resolvedSql: `SELECT * FROM card_${card.id}`,
        templateTags: [],
        resolutionStatus: 'resolved',
      }),
    ),
    getCollectionTree: vi.fn().mockResolvedValue([{ id: 5, name: 'Orders Team', parent_id: null, children: [] }]),
    getCollectionItems: vi.fn().mockResolvedValue([]),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

describe('fetchMetabaseBundle', () => {
  let stagedDir: string;
  let clientFactory: ReturnType<typeof makeClientFactory>;
  let sourceStateReader: ReturnType<typeof makeSourceStateReader>;

  function makeClientFactory() {
    const mockClient = makeMockClient();
    return {
      createClient: vi.fn().mockResolvedValue(mockClient),
      __client: mockClient,
    };
  }

  function makeFetchContext(connectionId = targetConnectionId): FetchContext {
    return {
      connectionId,
      sourceKey: 'metabase',
    };
  }

  function makeSourceStateReader() {
    return {
      getSourceState: vi.fn().mockResolvedValue({
        syncMode: 'ALL',
        selections: [],
        mappings: [
          {
            metabaseDatabaseId: 42,
            metabaseDatabaseName: 'Analytics',
            metabaseEngine: 'postgres',
            targetConnectionId: targetConnectionId,
            syncEnabled: true,
          },
        ],
        defaultTagNames: [],
      }),
    };
  }

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'mb-fetch-'));
    clientFactory = makeClientFactory();
    sourceStateReader = makeSourceStateReader();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('writes sync-config.json, one database file, one collection file, and only non-archived cards matching databaseId', async () => {
    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
    });
    const cardFiles = await readdir(join(stagedDir, 'cards'));
    expect(cardFiles.sort()).toEqual(['1.json']);
    const collections = await readdir(join(stagedDir, 'collections'));
    expect(collections).toEqual(['5.json']);
    const databases = await readdir(join(stagedDir, 'databases'));
    expect(databases).toEqual(['42.json']);
    const syncConfig = JSON.parse(await readFile(join(stagedDir, 'sync-config.json'), 'utf-8'));
    expect(syncConfig.metabaseDatabaseId).toBe(42);
    expect(syncConfig.mapping.targetConnectionId).toBe(targetConnectionId);

    const card = JSON.parse(await readFile(join(stagedDir, 'cards/1.json'), 'utf-8'));
    expect(card.metabaseId).toBe(1);
    expect(card.resolvedSql).toBe('SELECT * FROM card_1');
    expect(card.resolutionStatus).toBe('resolved');
    expect(card.collectionPath).toEqual(['Orders Team']);
    expect(card.archived).toBe(false);
  });

  it('does not write Metabase fetch progress to console by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
    });

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('routes Metabase fetch warnings through the injected logger', async () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
    };
    clientFactory.__client.getCard.mockRejectedValueOnce(new Error('card read failed'));

    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith('failed to load card 1: card read failed');
  });

  it('passes the Metabase source pull config and target fetch context to the client factory', async () => {
    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
    });

    expect(clientFactory.createClient).toHaveBeenCalledTimes(1);
    expect(clientFactory.createClient).toHaveBeenCalledWith(
      { metabaseConnectionId, metabaseDatabaseId: 42 },
      { connectionId: targetConnectionId, sourceKey: 'metabase' },
    );
  });

  it('reads source state by the Metabase source connection id, not the target fetch context connection id', async () => {
    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
    });

    expect(sourceStateReader.getSourceState).toHaveBeenCalledTimes(1);
    expect(sourceStateReader.getSourceState).toHaveBeenCalledWith(metabaseConnectionId);
    expect(sourceStateReader.getSourceState).not.toHaveBeenCalledWith(targetConnectionId);
  });

  it('cleans up the client after a successful fetch', async () => {
    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
    });

    expect(clientFactory.__client.cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up the client when fetch fails after client creation', async () => {
    clientFactory.__client.getCollectionTree.mockRejectedValueOnce(new Error('collection tree unavailable'));

    await expect(
      fetchMetabaseBundle({
        pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
        stagedDir,
        ctx: makeFetchContext(),
        clientFactory,
        sourceStateReader,
      }),
    ).rejects.toThrow('collection tree unavailable');

    expect(clientFactory.__client.cleanup).toHaveBeenCalledTimes(1);
  });

  it('throws BadRequestException when the requested metabaseDatabaseId has no matching sync-enabled mapping', async () => {
    sourceStateReader.getSourceState.mockResolvedValue({
      syncMode: 'ALL',
      selections: [],
      mappings: [],
      defaultTagNames: [],
    });
    await expect(
      fetchMetabaseBundle({
        pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
        stagedDir,
        ctx: makeFetchContext(),
        clientFactory,
        sourceStateReader,
      }),
    ).rejects.toThrow(/no sync-enabled mapping for database 42/);
  });

  it('throws BadRequestException when the mapping points to a different target connection than the job', async () => {
    sourceStateReader.getSourceState.mockResolvedValue({
      syncMode: 'ALL',
      selections: [],
      mappings: [
        {
          metabaseDatabaseId: 42,
          metabaseDatabaseName: 'Analytics',
          metabaseEngine: 'postgres',
          targetConnectionId: 'c3d4e5f6-a7b8-4901-bcde-f01234567890',
          syncEnabled: true,
        },
      ],
      defaultTagNames: [],
    });
    await expect(
      fetchMetabaseBundle({
        pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
        stagedDir,
        ctx: makeFetchContext(),
        clientFactory,
        sourceStateReader,
      }),
    ).rejects.toThrow(/mapping.*does not point to connection/);
  });

  it('throws when the matching mapping has a null metabaseDatabaseName (unhydrated)', async () => {
    sourceStateReader.getSourceState.mockResolvedValue({
      syncMode: 'ALL',
      selections: [],
      mappings: [
        {
          metabaseDatabaseId: 42,
          metabaseDatabaseName: null,
          metabaseEngine: 'postgres',
          targetConnectionId,
          syncEnabled: true,
        },
      ],
      defaultTagNames: [],
    });
    await expect(
      fetchMetabaseBundle({
        pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
        stagedDir,
        ctx: makeFetchContext(),
        clientFactory,
        sourceStateReader,
      }),
    ).rejects.toThrow(/unhydrated.*ktx setup/);
  });

  it('skips cards whose getResolvedSql returns null and records them in unresolved-cards.json', async () => {
    clientFactory.__client.getResolvedSql.mockResolvedValue(null);
    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
    });
    const cardFiles = await readdir(join(stagedDir, 'cards')).catch(() => []);
    expect(cardFiles).toEqual([]);
    const unresolved = JSON.parse(await readFile(join(stagedDir, 'unresolved-cards.json'), 'utf-8'));
    expect(unresolved).toEqual([expect.objectContaining({ cardId: 1, name: 'Card 1', reason: 'api_500' })]);
  });

  it('records referenced cards via `{{#N}}` in resolvedSql', async () => {
    clientFactory.__client.getResolvedSql.mockImplementation((card: { id: number }) =>
      Promise.resolve({
        resolvedSql: card.id === 1 ? 'SELECT * FROM {{#999}}' : `SELECT * FROM card_${card.id}`,
        templateTags: card.id === 1 ? [{ name: 'r', type: 'card', cardReference: 999 }] : [],
        resolutionStatus: 'resolved',
      }),
    );
    await fetchMetabaseBundle({
      pullConfig: { metabaseConnectionId, metabaseDatabaseId: 42 },
      stagedDir,
      ctx: makeFetchContext(),
      clientFactory,
      sourceStateReader,
    });
    const card = JSON.parse(await readFile(join(stagedDir, 'cards/1.json'), 'utf-8'));
    expect(card.referencedCardIds).toEqual([999]);
  });
});

/* eslint-disable @typescript-eslint/require-await -- mock fixtures return constants */
describe('fetchMetabaseBundle — scoped fetch', () => {
  it('ONLY scope fetches exactly the selected card ids (no reference closure)', async () => {
    const staged = await mkdtemp(join(tmpdir(), 'mb-fetch-only-'));
    try {
      const catalog = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => ({
        id,
        name: `Card ${id}`,
        type: 'model',
        database_id: 42,
        collection_id: 5,
        archived: false,
        result_metadata: [],
      }));
      const getCardCalls: number[] = [];
      const client: any = {
        getAllCards: async () =>
          catalog.map((c) => ({
            id: c.id,
            database_id: c.database_id,
            archived: false,
            collection_id: c.collection_id,
          })),
        getCard: async (id: number) => {
          getCardCalls.push(id);
          const c = catalog.find((x) => x.id === id);
          if (!c) {
            throw new Error(`no such card ${id}`);
          }
          return c;
        },
        getResolvedSql: async () => ({ resolvedSql: 'SELECT 1', templateTags: [], resolutionStatus: 'resolved' }),
        getCollectionTree: async () => [{ id: 5, name: 'Col5', parent_id: null }],
        getCollectionItems: async () => [],
        cleanup: async () => {},
      };
      await fetchMetabaseBundle({
        pullConfig: { metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678', metabaseDatabaseId: 42 },
        stagedDir: staged,
        ctx: { connectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789', sourceKey: 'metabase' },
        clientFactory: { createClient: () => client },
        sourceStateReader: {
          getSourceState: async () => ({
            syncMode: 'ONLY',
            selections: [
              { selectionType: 'item', metabaseObjectId: 2 },
              { selectionType: 'item', metabaseObjectId: 5 },
              { selectionType: 'item', metabaseObjectId: 8 },
            ],
            mappings: [
              {
                metabaseDatabaseId: 42,
                metabaseDatabaseName: 'Analytics',
                metabaseEngine: 'postgres',
                targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
                syncEnabled: true,
              },
            ],
            defaultTagNames: [],
          }),
        } as any,
      });
      expect([...getCardCalls].sort((a, b) => a - b)).toEqual([2, 5, 8]);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });

  it('ONLY scope walks collections via getCollectionItems', async () => {
    const staged = await mkdtemp(join(tmpdir(), 'mb-fetch-col-'));
    try {
      const getCardCalls: number[] = [];
      const collectionItems = [
        { id: 100, model: 'card' },
        { id: 101, model: 'card' },
      ];
      const client: any = {
        getAllCards: async () => [],
        getCard: async (id: number) => {
          getCardCalls.push(id);
          return {
            id,
            name: `Card ${id}`,
            type: 'model',
            database_id: 42,
            collection_id: 7,
            archived: false,
            result_metadata: [],
          };
        },
        getResolvedSql: async () => ({ resolvedSql: 'SELECT 1', templateTags: [], resolutionStatus: 'resolved' }),
        getCollectionTree: async () => [{ id: 7, name: 'Col7', parent_id: null }],
        getCollectionItems: async (cid: number) => (cid === 7 ? collectionItems : []),
        cleanup: async () => {},
      };
      await fetchMetabaseBundle({
        pullConfig: { metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678', metabaseDatabaseId: 42 },
        stagedDir: staged,
        ctx: { connectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789', sourceKey: 'metabase' },
        clientFactory: { createClient: () => client },
        sourceStateReader: {
          getSourceState: async () => ({
            syncMode: 'ONLY',
            selections: [{ selectionType: 'collection', metabaseObjectId: 7 }],
            mappings: [
              {
                metabaseDatabaseId: 42,
                metabaseDatabaseName: 'Analytics',
                metabaseEngine: 'postgres',
                targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
                syncEnabled: true,
              },
            ],
            defaultTagNames: [],
          }),
        } as any,
      });
      expect([...getCardCalls].sort((a, b) => a - b)).toEqual([100, 101]);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });

  it('ONLY scope closes over {{#N}} references, bounded', async () => {
    const staged = await mkdtemp(join(tmpdir(), 'mb-fetch-ref-'));
    try {
      const getCardCalls: number[] = [];
      const refs: Record<number, number[]> = { 1: [2], 2: [3], 3: [] };
      const client: any = {
        getAllCards: async () => [],
        getCard: async (id: number) => {
          getCardCalls.push(id);
          return {
            id,
            name: `Card ${id}`,
            type: 'model',
            database_id: 42,
            collection_id: null,
            archived: false,
            result_metadata: [],
          };
        },
        getResolvedSql: async (card: any) => ({
          resolvedSql: `SELECT 1 ${(refs[card.id] ?? []).map((r) => `{{#${r}}}`).join(' ')}`,
          templateTags: (refs[card.id] ?? []).map((r) => ({ name: `#${r}`, type: 'card', cardReference: r })),
          resolutionStatus: 'resolved',
        }),
        getCollectionTree: async () => [],
        getCollectionItems: async () => [],
        cleanup: async () => {},
      };
      await fetchMetabaseBundle({
        pullConfig: { metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678', metabaseDatabaseId: 42 },
        stagedDir: staged,
        ctx: { connectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789', sourceKey: 'metabase' },
        clientFactory: { createClient: () => client },
        sourceStateReader: {
          getSourceState: async () => ({
            syncMode: 'ONLY',
            selections: [{ selectionType: 'item', metabaseObjectId: 1 }],
            mappings: [
              {
                metabaseDatabaseId: 42,
                metabaseDatabaseName: 'Analytics',
                metabaseEngine: 'postgres',
                targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
                syncEnabled: true,
              },
            ],
            defaultTagNames: [],
          }),
        } as any,
      });
      expect([...getCardCalls].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });

  it('ONLY with cyclical refs does not infinite-loop', async () => {
    const staged = await mkdtemp(join(tmpdir(), 'mb-fetch-cycle-'));
    try {
      const getCardCalls: number[] = [];
      const refs: Record<number, number[]> = { 1: [2], 2: [1] };
      const client: any = {
        getAllCards: async () => [],
        getCard: async (id: number) => {
          getCardCalls.push(id);
          return {
            id,
            name: `Card ${id}`,
            type: 'model',
            database_id: 42,
            collection_id: null,
            archived: false,
            result_metadata: [],
          };
        },
        getResolvedSql: async (card: any) => ({
          resolvedSql: `SELECT 1`,
          templateTags: (refs[card.id] ?? []).map((r) => ({ name: `#${r}`, type: 'card', cardReference: r })),
          resolutionStatus: 'resolved',
        }),
        getCollectionTree: async () => [],
        getCollectionItems: async () => [],
        cleanup: async () => {},
      };
      await fetchMetabaseBundle({
        pullConfig: { metabaseConnectionId: 'a1b2c3d4-e5f6-4789-9abc-def012345678', metabaseDatabaseId: 42 },
        stagedDir: staged,
        ctx: { connectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789', sourceKey: 'metabase' },
        clientFactory: { createClient: () => client },
        sourceStateReader: {
          getSourceState: async () => ({
            syncMode: 'ONLY',
            selections: [{ selectionType: 'item', metabaseObjectId: 1 }],
            mappings: [
              {
                metabaseDatabaseId: 42,
                metabaseDatabaseName: 'Analytics',
                metabaseEngine: 'postgres',
                targetConnectionId: 'b2c3d4e5-f6a7-4890-abcd-ef0123456789',
                syncEnabled: true,
              },
            ],
            defaultTagNames: [],
          }),
        } as any,
      });
      expect([...getCardCalls].sort((a, b) => a - b)).toEqual([1, 2]);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });
});
