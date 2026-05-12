import { z } from 'zod';
import { DEFAULT_PRIORITY, resolveDescription } from '../descriptions.js';
import type { SemanticLayerService } from '../semantic-layer.service.js';
import type { SemanticLayerSource } from '../types.js';
import type { ToolContext, ToolOutput } from '../../tools/index.js';
import { BaseSemanticLayerTool, type BaseSemanticLayerToolDeps } from './base-semantic-layer.tool.js';
import { slToolConnectionIdSchema } from './connection-id-schema.js';

export interface SlDiscoverySettings {
  maxSources: number;
  minRrfScore: number;
  maxDetailedSources: number;
}

const slDiscoverInputSchema = z.object({
  connectionId: slToolConnectionIdSchema
    .optional()
    .describe('Data source connection ID (omit to discover across all data sources)'),
  query: z.string().optional().describe('Search query to filter sources/columns/measures by name or description'),
  sourceName: z
    .string()
    .optional()
    .describe('Inspect a specific source in full detail (requires connectionId if multiple data sources)'),
});

type SlDiscoverInput = z.infer<typeof slDiscoverInputSchema>;

interface SlDiscoverStructured {
  sources: Array<{
    connectionId: string;
    connectionName: string;
    name: string;
    description?: string;
    columnCount: number;
    measureCount: number;
    joinCount: number;
  }>;
  detail?: Record<string, unknown>;
  totalSources: number;
}

export class SlDiscoverTool extends BaseSemanticLayerTool<typeof slDiscoverInputSchema> {
  readonly name = 'sl_discover';

  constructor(
    deps: BaseSemanticLayerToolDeps,
    private readonly discoverySettings: SlDiscoverySettings,
  ) {
    super(deps);
  }

  get description(): string {
    return `<purpose>
Discover available semantic layer sources, columns, measures, and joins.
When called without a connectionId, discovers sources across ALL data sources — grouped by data source name and ID.
Use this to understand what data is available before writing a semantic_query.
</purpose>

<when_to_use>
- Before querying: understand available sources across all data sources
- To inspect a specific source in detail (columns, joins, measures, grain) — requires connectionId when multiple data sources exist
- To search for sources related to a concept (e.g., "revenue", "customers") across all data sources
</when_to_use>`;
  }

  get inputSchema() {
    return slDiscoverInputSchema;
  }

  async call(input: SlDiscoverInput, context: ToolContext): Promise<ToolOutput<SlDiscoverStructured>> {
    const { query, sourceName } = input;
    const semanticLayerService = context.session?.semanticLayerService ?? this.semanticLayerService;

    // Resolve connectionId: use provided value, or auto-detect
    let connectionId = input.connectionId;
    if (!connectionId) {
      const connections = await semanticLayerService.listConnectionIdsWithNames();
      if (connections.length === 0) {
        return {
          markdown: 'No semantic layer sources found. Run a schema scan first.',
          structured: { sources: [], totalSources: 0 },
        };
      }
      if (connections.length === 1) {
        connectionId = connections[0].id;
      } else {
        // Multiple connections — aggregate or prompt depending on operation
        if (sourceName) {
          const connectionList = connections
            .map((c) => `- **${c.name}** (${c.connectionType}): \`${c.id}\``)
            .join('\n');
          return {
            markdown: `Multiple data sources have semantic layer sources. Specify a connectionId to inspect source "${sourceName}":\n\n${connectionList}`,
            structured: { sources: [], totalSources: 0 },
          };
        }
        return this.discoverAcrossConnections(semanticLayerService, connections, query);
      }
    }

    // If inspecting a specific source — show the SL interface (columns, measures, joins)
    // without the raw SQL. Use `sl_read_source` to see the full YAML including SQL.
    if (sourceName) {
      const sources = await semanticLayerService.loadAllSources(connectionId);
      const source = sources.find((s) => s.name === sourceName);
      if (!source) {
        return {
          markdown: `Source **${sourceName}** not found for this connection.`,
          structured: { sources: [], totalSources: 0 },
        };
      }

      const parts: string[] = [];
      this.appendSourceDetail(parts, source);

      if (source.grain?.length) {
        parts.push(`Grain: ${source.grain.join(', ')}`);
      }

      return {
        markdown: parts.join('\n'),
        structured: {
          sources: [
            {
              connectionId,
              connectionName: connectionId,
              name: source.name,
              description:
                resolveDescription(source.descriptions, { priority: DEFAULT_PRIORITY }) ?? undefined,
              columnCount: source.columns.length,
              measureCount: source.measures.length,
              joinCount: source.joins.length,
            },
          ],
          totalSources: 1,
        },
      };
    }

    // Single connection: list all sources
    const connections = await semanticLayerService.listConnectionIdsWithNames();
    const connInfo = connections.find((c) => c.id === connectionId);
    return this.discoverForConnection(semanticLayerService, connectionId, connInfo?.name ?? connectionId, query);
  }

