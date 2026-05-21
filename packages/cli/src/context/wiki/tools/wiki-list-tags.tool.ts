import { z } from 'zod';
import type { KnowledgeIndexPort } from '../ports.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../tools/index.js';

const wikiListTagsInputSchema = z.object({});

type WikiListTagsInput = z.infer<typeof wikiListTagsInputSchema>;

export class WikiListTagsTool extends BaseTool<typeof wikiListTagsInputSchema> {
  readonly name = 'wiki_list_tags';

  constructor(private readonly pagesRepository: KnowledgeIndexPort) {
    super();
  }

  get description(): string {
    return `<purpose>
List distinct topic tags across all wiki pages visible to the user.
Call before writing a new page so you can reuse existing tags consistently instead of coining near-duplicates.
</purpose>`;
  }

  get inputSchema() {
    return wikiListTagsInputSchema;
  }

  async call(_input: WikiListTagsInput, context: ToolContext): Promise<ToolOutput<{ tags: string[] }>> {
    const pages = await this.pagesRepository.listPagesForUser(context.userId);
    const set = new Set<string>();
    for (const p of pages) {
      for (const t of p.tags) {
        set.add(t);
      }
    }
    const tags = [...set].sort();
    return {
      markdown: tags.length === 0 ? '(no tags in use yet)' : tags.join(', '),
      structured: { tags },
    };
  }
}
