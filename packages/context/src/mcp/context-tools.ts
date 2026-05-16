import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MemoryAgentInput } from '../memory/index.js';
import type { KtxMcpContextPorts, KtxMcpServerLike, KtxMcpToolResult, KtxMcpUserContext } from './types.js';

export interface RegisterKtxContextToolsDeps {
  server: KtxMcpServerLike;
  ports: KtxMcpContextPorts;
  userContext: KtxMcpUserContext;
}

const connectionIdSchema = z.string().min(1);

const connectionListSchema = z.object({});

const knowledgeSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});

const knowledgeReadSchema = z.object({
  key: z.string().min(1),
});

const slReadSourceSchema = z.object({
  connectionId: connectionIdSchema,
  sourceName: z.string().min(1),
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

const slQueryOrderBySchema = z.preprocess(
  (value) => {
    if (typeof value === 'string') {
      return { field: value };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = { ...(value as Record<string, unknown>) };
      if (!('field' in obj) && typeof obj.id === 'string') {
        obj.field = obj.id;
      }
      if (!('direction' in obj) && 'desc' in obj) {
        obj.direction = obj.desc === true ? 'desc' : 'asc';
      }
      return obj;
    }
    return value;
  },
  z.object({
    field: z
      .string()
      .min(1)
      .describe(
        'Field/measure/dimension id to order by, e.g. "orders.created_at", a dimension key like "mart_nrr_quarterly.quarter_label", or a measure alias.',
      ),
    direction: z
      .enum(['asc', 'desc'])
      .default('asc')
      .describe('Sort direction: "asc" or "desc". Defaults to "asc".'),
  }),
);

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

const dictionarySearchSchema = z.object({
  values: z.array(z.string().min(1)).min(1).max(20),
  connectionId: connectionIdSchema.optional(),
});

const discoverDataKindSchema = z.enum(['wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column']);

const discoverDataSchema = z.object({
  query: z.string().min(1),
  connectionId: connectionIdSchema.optional(),
  kinds: z.array(discoverDataKindSchema).optional(),
  limit: z.number().int().min(1).max(50).default(15).optional(),
});

const sqlExecutionSchema = z.object({
  connectionId: connectionIdSchema,
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(10_000).default(1000).optional(),
});

const memoryIngestSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'Free-form markdown to ingest. Include the knowledge itself plus any context (source, the user question, why this came up) that the memory agent should consider when triaging into wiki/SL.',
    ),
  connectionId: connectionIdSchema
    .optional()
    .describe(
      'Scope this memory to a specific connection. Required when the knowledge is warehouse-specific, including measure definitions, schema gotchas, or anything tied to a particular warehouse. Omit only for global wiki knowledge.',
    ),
});

const memoryIngestStatusSchema = z.object({
  runId: z.string().min(1).describe('The memory ingest run id returned by memory_ingest.'),
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
  }

  if (ports.semanticLayer) {
    const semanticLayer = ports.semanticLayer;
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
      'sl_query',
      {
        title: 'Semantic Layer Query',
        description:
          'Execute a semantic-layer query and return rows, headers, SQL, and the query plan. ' +
          'order_by items use the shape {"field": "orders.created_at", "direction": "asc"|"desc"}; ' +
          'a bare string is treated as field with direction "asc".',
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

  if (ports.dictionarySearch) {
    const dictionarySearch = ports.dictionarySearch;
    registerParsedTool(
      server,
      'dictionary_search',
      {
        title: 'Dictionary Search',
        description:
          'Search profile-sampled warehouse values and report matching connection/source/column locations plus non-authoritative miss reasons.',
        inputSchema: dictionarySearchSchema.shape,
      },
      dictionarySearchSchema,
      async (input) => jsonToolResult(await dictionarySearch.search(input)),
    );
  }

  if (ports.discover) {
    const discover = ports.discover;
    registerParsedTool(
      server,
      'discover_data',
      {
        title: 'Discover Data',
        description:
          'Search across KTX wiki pages, semantic-layer sources/measures/dimensions, and raw warehouse schema refs.',
        inputSchema: discoverDataSchema.shape,
      },
      discoverDataSchema,
      async (input) => jsonToolResult({ refs: await discover.search(input) }),
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

  if (ports.memoryIngest) {
    const memoryIngest = ports.memoryIngest;
    registerParsedTool(
      server,
      'memory_ingest',
      {
        title: 'Memory Ingest',
        description:
          'Ingest free-form markdown knowledge into KTX durable memory. Use this for business rules, metric definitions, schema gotchas, recurring findings, or explicit user requests to remember something.',
        inputSchema: memoryIngestSchema.shape,
      },
      memoryIngestSchema,
      async (input) => {
        const ingestInput: MemoryAgentInput = {
          userId: userContext.userId,
          chatId: `mcp-${randomUUID()}`,
          userMessage: 'Ingest external knowledge into KTX memory.',
          assistantMessage: input.content,
          connectionId: input.connectionId,
          sourceType: 'external_ingest',
        };
        return jsonToolResult(await memoryIngest.ingest(ingestInput));
      },
    );

    registerParsedTool(
      server,
      'memory_ingest_status',
      {
        title: 'Memory Ingest Status',
        description: 'Read the current or final status for a memory ingest run.',
        inputSchema: memoryIngestStatusSchema.shape,
      },
      memoryIngestStatusSchema,
      async (input) => {
        const status = await memoryIngest.status(input.runId);
        return status ? jsonToolResult(status) : jsonErrorToolResult(`Memory ingest run "${input.runId}" was not found.`);
      },
    );
  }
}
