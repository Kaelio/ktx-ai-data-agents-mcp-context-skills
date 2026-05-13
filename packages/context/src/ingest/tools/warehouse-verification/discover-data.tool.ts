import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../tools/index.js';
import { WarehouseCatalogService, type RawSchemaHit } from './warehouse-catalog.service.js';

const discoverDataInputSchema = z.object({
  query: z.string().optional(),
  connectionName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
  limit: z.number().int().positive().max(50).optional().default(10),
  sourceName: z.string().optional(),
});

type DiscoverDataInput = z.input<typeof discoverDataInputSchema>;

export interface DiscoverDataStructured {
  wiki: unknown | null;
  sl: unknown | null;
  raw: { hits: RawSchemaHit[] } | null;
}

interface DiscoverDataDeps {
  wikiSearchTool: BaseTool;
  slDiscoverTool: BaseTool;
  catalogFactory: (context: ToolContext) => WarehouseCatalogService;
}

function totalFound(structured: unknown): number {
  return typeof structured === 'object' &&
    structured !== null &&
    'totalFound' in structured &&
    typeof structured.totalFound === 'number'
    ? structured.totalFound
    : 0;
}

function totalSources(structured: unknown): number {
  return typeof structured === 'object' &&
    structured !== null &&
    'totalSources' in structured &&
    typeof structured.totalSources === 'number'
    ? structured.totalSources
    : 0;
}

function allowedConnectionNames(context: ToolContext): ReadonlySet<string> | null {
  return context.session?.allowedConnectionNames ?? null;
}

export class DiscoverDataTool extends BaseTool<typeof discoverDataInputSchema> {
  readonly name = 'discover_data';

  constructor(private readonly deps: DiscoverDataDeps) {
    super();
  }

  get description(): string {
    return 'Discover existing wiki pages, semantic layer sources, and raw warehouse schema hits before writing ingest output.';
  }

  get inputSchema() {
    return discoverDataInputSchema;
  }

  async call(input: DiscoverDataInput, context: ToolContext): Promise<ToolOutput<DiscoverDataStructured>> {
    const allowed = allowedConnectionNames(context);
    if (input.connectionName && allowed && !allowed.has(input.connectionName)) {
      return {
        markdown: `Connection "${input.connectionName}" is not available to this ingest stage.`,
        structured: { wiki: null, sl: null, raw: null },
      };
    }

    if (input.sourceName) {
      const sl = await this.deps.slDiscoverTool.call(
        { sourceName: input.sourceName, connectionId: input.connectionName },
        context,
      );
      return { markdown: sl.markdown, structured: { wiki: null, sl: sl.structured, raw: null } };
    }

    const query = input.query?.trim() || '';
    const limit = input.limit ?? 10;
    const parts: string[] = [];
    let wiki: unknown | null = null;
    let sl: unknown | null = null;
    let raw: DiscoverDataStructured['raw'] = null;

    if (query) {
      const wikiResult = await this.deps.wikiSearchTool.call({ query, limit }, context);
      if (totalFound(wikiResult.structured) > 0) {
        parts.push('## Wiki Pages', '> use `wiki_read(blockKey)` for full content', wikiResult.markdown, '');
        wiki = wikiResult.structured;
      }
    }

    const slResult = await this.deps.slDiscoverTool.call(
      { query: query || undefined, connectionId: input.connectionName },
      context,
    );
    if (totalSources(slResult.structured) > 0) {
      parts.push(
        '## Semantic Layer Sources',
        '> use `sl_read_source(sourceName)` for the YAML, or `entity_details` for warehouse-shape details',
        slResult.markdown,
        '',
      );
      sl = slResult.structured;
    }

    const catalog = this.deps.catalogFactory(context);
    const connections = input.connectionName ? [input.connectionName] : [...(allowed ?? [])].sort();
    const rawHits: RawSchemaHit[] = [];
    for (const connectionName of connections) {
      rawHits.push(...(await catalog.searchByName(connectionName, query, limit)));
    }
    if (rawHits.length > 0) {
      parts.push(
        '## Raw Warehouse Schema',
        '> use `entity_details({connectionName, targets: [{display}]})` for full DDL + sample values',
      );
      parts.push(
        rawHits
          .slice(0, limit)
          .map(
            (hit) =>
              `- ${hit.kind}: ${hit.display} [connectionName=${hit.connectionName}] (matched on ${hit.matchedOn}) - ` +
              `follow up with \`entity_details({connectionName: "${hit.connectionName}", targets: [{display: "${hit.display}"}]})\``,
          )
          .join('\n'),
      );
      raw = { hits: rawHits.slice(0, limit) };
    }

    if (parts.length === 0) {
      return {
        markdown: `No matches for "${query}" across wiki, semantic layer, or raw warehouse schema. Try broader terms; this concept may not exist yet.`,
        structured: { wiki, sl, raw },
      };
    }

    return { markdown: parts.join('\n'), structured: { wiki, sl, raw } };
  }
}