  private async discoverAcrossConnections(
    semanticLayerService: SemanticLayerService,
    connections: Array<{ id: string; name: string; connectionType: string }>,
    query?: string,
  ): Promise<ToolOutput<SlDiscoverStructured>> {
    // Load sources from all connections in parallel
    const results = await Promise.all(
      connections.map(async (conn) => {
        const sources = await semanticLayerService.loadAllSources(conn.id);
        let filtered = sources;
        if (query) {
          filtered = await this.filterByQuery(conn.id, sources, query);
        }
        return { conn, sources: filtered };
      }),
    );

    const allSummaries: SlDiscoverStructured['sources'] = [];
    const parts: string[] = [];
    let totalSources = 0;

    for (const { conn, sources } of results) {
      if (sources.length === 0) {
        continue;
      }
      totalSources += sources.length;

      parts.push(`## ${conn.name} (${conn.connectionType}) — \`${conn.id}\``);
      parts.push('');

      const config = { priority: DEFAULT_PRIORITY };
      for (const s of sources) {
        allSummaries.push({
          connectionId: conn.id,
          connectionName: conn.name,
          name: s.name,
          description: resolveDescription(s.descriptions, config) ?? undefined,
          columnCount: (s.columns ?? []).length,
          measureCount: (s.measures ?? []).length,
          joinCount: (s.joins ?? []).length,
        });
      }

      this.appendTieredSources(parts, sources, !!query);
    }

    if (totalSources === 0) {
      return {
        markdown: query
          ? `No semantic layer sources found matching "${query}".`
          : 'No semantic layer sources found. Run a schema scan first, or create sources with sl_write_source.',
        structured: { sources: [], totalSources: 0 },
      };
    }

    const header = `**${totalSources} source(s) found across ${results.filter((r) => r.sources.length > 0).length} data source(s)**${query ? ` matching "${query}"` : ''}:\n`;
    parts.unshift(header);

    return {
      markdown: parts.join('\n'),
      structured: { sources: allSummaries, totalSources },
    };
  }

  private async discoverForConnection(
    semanticLayerService: SemanticLayerService,
    connectionId: string,
    connectionName: string,
    query?: string,
  ): Promise<ToolOutput<SlDiscoverStructured>> {
    const sources = await semanticLayerService.loadAllSources(connectionId);

    if (sources.length === 0) {
      return {
        markdown: 'No semantic layer sources found. Run a schema scan first, or create sources with sl_write_source.',
        structured: { sources: [], totalSources: 0 },
      };
    }

    const filtered = query ? await this.filterByQuery(connectionId, sources, query) : sources;

    const config = { priority: DEFAULT_PRIORITY };
    const summaries = filtered.map((s) => ({
      connectionId,
      connectionName,
      name: s.name,
      description: resolveDescription(s.descriptions, config) ?? undefined,
      columnCount: (s.columns ?? []).length,
      measureCount: (s.measures ?? []).length,
      joinCount: (s.joins ?? []).length,
    }));

    const parts: string[] = [`**${filtered.length} source(s) found**${query ? ` matching "${query}"` : ''}:\n`];

    this.appendTieredSources(parts, filtered, !!query);

    return {
      markdown: parts.join('\n'),
      structured: { sources: summaries, totalSources: filtered.length },
    };
  }

