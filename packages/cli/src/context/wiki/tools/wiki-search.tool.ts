import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolOutput } from '../../tools/index.js';
import type { WikiSearchLaneSummary, WikiSearchMatchReason } from '../types.js';

const WikiSearchInputSchema = z.object({
  query: z.string().describe('Natural language search query to find relevant knowledge blocks.'),
  limit: z.number().optional().default(10).describe('Maximum number of results to return (default 10).'),
});

type WikiSearchInput = z.infer<typeof WikiSearchInputSchema>;

interface WikiSearchResult {
  blockKey: string;
  path: string;
  summary: string;
  score: number;
  matchReasons?: WikiSearchMatchReason[];
  lanes?: WikiSearchLaneSummary[];
}

interface WikiSearchStructured {
  results: WikiSearchResult[];
  totalFound: number;
}

/** @internal */
export interface WikiSearchAdapterPort {
  search(input: { userId: string; query: string; limit: number }): Promise<{
    results: Array<{
      key: string;
      path: string;
      summary: string;
      score: number;
      matchReasons?: WikiSearchMatchReason[];
      lanes?: WikiSearchLaneSummary[];
    }>;
    totalFound: number;
  }>;
}

export class WikiSearchTool extends BaseTool<typeof WikiSearchInputSchema> {
  readonly name = 'wiki_search';

  constructor(private readonly searchAdapter: WikiSearchAdapterPort) {
    super();
  }

  get description(): string {
    return (
      'Search knowledge blocks. Active lanes vary by project storage: ' +
      'projects on sqlite-fts5 storage use hybrid lexical + token + semantic matching, ' +
      'others fall back to token-only matching. ' +
      'Inspect `lanes` and `matchReasons` on each result to see which lanes contributed. ' +
      'Use this when you need to find knowledge on a topic not visible in the discovery index. ' +
      'Returns ranked summaries — use wiki_read to load the full content of specific results.'
    );
  }

  get inputSchema() {
    return WikiSearchInputSchema;
  }

  async call(input: WikiSearchInput, context: ToolContext): Promise<ToolOutput<WikiSearchStructured>> {
    const response = await this.searchAdapter.search({
      userId: context.userId,
      query: input.query,
      limit: input.limit,
    });

    if (response.results.length === 0) {
      return {
        markdown: `No knowledge blocks found matching "${input.query}".`,
        structured: { results: [], totalFound: 0 },
      };
    }

    const lines = response.results.map((r, i) => `${i + 1}. **${r.key}**: ${r.summary}`);

    const structured: WikiSearchStructured = {
      results: response.results.map((r) => ({
        blockKey: r.key,
        path: r.path,
        summary: r.summary,
        score: r.score,
        matchReasons: r.matchReasons,
        lanes: r.lanes,
      })),
      totalFound: response.totalFound,
    };

    return {
      markdown: `Found ${response.results.length} knowledge block(s):\n\n${lines.join('\n')}`,
      structured,
    };
  }
}
