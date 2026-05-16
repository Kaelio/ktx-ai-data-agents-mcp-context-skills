import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createLocalProjectMemoryIngest,
  detectCaptureSignals,
  type MemoryAgentInput,
} from '../memory/index.js';
import { initKtxProject } from '../project/index.js';
import { createKtxMcpServer } from './server.js';
import type {
  KtxDiscoverDataMcpPort,
  KtxDictionarySearchMcpPort,
  KtxEntityDetailsMcpPort,
  KtxKnowledgeMcpPort,
  KtxMcpContextPorts,
  KtxSemanticLayerMcpPort,
  KtxSqlExecutionMcpPort,
  KtxSqlExecutionResponse,
  MemoryIngestPort,
} from './types.js';

type RegisteredTool = {
  name: string;
  config: { title?: string; description?: string; inputSchema: unknown };
  handler: (input: Record<string, unknown>) => Promise<unknown>;
};

function makeFakeServer() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      registerTool(name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']): void {
        tools.push({ name, config, handler });
      },
    },
  };
}

function getTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`Tool not registered: ${name}`);
  }
  return found;
}

describe('createKtxMcpServer', () => {
  it('registers context tools without memory capture tools when memory capture is omitted', async () => {
    const fake = makeFakeServer();

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: {
        connections: {
          async list() {
            return [{ id: 'warehouse', name: 'warehouse', connectionType: 'postgres' }];
          },
        },
      },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['connection_list']);
    await expect(getTool(fake.tools, 'connection_list').handler({})).resolves.toMatchObject({
      structuredContent: {
        connections: [{ id: 'warehouse', name: 'warehouse', connectionType: 'postgres' }],
      },
    });
  });

  it('registers parser-gated sql_execution when the host provides a SQL execution port', async () => {
    const fake = makeFakeServer();
    const response: KtxSqlExecutionResponse = {
      headers: ['status', 'count'],
      headerTypes: ['text', 'bigint'],
      rows: [['paid', 42]],
      rowCount: 1,
    };
    const sqlExecution: KtxSqlExecutionMcpPort = {
      execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockResolvedValue(response),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: {
        sqlExecution,
      },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['sql_execution']);
    await expect(
      getTool(fake.tools, 'sql_execution').handler({
        connectionId: 'warehouse',
        sql: 'select status, count(*) from public.orders group by status',
        maxRows: 50,
      }),
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              headers: ['status', 'count'],
              headerTypes: ['text', 'bigint'],
              rows: [['paid', 42]],
              rowCount: 1,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        headers: ['status', 'count'],
        headerTypes: ['text', 'bigint'],
        rows: [['paid', 42]],
        rowCount: 1,
      },
    });
    expect(sqlExecution.execute).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      sql: 'select status, count(*) from public.orders group by status',
      maxRows: 50,
    });
  });

  it('registers entity_details when the host provides an entity-details port', async () => {
    const fake = makeFakeServer();
    const entityDetails: KtxEntityDetailsMcpPort = {
      read: vi.fn<KtxEntityDetailsMcpPort['read']>().mockResolvedValue({
        results: [
          {
            ok: true,
            connectionId: 'warehouse',
            tableRef: { catalog: null, db: 'public', name: 'orders' },
            display: 'public.orders',
            kind: 'table',
            comment: 'Customer orders',
            estimatedRows: 12,
            columns: [
              {
                name: 'id',
                nativeType: 'integer',
                normalizedType: 'integer',
                dimensionType: 'number',
                nullable: false,
                primaryKey: true,
                comment: null,
              },
            ],
            foreignKeys: [],
            snapshot: {
              syncId: 'sync-1',
              extractedAt: '2026-05-14T09:00:00.000Z',
              scanRunId: 'scan-1',
            },
          },
        ],
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { entityDetails },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['entity_details']);
    await expect(
      getTool(fake.tools, 'entity_details').handler({
        connectionId: 'warehouse',
        entities: [{ table: 'public.orders', columns: ['id'] }],
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        results: [
          {
            ok: true,
            connectionId: 'warehouse',
            display: 'public.orders',
            columns: [{ name: 'id' }],
          },
        ],
      },
    });
    expect(entityDetails.read).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders', columns: ['id'] }],
    });
  });

  it('registers dictionary_search when the host provides a dictionary-search port', async () => {
    const fake = makeFakeServer();
    const dictionarySearch: KtxDictionarySearchMcpPort = {
      search: vi.fn<KtxDictionarySearchMcpPort['search']>().mockResolvedValue({
        searched: [
          {
            connectionId: 'warehouse',
            coverage: {
              sampledRows: null,
              valuesPerColumn: null,
              profiledColumns: 1,
              syncId: 'sync-1',
              profiledAt: null,
            },
            status: 'ready',
          },
        ],
        results: [
          {
            value: 'paid',
            matches: [
              {
                connectionId: 'warehouse',
                sourceName: 'orders',
                columnName: 'status',
                matchedValue: 'paid',
                cardinality: 3,
              },
            ],
            misses: [],
          },
        ],
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { dictionarySearch },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['dictionary_search']);
    await expect(
      getTool(fake.tools, 'dictionary_search').handler({
        connectionId: 'warehouse',
        values: ['paid'],
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        searched: [{ connectionId: 'warehouse', status: 'ready' }],
        results: [
          {
            value: 'paid',
            matches: [{ connectionId: 'warehouse', sourceName: 'orders', columnName: 'status' }],
            misses: [],
          },
        ],
      },
    });
    expect(dictionarySearch.search).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      values: ['paid'],
    });
  });

  it('sl_query normalizes order_by from cube-style {id, desc} and bare strings to {field, direction}', async () => {
    const fake = makeFakeServer();
    const semanticLayer: KtxSemanticLayerMcpPort = {
      readSource: vi.fn(),
      query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
        sql: '',
        headers: [],
        rows: [],
        totalRows: 0,
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { semanticLayer },
    });

    await getTool(fake.tools, 'sl_query').handler({
      connectionId: 'warehouse',
      measures: ['orders.count'],
      order_by: [
        { field: 'orders.total', direction: 'desc' },
        { id: 'orders.quarter_label', desc: false },
        { id: 'orders.created_at', desc: true },
        'orders.segment',
      ],
    });

    expect(semanticLayer.query).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      query: expect.objectContaining({
        order_by: [
          { field: 'orders.total', direction: 'desc' },
          { field: 'orders.quarter_label', direction: 'asc' },
          { field: 'orders.created_at', direction: 'desc' },
          { field: 'orders.segment', direction: 'asc' },
        ],
      }),
    });
  });

  it('registers discover_data when the host provides a discover port', async () => {
    const fake = makeFakeServer();
    const discover: KtxDiscoverDataMcpPort = {
      search: vi.fn<KtxDiscoverDataMcpPort['search']>().mockResolvedValue([
        {
          kind: 'table',
          id: 'public.orders',
          score: 1,
          summary: 'Orders table',
          snippet: 'id, status',
          matchedOn: 'name',
          connectionId: 'warehouse',
          tableRef: { catalog: null, db: 'public', name: 'orders' },
        },
      ]),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { discover },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['discover_data']);
    await expect(
      getTool(fake.tools, 'discover_data').handler({
        query: 'orders',
        connectionId: 'warehouse',
        kinds: ['table'],
        limit: 5,
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        refs: [
          {
            kind: 'table',
            id: 'public.orders',
            connectionId: 'warehouse',
            tableRef: { catalog: null, db: 'public', name: 'orders' },
          },
        ],
      },
    });
    expect(discover.search).toHaveBeenCalledWith({
      query: 'orders',
      connectionId: 'warehouse',
      kinds: ['table'],
      limit: 5,
    });
  });

  it('registers memory ingest tools through the context tool surface', async () => {
    const fake = makeFakeServer();
    let receivedInput: MemoryAgentInput | undefined;
    const ingest: MemoryIngestPort = {
      ingest: vi.fn<MemoryIngestPort['ingest']>().mockImplementation(async (input) => {
        receivedInput = input;
        return { runId: 'run-1' };
      }),
      status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue({
        runId: 'run-1',
        status: 'done',
        stage: 'done',
        done: true,
        captured: { wiki: ['revenue'], sl: [], xrefs: [] },
        error: null,
        commitHash: 'abc123',
        skillsLoaded: ['wiki_capture'],
        signalDetected: true,
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools: { memoryIngest: ingest },
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual(['memory_ingest', 'memory_ingest_status']);

    const content = [
      'view: orders {',
      '  sql_table_name: public.orders ;;',
      '  measure: gross_revenue {',
      '    type: sum',
      '    sql: ${TABLE}.gross_revenue_cents ;;',
      '  }',
      '}',
    ].join('\n');
    const memoryIngest = getTool(fake.tools, 'memory_ingest');
    await expect(
      memoryIngest.handler({
        content,
        connectionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ runId: 'run-1' }, null, 2) }],
      structuredContent: { runId: 'run-1' },
    });
    expect(ingest.ingest).toHaveBeenCalledWith({
      userId: 'mcp-user',
      chatId: expect.stringMatching(/^mcp-/),
      userMessage: 'Ingest external knowledge into KTX memory.',
      assistantMessage: content,
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'external_ingest',
    });

    const cliEquivalentInput: MemoryAgentInput = {
      userId: 'mcp-user',
      chatId: 'cli-text-ingest-test-1',
      userMessage: 'Ingest external text artifact "orders lookml" into KTX memory.',
      assistantMessage: content,
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'external_ingest',
    };
    expect(detectCaptureSignals(receivedInput!)).toEqual(detectCaptureSignals(cliEquivalentInput));

    const memoryStatus = getTool(fake.tools, 'memory_ingest_status');
    await expect(memoryStatus.handler({ runId: 'run-1' })).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              runId: 'run-1',
              status: 'done',
              stage: 'done',
              done: true,
              captured: { wiki: ['revenue'], sl: [], xrefs: [] },
              error: null,
              commitHash: 'abc123',
              skillsLoaded: ['wiki_capture'],
              signalDetected: true,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        runId: 'run-1',
        status: 'done',
        stage: 'done',
        done: true,
        captured: { wiki: ['revenue'], sl: [], xrefs: [] },
        error: null,
        commitHash: 'abc123',
        skillsLoaded: ['wiki_capture'],
        signalDetected: true,
      },
    });
  });

  it('returns an in-band error when a memory ingest run is missing', async () => {
    const fake = makeFakeServer();
    const ingest: MemoryIngestPort = {
      ingest: vi.fn<MemoryIngestPort['ingest']>(),
      status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue(null),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools: { memoryIngest: ingest },
    });

    const memoryStatus = getTool(fake.tools, 'memory_ingest_status');
    await expect(memoryStatus.handler({ runId: 'missing-run' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Memory ingest run "missing-run" was not found.' }],
      isError: true,
    });
  });

  it('runs MCP memory_ingest against a local project memory port', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'ktx-mcp-local-memory-'));
      try {
        const project = await initKtxProject({ projectDir: tempDir });
        const agentRunner = {
          runLoop: async ({
            toolSet,
          }: {
            toolSet: Record<string, { execute: (input: unknown, options?: { toolCallId?: string }) => Promise<unknown> }>;
          }) => {
            await toolSet.load_skill.execute({ name: 'wiki_capture' });
            await toolSet.wiki_write.execute(
            {
              key: 'arr',
              summary: 'ARR definition',
              content: 'ARR means annual recurring revenue.',
            },
            { toolCallId: 'wiki-write' },
          );
          return { stopReason: 'natural' as const };
        },
      };
      const memoryIngest = createLocalProjectMemoryIngest(project, {
        agentRunner: agentRunner as never,
        runIdFactory: () => 'memory-run-mcp',
      });
      const ingestSpy = vi.spyOn(memoryIngest, 'ingest');
      const fake = makeFakeServer();

      createKtxMcpServer({
        server: fake.server,
        userContext: { userId: 'local' },
        contextTools: { memoryIngest },
      });

      const capture = await getTool(fake.tools, 'memory_ingest').handler({
        content: 'Revenue means paid order value.',
        connectionId: 'warehouse',
      });
      expect(capture).toMatchObject({
        structuredContent: { runId: 'memory-run-mcp' },
      });
      await memoryIngest.waitForRun('memory-run-mcp');
      expect(ingestSpy).toHaveBeenCalledWith({
        userId: 'local',
        chatId: expect.stringMatching(/^mcp-/),
        userMessage: 'Ingest external knowledge into KTX memory.',
        assistantMessage: 'Revenue means paid order value.',
        connectionId: 'warehouse',
        sourceType: 'external_ingest',
      });

      await expect(
        getTool(fake.tools, 'memory_ingest_status').handler({ runId: 'memory-run-mcp' }),
      ).resolves.toMatchObject({
        structuredContent: {
          runId: 'memory-run-mcp',
          status: 'done',
          done: true,
          captured: { wiki: ['arr'], sl: [], xrefs: [] },
        },
      });
      await expect(access(join(project.projectDir, '.ktx/db.sqlite'))).resolves.toBeUndefined();
      await expect(access(join(project.projectDir, '.ktx/memory-runs/memory-run-mcp.json'))).rejects.toThrow();
      await expect(readFile(join(project.projectDir, 'wiki/global/arr.md'), 'utf-8')).resolves.toContain(
        'ARR means annual recurring revenue.',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('registers KTX context MCP tools when context ports are supplied', async () => {
    const fake = makeFakeServer();
    const contextTools: KtxMcpContextPorts = {
      connections: {
        list: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Warehouse',
            connectionType: 'POSTGRES',
          },
        ]),
      },
      knowledge: {
        search: vi.fn<KtxKnowledgeMcpPort['search']>().mockResolvedValue({
          results: [
            {
              key: 'revenue',
              path: 'wiki/global/revenue.md',
              scope: 'GLOBAL',
              summary: 'Paid order value',
              score: 0.42,
              matchReasons: ['lexical'],
            },
          ],
          totalFound: 1,
        }),
        read: vi.fn<KtxKnowledgeMcpPort['read']>().mockResolvedValue({
          key: 'revenue',
          summary: 'Paid order value',
          content: '# Revenue',
          scope: 'GLOBAL',
          tags: ['finance'],
          refs: [],
          slRefs: ['orders'],
        }),
      },
      semanticLayer: {
        readSource: vi.fn<KtxSemanticLayerMcpPort['readSource']>().mockResolvedValue({
          sourceName: 'orders',
          yaml: 'name: orders\n',
        }),
        query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
          sql: 'select 1',
          headers: ['count'],
          rows: [[1]],
          totalRows: 1,
          plan: { sources: ['orders'] },
        }),
      },
      entityDetails: {
        read: vi.fn<KtxEntityDetailsMcpPort['read']>().mockResolvedValue({ results: [] }),
      },
      dictionarySearch: {
        search: vi.fn<KtxDictionarySearchMcpPort['search']>().mockResolvedValue({
          searched: [],
          results: [],
        }),
      },
      discover: {
        search: vi.fn<KtxDiscoverDataMcpPort['search']>().mockResolvedValue([]),
      },
      sqlExecution: {
        execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockResolvedValue({
          headers: ['count'],
          headerTypes: ['integer'],
          rows: [[1]],
          rowCount: 1,
        }),
      },
      memoryIngest: {
        ingest: vi.fn<MemoryIngestPort['ingest']>().mockResolvedValue({ runId: 'run-1' }),
        status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue(null),
      },
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools,
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
      'connection_list',
      'dictionary_search',
      'discover_data',
      'entity_details',
      'memory_ingest',
      'memory_ingest_status',
      'sl_query',
      'sl_read_source',
      'sql_execution',
      'wiki_read',
      'wiki_search',
    ]);

    await expect(getTool(fake.tools, 'connection_list').handler({})).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              connections: [
                {
                  id: '00000000-0000-4000-8000-000000000001',
                  name: 'Warehouse',
                  connectionType: 'POSTGRES',
                },
              ],
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        connections: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Warehouse',
            connectionType: 'POSTGRES',
          },
        ],
      },
    });

    await getTool(fake.tools, 'wiki_search').handler({ query: 'revenue', limit: 5 });
    expect(contextTools.knowledge?.search).toHaveBeenCalledWith({
      userId: 'mcp-user',
      query: 'revenue',
      limit: 5,
    });

    await getTool(fake.tools, 'wiki_read').handler({ key: 'revenue' });
    expect(contextTools.knowledge?.read).toHaveBeenCalledWith({
      userId: 'mcp-user',
      key: 'revenue',
    });

    await getTool(fake.tools, 'sl_read_source').handler({
      connectionId: 'warehouse',
      sourceName: 'orders',
    });
    expect(contextTools.semanticLayer?.readSource).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      sourceName: 'orders',
    });

    await getTool(fake.tools, 'sl_query').handler({
      connectionId: '00000000-0000-4000-8000-000000000001',
      measures: ['orders.count'],
      dimensions: ['orders.created_at'],
      filters: ['orders.status = paid'],
      limit: 25,
    });
    expect(contextTools.semanticLayer?.query).toHaveBeenCalledWith({
      connectionId: '00000000-0000-4000-8000-000000000001',
      query: {
        measures: ['orders.count'],
        dimensions: ['orders.created_at'],
        filters: ['orders.status = paid'],
        segments: [],
        order_by: [],
        limit: 25,
        include_empty: true,
      },
    });
  });
});
