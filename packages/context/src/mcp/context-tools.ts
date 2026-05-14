import { z } from 'zod';
import type { KtxMcpContextPorts, KtxMcpServerLike, KtxMcpToolResult, KtxMcpUserContext } from './types.js';

export interface RegisterKtxContextToolsDeps {
  server: KtxMcpServerLike;
  ports: KtxMcpContextPorts;
  userContext: KtxMcpUserContext;
}

const connectionIdSchema = z.string().min(1);

const connectionListSchema = z.object({});

const connectionTestSchema = z.object({
  connectionId: connectionIdSchema,
});

const knowledgeSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});

const knowledgeReadSchema = z.object({
  key: z.string().min(1),
});

const historicSqlUsageFrontmatterSchema = z.object({
  executions: z.number().int().nonnegative(),
  distinct_users: z.number().int().nonnegative(),
  first_seen: z.string().min(1),
  last_seen: z.string().min(1),
  p50_runtime_ms: z.number().nonnegative().nullable(),
  p95_runtime_ms: z.number().nonnegative().nullable(),
  error_rate: z.number().min(0).max(1),
  rows_produced: z.number().int().nonnegative().optional(),
});

const knowledgeWriteSchema = z.object({
  key: z.string().min(1).max(120),
  summary: z.string().min(1).max(200),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
  sl_refs: z.array(z.string()).optional(),
  source: z.string().optional(),
  intent: z.string().optional(),
  tables: z.array(z.string()).optional(),
  representative_sql: z.string().optional(),
  usage: historicSqlUsageFrontmatterSchema.optional(),
  fingerprints: z.array(z.string()).optional(),
});

const slListSourcesSchema = z.object({
  connectionId: connectionIdSchema.optional(),
  query: z.string().min(1).optional(),
});

const slReadSourceSchema = z.object({
  connectionId: connectionIdSchema,
  sourceName: z.string().min(1),
});

const slWriteSourceSchema = z.object({
  connectionId: connectionIdSchema,
  sourceName: z.string().regex(/^[a-z0-9][a-z0-9_]*$/, 'Source name must be snake_case'),
  yaml: z.string().min(1).optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  delete: z.boolean().optional(),
});

const slValidateSchema = z.object({
  connectionId: connectionIdSchema,
  names: z.array(z.string().min(1)).optional(),
});

const slQueryMeasureSchema = z.union([
  z.string(),
  z.object({
    expr: z.string().min(1),
    name: z.string().min(1),
  }),
]);

const slQueryDimensionSchema = z.union([
  z.string(),
  z.object({
    field: z.string().min(1),
    granularity: z.string().min(1).optional(),
  }),
]);

const slQueryOrderBySchema = z.union([
  z.string(),
  z.object({
    field: z.string().min(1),
    direction: z.enum(['asc', 'desc']).default('asc'),
  }),
]);

const slQuerySchema = z.object({
  connectionId: connectionIdSchema.optional(),
  measures: z.array(slQueryMeasureSchema).min(1),
  dimensions: z.array(slQueryDimensionSchema).default([]),
  filters: z.array(z.string()).default([]),
  segments: z.array(z.string()).default([]),
  order_by: z.array(slQueryOrderBySchema).default([]),
  limit: z.number().int().min(0).default(1000),
  include_empty: z.boolean().default(true),
});

const ingestTriggerSchema = z.object({
  adapter: z.string().min(1),
  connectionId: connectionIdSchema,
  config: z.unknown().optional(),
  trigger: z.enum(['upload', 'scheduled_pull', 'manual_resync']).default('manual_resync'),
});

const ingestStatusSchema = z.object({
  runId: z.string().min(1),
});

const ingestReportSchema = z.object({
  runId: z.string().min(1),
});

const ingestReplaySchema = z.object({
  runId: z.string().min(1),
});

