import { z } from 'zod';
import type { KnowledgeIndexPort } from '../ports.js';
import { KnowledgeWikiService } from '../../../context/wiki/knowledge-wiki.service.js';
import { validateFlatWikiKey } from '../keys.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../context/tools/base-tool.js';

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
      'The markdown output is the exact stored page body; use it verbatim for wiki_write replacements. ' +
      'Call this when the user query relates to a topic covered by an available knowledge block.'
    );
  }

  get inputSchema() {
    return WikiReadInputSchema;
  }

  async call(input: WikiReadInput, context: ToolContext): Promise<ToolOutput<WikiReadStructured>> {
    const keyValidation = validateFlatWikiKey(input.key);
    if (!keyValidation.ok) {
      return {
        markdown: keyValidation.error,
        structured: { blockKey: input.key, content: '', scope: '', found: false },
      };
    }
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

    return {
      markdown: page.content,
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
