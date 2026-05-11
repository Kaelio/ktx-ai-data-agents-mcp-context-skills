import { z } from 'zod';
import type { KnowledgeIndexPort } from '../ports.js';
import { KnowledgeWikiService } from '../index.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../tools/index.js';

const WikiReadInputSchema = z.object({
  key: z
    .string()
    .describe('The block_key to read. Check the <knowledge_index> in the system prompt for available keys.'),
});

type WikiReadInput = z.infer<typeof WikiReadInputSchema>;

interface WikiReadStructured {
  blockKey: string;
  content: string;
  scope: string;
  found: boolean;
  tags?: string[];
  refs?: string[];
}

export class WikiReadTool extends BaseTool<typeof WikiReadInputSchema> {
  readonly name = 'wiki_read';

  constructor(
    private readonly wikiService: KnowledgeWikiService,
    private readonly pagesRepository: KnowledgeIndexPort,
  ) {
    super();
  }

  get description(): string {
    return (
      'Load the full content of a knowledge block by its key. ' +
      'Use this to retrieve detailed rules, preferences, or definitions listed in the <knowledge_index>. ' +
      'Call this when the user query relates to a topic covered by an available knowledge block.'
    );
  }

  get inputSchema() {
    return WikiReadInputSchema;
  }

  async call(input: WikiReadInput, context: ToolContext): Promise<ToolOutput<WikiReadStructured>> {
    const wikiService = context.session?.wikiService ?? this.wikiService;
    const page = await wikiService.readPageForUser(context.userId, input.key);

    if (!page) {
      return {
        markdown: `No knowledge block found with key "${input.key}".`,
        structured: { blockKey: input.key, content: '', scope: '', found: false },
      };
    }

    const indexEntry = await this.pagesRepository.findPageByKey(
      page.scope,
      page.scope === 'USER' ? context.userId : null,
      input.key,
    );
    if (indexEntry?.id) {
      void this.pagesRepository.incrementUsageCount([indexEntry.id]);
    }

    let md = `## ${page.pageKey}\n\n${page.content}`;
    const refs = page.frontmatter.refs;
    if (refs && refs.length > 0) {
      md += `\n\nSee also: ${refs.map((r) => `[[${r}]]`).join(', ')}`;
    }

    return {
      markdown: md,
      structured: {
        blockKey: page.pageKey,
        content: page.content,
        scope: page.scope,
        found: true,
        tags: page.frontmatter.tags,
        refs: page.frontmatter.refs,
      },
    };
  }
}