  private async filterByQuery(
    connectionId: string,
    sources: SemanticLayerSource[],
    query: string,
  ): Promise<SemanticLayerSource[]> {
    const config = this.discoverySettings;
    const searchResults = await this.slSearchService.search(connectionId, query, config.maxSources, config.minRrfScore);
    if (searchResults.length > 0) {
      const rankedNames = new Set(searchResults.map((r) => r.sourceName));
      const nameOrder = new Map(searchResults.map((r, i) => [r.sourceName, i]));
      return sources
        .filter((s) => rankedNames.has(s.name))
        .sort((a, b) => (nameOrder.get(a.name) ?? 0) - (nameOrder.get(b.name) ?? 0));
    }
    return this.fallbackTermMatch(sources, query);
  }

  private fallbackTermMatch(sources: SemanticLayerSource[], query: string): SemanticLayerSource[] {
    const config = { priority: DEFAULT_PRIORITY };
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = sources
      .map((s) => {
        const searchText = [
          s.name,
          resolveDescription(s.descriptions, config) ?? '',
          ...s.columns.map((c) => `${c.name} ${resolveDescription(c.descriptions, config) ?? ''}`),
          ...s.measures.map((m) => `${m.name} ${m.description ?? ''}`),
        ]
          .join(' ')
          .toLowerCase();
        const matchCount = terms.filter((term) => searchText.includes(term)).length;
        return { source: s, matchCount };
      })
      .filter((x) => x.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount);
    return scored.map((x) => x.source);
  }

  /**
   * Render sources in two tiers:
   * - Top N (ranked by relevance when query is present) get full detail
   * - Remaining sources get a one-liner with name, description, and measure count
   */
  private appendTieredSources(parts: string[], sources: SemanticLayerSource[], hasQuery: boolean): void {
    const maxDetailed = this.discoverySettings.maxDetailedSources;
    const detailLimit = hasQuery ? maxDetailed : 0;
    const detailed = sources.slice(0, detailLimit);
    const rest = sources.slice(detailLimit);

    for (const s of detailed) {
      this.appendSourceDetail(parts, s);
    }

    if (rest.length > 0) {
      if (detailed.length > 0) {
        parts.push('**Other sources** (pass `sourceName` to inspect):');
      }
      const defaultConfig = { priority: DEFAULT_PRIORITY };
      for (const s of rest) {
        const resolvedDesc = resolveDescription(s.descriptions, defaultConfig);
        const desc = resolvedDesc ? ` — ${resolvedDesc}` : '';
        const stats = [s.measures.length > 0 ? `${s.measures.length} measures` : null, `${s.columns.length} cols`]
          .filter(Boolean)
          .join(', ');
        parts.push(`- **${s.name}**${desc} (${stats})`);
      }
      parts.push('');
    }
  }

  /** Full detail for a single source: metadata, measures, joins, all public columns. */
  private appendSourceDetail(parts: string[], s: SemanticLayerSource): void {
    const detailDesc = resolveDescription(s.descriptions, { priority: DEFAULT_PRIORITY });
    parts.push(`### ${s.name}${detailDesc ? ` — ${detailDesc}` : ''}`);
    parts.push(
      `Type: ${s.sql ? 'sql' : 'table'} | Columns: ${s.columns.length} | Measures: ${s.measures.length} | Joins: ${s.joins.length}`,
    );

    if (s.measures.length > 0) {
      parts.push(`Measures: ${s.measures.map((m) => `\`${m.name}\` (${m.expr})`).join(', ')}`);
    }

    if (s.joins.length > 0) {
      parts.push(`Joins: ${s.joins.map((j) => `→ ${j.to} (${j.relationship})`).join(', ')}`);
    }

    const publicCols = s.columns.filter((c) => c.visibility !== 'hidden');
    if (publicCols.length > 0) {
      parts.push(`Columns: ${publicCols.map((c) => `\`${s.name}.${c.name}\` (${c.type})`).join(', ')}`);
    }

    parts.push('');
  }
}