const scanTriggerSchema = z.object({
  connectionId: connectionIdSchema,
  mode: z.enum(['structural', 'relationships', 'enriched']).default('structural'),
  detectRelationships: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

const scanStatusSchema = z.object({
  runId: z.string().min(1),
});

const scanArtifactReadSchema = z.object({
  runId: z.string().min(1),
  path: z.string().min(1),
});

const entityDetailsTableRefSchema = z.object({
  catalog: z.string().nullable(),
  db: z.string().nullable(),
  name: z.string().min(1),
});

const entityDetailsSchema = z.object({
  connectionId: connectionIdSchema,
  entities: z
    .array(
      z.object({
        table: z.union([z.string().min(1), entityDetailsTableRefSchema]),
        columns: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1)
    .max(20),
});

const sqlExecutionSchema = z.object({
  connectionId: connectionIdSchema,
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(10_000).default(1000).optional(),
});

export function jsonToolResult<T extends object>(structuredContent: T): KtxMcpToolResult<T> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function jsonErrorToolResult(text: string): KtxMcpToolResult<Record<string, never>> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

function registerParsedTool<TSchema extends z.ZodType>(
  server: KtxMcpServerLike,
  name: string,
  config: { title: string; description: string; inputSchema: unknown },
  schema: TSchema,
  handler: (input: z.infer<TSchema>) => Promise<KtxMcpToolResult>,
): void {
  server.registerTool(name, config, async (input) => handler(schema.parse(input)));
}

export function registerKtxContextTools(deps: RegisterKtxContextToolsDeps): void {
  const { ports, server, userContext } = deps;

  if (ports.connections) {
    const connections = ports.connections;
    registerParsedTool(
      server,
      'connection_list',
      {
        title: 'Connection List',
        description: 'List configured read-only data connections available to the KTX project.',
        inputSchema: connectionListSchema.shape,
      },
      connectionListSchema,
      async () => jsonToolResult({ connections: await connections.list() }),
    );

    if (connections.test) {
      registerParsedTool(
        server,
        'connection_test',
        {
          title: 'Connection Test',
          description: 'Test a configured standalone KTX connection through the host-provided scan connector.',
          inputSchema: connectionTestSchema.shape,
        },
        connectionTestSchema,
        async (input) => {
          const result = await connections.test?.({ connectionId: input.connectionId });
          return result
            ? jsonToolResult(result)
            : jsonErrorToolResult(`Connection "${input.connectionId}" was not found.`);
        },
      );
    }
  }

  if (ports.knowledge) {
    const knowledge = ports.knowledge;
    registerParsedTool(
      server,
      'wiki_search',
      {
        title: 'Wiki Search',
        description: 'Search KTX wiki pages and return ranked summaries.',
        inputSchema: knowledgeSearchSchema.shape,
      },
      knowledgeSearchSchema,
      async (input) =>
        jsonToolResult(
          await knowledge.search({
            userId: userContext.userId,
            query: input.query,
            limit: input.limit,
          }),
        ),
    );

    registerParsedTool(
      server,
      'wiki_read',
      {
        title: 'Wiki Read',
        description: 'Read a KTX wiki page by key.',
        inputSchema: knowledgeReadSchema.shape,
      },
      knowledgeReadSchema,
      async (input) => {
        const page = await knowledge.read({ userId: userContext.userId, key: input.key });
        return page ? jsonToolResult(page) : jsonErrorToolResult(`Wiki page "${input.key}" was not found.`);
      },
    );

    registerParsedTool(
      server,
      'wiki_write',
      {
        title: 'Wiki Write',
        description: 'Create or replace a KTX wiki page and its SL references.',
        inputSchema: knowledgeWriteSchema.shape,
      },
      knowledgeWriteSchema,
      async (input) =>
        jsonToolResult(
          await knowledge.write({
            userId: userContext.userId,
            key: input.key,
            summary: input.summary,
            content: input.content,
            tags: input.tags,
            refs: input.refs,
            slRefs: input.sl_refs,
            source: input.source,
            intent: input.intent,
            tables: input.tables,
            representativeSql: input.representative_sql,
            usage: input.usage,
            fingerprints: input.fingerprints,
          }),
        ),
    );
  }

  if (ports.semanticLayer) {
    const semanticLayer = ports.semanticLayer;
    registerParsedTool(
      server,
      'sl_list_sources',
      {
        title: 'Semantic Layer List Sources',
        description: 'List semantic-layer sources, optionally filtered by connection or search query.',
        inputSchema: slListSourcesSchema.shape,
      },
      slListSourcesSchema,
      async (input) => jsonToolResult(await semanticLayer.listSources(input)),
    );

    registerParsedTool(
      server,
      'sl_read_source',
      {
        title: 'Semantic Layer Read Source',
        description: 'Read a semantic-layer YAML source by connection id and source name.',
        inputSchema: slReadSourceSchema.shape,
      },
      slReadSourceSchema,
      async (input) => {
        const source = await semanticLayer.readSource(input);
        return source
          ? jsonToolResult(source)
          : jsonErrorToolResult(`Semantic-layer source "${input.sourceName}" was not found.`);
      },
    );

    registerParsedTool(
      server,
      'sl_write_source',
      {
        title: 'Semantic Layer Write Source',
        description: 'Create, replace, or delete a semantic-layer source.',
        inputSchema: slWriteSourceSchema.shape,
      },
      slWriteSourceSchema,
      async (input) =>
        jsonToolResult(
          await semanticLayer.writeSource({
            connectionId: input.connectionId,
            sourceName: input.sourceName,
            yaml: input.yaml,
            source: input.source,
            delete: input.delete,
          }),
        ),
    );

    registerParsedTool(
      server,
      'sl_validate',
      {
        title: 'Semantic Layer Validate',
        description: 'Validate semantic-layer sources for a connection.',
        inputSchema: slValidateSchema.shape,
      },
      slValidateSchema,
      async (input) => jsonToolResult(await semanticLayer.validate(input)),
    );

    registerParsedTool(
      server,
      'sl_query',
      {
        title: 'Semantic Layer Query',
        description: 'Execute a semantic-layer query and return rows, headers, SQL, and the query plan.',
        inputSchema: slQuerySchema.shape,
      },
      slQuerySchema,
      async (input) =>
        jsonToolResult(
          await semanticLayer.query({
            connectionId: input.connectionId,
            query: {
              measures: input.measures,
              dimensions: input.dimensions,
              filters: input.filters,
              segments: input.segments,
              order_by: input.order_by,
              limit: input.limit,
              include_empty: input.include_empty,
            },
          }),
        ),
    );
  }

  if (ports.entityDetails) {
    const entityDetails = ports.entityDetails;
    registerParsedTool(
      server,
      'entity_details',
      {
        title: 'Entity Details',
        description: 'Read raw table and column metadata from the latest KTX live-database scan snapshot.',
        inputSchema: entityDetailsSchema.shape,
      },
      entityDetailsSchema,
      async (input) => jsonToolResult(await entityDetails.read(input)),
    );
  }

  if (ports.sqlExecution) {
    const sqlExecution = ports.sqlExecution;
    registerParsedTool(
      server,
      'sql_execution',
      {
        title: 'SQL Execution',
        description:
          'Execute one parser-validated read-only SQL query against a configured KTX connection and return structured rows.',
        inputSchema: sqlExecutionSchema.shape,
      },
      sqlExecutionSchema,
      async (input) => {
        try {
          return jsonToolResult(
            await sqlExecution.execute({
              connectionId: input.connectionId,
              sql: input.sql,
              maxRows: input.maxRows ?? 1000,
            }),
          );
        } catch (error) {
          return jsonErrorToolResult(error instanceof Error ? error.message : String(error));
        }
      },
    );
  }

  if (ports.ingest) {
    const ingest = ports.ingest;
    registerParsedTool(
      server,
      'ingest_trigger',
      {
        title: 'Ingest Trigger',
        description: 'Trigger a KTX ingest run for an adapter and connection.',
        inputSchema: ingestTriggerSchema.shape,
      },
      ingestTriggerSchema,
      async (input) => jsonToolResult(await ingest.trigger(input)),
    );

    registerParsedTool(
      server,
      'ingest_status',
      {
        title: 'Ingest Status',
        description:
          'Read the current or final status for an ingest run, including local diff and work-unit summaries when available.',
        inputSchema: ingestStatusSchema.shape,
      },
      ingestStatusSchema,
      async (input) => {
        const status = await ingest.status(input);
        return status ? jsonToolResult(status) : jsonErrorToolResult(`Ingest run "${input.runId}" was not found.`);
      },
    );

    if (ingest.report) {
      registerParsedTool(
        server,
        'ingest_report',
        {
          title: 'Ingest Report',
          description: 'Read the stored canonical KTX ingest report for a local run id, job id, or report id.',
          inputSchema: ingestReportSchema.shape,
        },
        ingestReportSchema,
        async (input) => {
          const report = await ingest.report?.(input);
          return report ? jsonToolResult(report) : jsonErrorToolResult(`Ingest report "${input.runId}" was not found.`);
        },
      );
    }

    if (ingest.replay) {
      registerParsedTool(
        server,
        'ingest_replay',
        {
          title: 'Ingest Replay',
          description: 'Read the memory-flow replay snapshot for a stored canonical KTX ingest run.',
          inputSchema: ingestReplaySchema.shape,
        },
        ingestReplaySchema,
        async (input) => {
          const replay = await ingest.replay?.(input);
          return replay ? jsonToolResult(replay) : jsonErrorToolResult(`Ingest replay "${input.runId}" was not found.`);
        },
      );
    }
  }

  if (ports.scan) {
    const scan = ports.scan;
    registerParsedTool(
      server,
      'scan_trigger',
      {
        title: 'Scan Trigger',
        description: 'Run a standalone KTX structural connection scan and return its report summary.',
        inputSchema: scanTriggerSchema.shape,
      },
      scanTriggerSchema,
      async (input) => jsonToolResult(await scan.trigger(input)),
    );

    registerParsedTool(
      server,
      'scan_status',
      {
        title: 'Scan Status',
        description: 'Read the current or final status for a standalone KTX scan run.',
        inputSchema: scanStatusSchema.shape,
      },
      scanStatusSchema,
      async (input) => {
        const status = await scan.status(input);
        return status ? jsonToolResult(status) : jsonErrorToolResult(`Scan run "${input.runId}" was not found.`);
      },
    );

    registerParsedTool(
      server,
      'scan_report',
      {
        title: 'Scan Report',
        description: 'Read a standalone KTX scan report by run id.',
        inputSchema: scanStatusSchema.shape,
      },
      scanStatusSchema,
      async (input) => {
        const report = await scan.report(input);
        return report ? jsonToolResult(report) : jsonErrorToolResult(`Scan report "${input.runId}" was not found.`);
      },
    );

    if (scan.listArtifacts) {
      registerParsedTool(
        server,
        'scan_list_artifacts',
        {
          title: 'Scan List Artifacts',
          description: 'List report, raw-source, manifest, and enrichment artifact paths for a standalone KTX scan run.',
          inputSchema: scanStatusSchema.shape,
        },
        scanStatusSchema,
        async (input) => {
          const result = await scan.listArtifacts?.({ runId: input.runId });
          return result ? jsonToolResult(result) : jsonErrorToolResult(`Scan run "${input.runId}" was not found.`);
        },
      );
    }

    if (scan.readArtifact) {
      registerParsedTool(
        server,
        'scan_read_artifact',
        {
          title: 'Scan Read Artifact',
          description: 'Read one artifact that belongs to a standalone KTX scan run.',
          inputSchema: scanArtifactReadSchema.shape,
        },
        scanArtifactReadSchema,
        async (input) => {
          const result = await scan.readArtifact?.({ runId: input.runId, path: input.path });
          return result
            ? jsonToolResult(result)
            : jsonErrorToolResult(`Scan artifact "${input.path}" was not found for run "${input.runId}".`);
        },
      );
    }
  }
}
