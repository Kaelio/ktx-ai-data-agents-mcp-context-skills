import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLocalProjectMemoryCapture } from '../memory/index.js';
import { initKtxProject } from '../project/index.js';
import { createKtxMcpServer } from './server.js';
import type {
  KtxIngestMcpPort,
  KtxKnowledgeMcpPort,
  KtxMcpContextPorts,
  KtxScanMcpPort,
  KtxSemanticLayerMcpPort,
  MemoryCapturePort,
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

  it('registers memory capture tools without host app dependencies', async () => {
    const fake = makeFakeServer();
    const capture: MemoryCapturePort = {
      capture: vi.fn<MemoryCapturePort['capture']>().mockResolvedValue({ runId: 'run-1' }),
      status: vi.fn<MemoryCapturePort['status']>().mockResolvedValue({
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
      memoryCapture: capture,
      userContext: { userId: 'mcp-user' },
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual(['memory_capture', 'memory_capture_status']);

    const memoryCapture = getTool(fake.tools, 'memory_capture');
    await expect(
      memoryCapture.handler({
        userMessage: 'Revenue means paid order value.',
        assistantMessage: 'Captured.',
        connectionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ runId: 'run-1' }, null, 2) }],
      structuredContent: { runId: 'run-1' },
    });
    expect(capture.capture).toHaveBeenCalledWith({
      userId: 'mcp-user',
      chatId: expect.stringMatching(/^mcp-/),
      userMessage: 'Revenue means paid order value.',
      assistantMessage: 'Captured.',
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'external_ingest',
    });

    const memoryStatus = getTool(fake.tools, 'memory_capture_status');
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

  it('returns an MCP error payload for missing run ids', async () => {
    const fake = makeFakeServer();
    const capture: MemoryCapturePort = {
      capture: vi.fn<MemoryCapturePort['capture']>(),
      status: vi.fn<MemoryCapturePort['status']>().mockResolvedValue(null),
    };

    createKtxMcpServer({
      server: fake.server,
      memoryCapture: capture,
      userContext: { userId: 'mcp-user' },
    });

    const memoryStatus = getTool(fake.tools, 'memory_capture_status');
    await expect(memoryStatus.handler({ runId: 'missing' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Memory capture run "missing" was not found.' }],
      isError: true,
    });
  });

  it('runs MCP memory_capture against a local project memory port', async () => {
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
      const memoryCapture = createLocalProjectMemoryCapture(project, {
        agentRunner: agentRunner as never,
        runIdFactory: () => 'memory-run-mcp',
      });
      const fake = makeFakeServer();

      createKtxMcpServer({
        server: fake.server,
        memoryCapture,
        userContext: { userId: 'mcp-user' },
      });

      const capture = await getTool(fake.tools, 'memory_capture').handler({
        userMessage: 'define ARR as annual recurring revenue',
        assistantMessage: 'Captured.',
      });
      expect(capture).toMatchObject({
        structuredContent: { runId: 'memory-run-mcp' },
      });
      await memoryCapture.waitForRun('memory-run-mcp');

      await expect(
        getTool(fake.tools, 'memory_capture_status').handler({ runId: 'memory-run-mcp' }),
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
    const capture: MemoryCapturePort = {
      capture: vi.fn<MemoryCapturePort['capture']>().mockResolvedValue({ runId: 'run-1' }),
      status: vi.fn<MemoryCapturePort['status']>().mockResolvedValue(null),
    };
    const contextTools: KtxMcpContextPorts = {
      connections: {
        list: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Warehouse',
            connectionType: 'POSTGRES',
          },
        ]),
        test: vi.fn().mockResolvedValue({
          id: 'warehouse',
          connectionType: 'postgres',
          ok: true,
          tableCount: 2,
          message: 'Connection test passed.',
          warnings: [],
        }),
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
        write: vi.fn<KtxKnowledgeMcpPort['write']>().mockResolvedValue({
          success: true,
          key: 'revenue',
          action: 'updated',
        }),
      },
      semanticLayer: {
        listSources: vi.fn<KtxSemanticLayerMcpPort['listSources']>().mockResolvedValue({
          sources: [
            {
              connectionId: '00000000-0000-4000-8000-000000000001',
              connectionName: 'Warehouse',
              name: 'orders',
              description: 'Order facts',
              columnCount: 2,
              measureCount: 1,
              joinCount: 0,
            },
          ],
          totalSources: 1,
        }),
        readSource: vi.fn<KtxSemanticLayerMcpPort['readSource']>().mockResolvedValue({
          sourceName: 'orders',
          yaml: 'name: orders\n',
        }),
        writeSource: vi.fn<KtxSemanticLayerMcpPort['writeSource']>().mockResolvedValue({
          success: true,
          sourceName: 'orders',
          yaml: 'name: orders\n',
          commitHash: 'abc123',
        }),
        validate: vi.fn<KtxSemanticLayerMcpPort['validate']>().mockResolvedValue({
          success: true,
          errors: [],
          warnings: [],
        }),
        query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
          sql: 'select 1',
          headers: ['count'],
          rows: [[1]],
          totalRows: 1,
          plan: { sources: ['orders'] },
        }),
      },
      ingest: {
        trigger: vi.fn<KtxIngestMcpPort['trigger']>().mockResolvedValue({
          runId: 'run-42',
          jobId: 'job-42',
          reportId: 'report-42',
        }),
        status: vi.fn<KtxIngestMcpPort['status']>().mockResolvedValue({
          runId: 'run-42',
          jobId: 'job-42',
          reportId: 'report-42',
          status: 'done',
          stage: 'done',
          progress: 1,
          done: true,
          adapter: 'fake',
          connectionId: 'warehouse',
          sourceDir: '/tmp/upload',
          syncId: '2026-04-27-120000-run-42',
          startedAt: '2026-04-27T12:00:00.000Z',
          completedAt: '2026-04-27T12:00:01.000Z',
          previousRunId: 'run-41',
          diffSummary: {
            added: 0,
            modified: 1,
            deleted: 0,
            unchanged: 3,
          },
          rawFileCount: 4,
          workUnitCount: 1,
          workUnits: [
            {
              unitKey: 'fake-orders',
              rawFiles: ['orders/orders.json'],
              peerFileIndex: [],
              dependencyPaths: [],
            },
          ],
          evictionDeletedRawPaths: [],
          errors: [],
        }),
        report: vi.fn<NonNullable<KtxIngestMcpPort['report']>>().mockResolvedValue({
          id: 'report-42',
          runId: 'run-42',
          jobId: 'job-42',
          connectionId: 'warehouse',
          sourceKey: 'fake',
          createdAt: '2026-04-27T12:00:01.000Z',
          body: {
            syncId: '2026-04-27-120000-run-42',
            diffSummary: { added: 0, modified: 1, deleted: 0, unchanged: 3 },
            commitSha: null,
            workUnits: [],
            failedWorkUnits: [],
            reconciliationSkipped: false,
            conflictsResolved: [],
            evictionsApplied: [],
            unmappedFallbacks: [],
            evictionInputs: [],
            unresolvedCards: [],
            supersededBy: null,
            overrideOf: null,
            provenanceRows: [],
            toolTranscripts: [],
          },
        }),
        replay: vi.fn<NonNullable<KtxIngestMcpPort['replay']>>().mockResolvedValue({
          runId: 'run-42',
          reportId: 'report-42',
          reportPath: 'report-42',
          connectionId: 'warehouse',
          adapter: 'fake',
          status: 'done',
          sourceDir: null,
          syncId: '2026-04-27-120000-run-42',
          errors: [],
          events: [{ type: 'report_created', runId: 'run-42', reportPath: 'report-42' }],
          plannedWorkUnits: [],
          details: { actions: [], provenance: [], transcripts: [] },
        }),
      },
      scan: {
        trigger: vi.fn<KtxScanMcpPort['trigger']>().mockResolvedValue({
          runId: 'scan-run-1',
          status: 'done',
          done: true,
          connectionId: 'warehouse',
          mode: 'structural',
          dryRun: false,
          syncId: 'sync-1',
          report: {
            connectionId: 'warehouse',
            driver: 'postgres',
            syncId: 'sync-1',
            runId: 'scan-run-1',
            trigger: 'mcp',
            mode: 'structural',
            dryRun: false,
            artifactPaths: {
              rawSourcesDir: 'raw-sources/warehouse/live-database/sync-1',
              reportPath: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
              manifestShards: [],
              enrichmentArtifacts: [],
            },
            diffSummary: {
              tablesAdded: 1,
              tablesModified: 0,
              tablesDeleted: 0,
              tablesUnchanged: 0,
              columnsAdded: 0,
              columnsModified: 0,
              columnsDeleted: 0,
            },
            manifestShardsWritten: 0,
            structuralSyncStats: {
              tablesCreated: 0,
              tablesUpdated: 0,
              tablesDeleted: 0,
              columnsCreated: 0,
              columnsUpdated: 0,
              columnsDeleted: 0,
            },
            enrichment: {
              dataDictionary: 'skipped',
              tableDescriptions: 'skipped',
              columnDescriptions: 'skipped',
              embeddings: 'skipped',
              deterministicRelationships: 'skipped',
              llmRelationshipValidation: 'skipped',
              statisticalValidation: 'skipped',
            },
            capabilityGaps: [],
            warnings: [],
            relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
            enrichmentState: {
              resumedStages: [],
              completedStages: [],
              failedStages: [],
            },
            createdAt: '2026-04-29T09:00:00.000Z',
          },
        }),
        status: vi.fn<KtxScanMcpPort['status']>().mockResolvedValue({
          runId: 'scan-run-1',
          status: 'done',
          done: true,
          connectionId: 'warehouse',
          mode: 'structural',
          dryRun: false,
          syncId: 'sync-1',
          progress: 1,
          startedAt: '2026-04-29T09:00:00.000Z',
          completedAt: '2026-04-29T09:00:01.000Z',
          reportPath: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
          warnings: [],
        }),
        report: vi.fn<KtxScanMcpPort['report']>().mockResolvedValue(null),
        listArtifacts: vi.fn<NonNullable<KtxScanMcpPort['listArtifacts']>>().mockResolvedValue({
          runId: 'scan-run-1',
          artifacts: [
            {
              path: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
              type: 'report',
              size: 128,
            },
            {
              path: 'raw-sources/warehouse/live-database/sync-1/tables/orders.json',
              type: 'raw_source',
              size: 64,
            },
          ],
        }),
        readArtifact: vi.fn<NonNullable<KtxScanMcpPort['readArtifact']>>().mockImplementation(async (input) => {
          if (input.path !== 'raw-sources/warehouse/live-database/sync-1/tables/orders.json') {
            return null;
          }
          return {
            runId: input.runId,
            path: input.path,
            type: 'raw_source',
            size: 64,
            content: '{"name":"orders"}\n',
          };
        }),
      },
    };

    createKtxMcpServer({
      server: fake.server,
      memoryCapture: capture,
      userContext: { userId: 'mcp-user' },
      contextTools,
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
      'connection_list',
      'connection_test',
      'ingest_replay',
      'ingest_report',
      'ingest_status',
      'ingest_trigger',
      'memory_capture',
      'memory_capture_status',
      'scan_list_artifacts',
      'scan_read_artifact',
      'scan_report',
      'scan_status',
      'scan_trigger',
      'sl_list_sources',
      'sl_query',
      'sl_read_source',
      'sl_validate',
      'sl_write_source',
      'wiki_read',
      'wiki_search',
      'wiki_write',
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

    await expect(getTool(fake.tools, 'connection_test').handler({ connectionId: 'warehouse' })).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              id: 'warehouse',
              connectionType: 'postgres',
              ok: true,
              tableCount: 2,
              message: 'Connection test passed.',
              warnings: [],
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        id: 'warehouse',
        connectionType: 'postgres',
        ok: true,
        tableCount: 2,
        message: 'Connection test passed.',
        warnings: [],
      },
    });
    expect(contextTools.connections?.test).toHaveBeenCalledWith({ connectionId: 'warehouse' });

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

    await getTool(fake.tools, 'wiki_write').handler({
      key: 'revenue',
      summary: 'Paid order value',
      content: '# Revenue',
      tags: ['finance'],
      refs: ['gross-margin'],
      sl_refs: ['orders'],
    });
    expect(contextTools.knowledge?.write).toHaveBeenCalledWith({
      userId: 'mcp-user',
      key: 'revenue',
      summary: 'Paid order value',
      content: '# Revenue',
      tags: ['finance'],
      refs: ['gross-margin'],
      slRefs: ['orders'],
    });

    await getTool(fake.tools, 'sl_list_sources').handler({
      connectionId: '00000000-0000-4000-8000-000000000001',
      query: 'orders',
    });
    expect(contextTools.semanticLayer?.listSources).toHaveBeenCalledWith({
      connectionId: '00000000-0000-4000-8000-000000000001',
      query: 'orders',
    });

    await getTool(fake.tools, 'sl_read_source').handler({
      connectionId: 'warehouse',
      sourceName: 'orders',
    });
    expect(contextTools.semanticLayer?.readSource).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      sourceName: 'orders',
    });

    await getTool(fake.tools, 'sl_write_source').handler({
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceName: 'orders',
      source: { name: 'orders', table: 'public.orders', grain: ['id'], columns: [], joins: [], measures: [] },
    });
    expect(contextTools.semanticLayer?.writeSource).toHaveBeenCalledWith({
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceName: 'orders',
      source: { name: 'orders', table: 'public.orders', grain: ['id'], columns: [], joins: [], measures: [] },
      yaml: undefined,
      delete: undefined,
    });

    await getTool(fake.tools, 'sl_validate').handler({
      connectionId: '00000000-0000-4000-8000-000000000001',
      names: ['orders'],
    });
    expect(contextTools.semanticLayer?.validate).toHaveBeenCalledWith({
      connectionId: '00000000-0000-4000-8000-000000000001',
      names: ['orders'],
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

    await getTool(fake.tools, 'ingest_trigger').handler({
      adapter: 'lookml',
      connectionId: '00000000-0000-4000-8000-000000000001',
      trigger: 'scheduled_pull',
      config: { repoUrl: 'https://github.com/acme/looker.git' },
    });
    expect(contextTools.ingest?.trigger).toHaveBeenCalledWith({
      adapter: 'lookml',
      connectionId: '00000000-0000-4000-8000-000000000001',
      trigger: 'scheduled_pull',
      config: { repoUrl: 'https://github.com/acme/looker.git' },
    });

    expect(getTool(fake.tools, 'ingest_status').config.description).toBe(
      'Read the current or final status for an ingest run, including local diff and work-unit summaries when available.',
    );

    await expect(getTool(fake.tools, 'ingest_status').handler({ runId: 'run-42' })).resolves.toMatchObject({
      structuredContent: {
        runId: 'run-42',
        status: 'done',
        stage: 'done',
        progress: 1,
        done: true,
        adapter: 'fake',
        connectionId: 'warehouse',
        sourceDir: '/tmp/upload',
        syncId: '2026-04-27-120000-run-42',
        previousRunId: 'run-41',
        diffSummary: {
          added: 0,
          modified: 1,
          deleted: 0,
          unchanged: 3,
        },
        rawFileCount: 4,
        workUnitCount: 1,
        workUnits: [
          {
            unitKey: 'fake-orders',
            rawFiles: ['orders/orders.json'],
            peerFileIndex: [],
            dependencyPaths: [],
          },
        ],
        evictionDeletedRawPaths: [],
        errors: [],
      },
    });
    expect(contextTools.ingest?.status).toHaveBeenCalledWith({ runId: 'run-42' });

    await expect(getTool(fake.tools, 'ingest_report').handler({ runId: 'report-42' })).resolves.toMatchObject({
      structuredContent: {
        id: 'report-42',
        runId: 'run-42',
        jobId: 'job-42',
        sourceKey: 'fake',
      },
    });
    expect(contextTools.ingest?.report).toHaveBeenCalledWith({ runId: 'report-42' });

    await expect(getTool(fake.tools, 'ingest_replay').handler({ runId: 'run-42' })).resolves.toMatchObject({
      structuredContent: {
        runId: 'run-42',
        reportId: 'report-42',
        status: 'done',
        adapter: 'fake',
      },
    });
    expect(contextTools.ingest?.replay).toHaveBeenCalledWith({ runId: 'run-42' });

    await getTool(fake.tools, 'scan_trigger').handler({
      connectionId: 'warehouse',
      mode: 'structural',
      dryRun: true,
    });
    expect(contextTools.scan?.trigger).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      mode: 'structural',
      detectRelationships: false,
      dryRun: true,
    });

    await getTool(fake.tools, 'scan_trigger').handler({
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      dryRun: false,
    });
    expect(contextTools.scan?.trigger).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      dryRun: false,
    });

    await expect(getTool(fake.tools, 'scan_status').handler({ runId: 'scan-run-1' })).resolves.toMatchObject({
      structuredContent: {
        runId: 'scan-run-1',
        status: 'done',
        connectionId: 'warehouse',
      },
    });

    await expect(getTool(fake.tools, 'scan_report').handler({ runId: 'missing' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Scan report "missing" was not found.' }],
      isError: true,
    });

    await expect(getTool(fake.tools, 'scan_list_artifacts').handler({ runId: 'scan-run-1' })).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              runId: 'scan-run-1',
              artifacts: [
                {
                  path: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
                  type: 'report',
                  size: 128,
                },
                {
                  path: 'raw-sources/warehouse/live-database/sync-1/tables/orders.json',
                  type: 'raw_source',
                  size: 64,
                },
              ],
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        runId: 'scan-run-1',
        artifacts: [
          {
            path: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
            type: 'report',
            size: 128,
          },
          {
            path: 'raw-sources/warehouse/live-database/sync-1/tables/orders.json',
            type: 'raw_source',
            size: 64,
          },
        ],
      },
    });
    expect(contextTools.scan?.listArtifacts).toHaveBeenCalledWith({ runId: 'scan-run-1' });

    await expect(
      getTool(fake.tools, 'scan_read_artifact').handler({
        runId: 'scan-run-1',
        path: 'raw-sources/warehouse/live-database/sync-1/tables/orders.json',
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        runId: 'scan-run-1',
        path: 'raw-sources/warehouse/live-database/sync-1/tables/orders.json',
        type: 'raw_source',
        content: '{"name":"orders"}\n',
      },
    });
    expect(contextTools.scan?.readArtifact).toHaveBeenCalledWith({
      runId: 'scan-run-1',
      path: 'raw-sources/warehouse/live-database/sync-1/tables/orders.json',
    });

    await expect(
      getTool(fake.tools, 'scan_read_artifact').handler({
        runId: 'scan-run-1',
        path: 'ktx.yaml',
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'Scan artifact "ktx.yaml" was not found for run "scan-run-1".' }],
      isError: true,
    });
  });
});
