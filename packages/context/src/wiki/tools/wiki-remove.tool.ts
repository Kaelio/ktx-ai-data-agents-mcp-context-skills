import { z } from 'zod';
import type { KnowledgeIndexPort } from '../ports.js';
import type { KnowledgeEventPort } from '../ports.js';
type BlockScope = 'GLOBAL' | 'USER';
import { KnowledgeWikiService } from '../index.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../tools/index.js';

const SYSTEM_AUTHOR = 'System User';
const SYSTEM_EMAIL = 'system@example.com';

const wikiRemoveInputSchema = z.object({
  key: z.string().describe('The page key to remove'),
});

type WikiRemoveInput = z.infer<typeof wikiRemoveInputSchema>;

interface WikiRemoveStructured {
  success: boolean;
  key: string;
}

export class WikiRemoveTool extends BaseTool<typeof wikiRemoveInputSchema> {
  readonly name = 'wiki_remove';

  constructor(
    private readonly wikiService: KnowledgeWikiService,
    private readonly pagesRepository: KnowledgeIndexPort,
    private readonly knowledgeRepository: KnowledgeEventPort,
  ) {
    super();
  }

  get description(): string {
    return `<purpose>Remove a knowledge page that is no longer relevant.</purpose>`;
  }

  get inputSchema() {
    return wikiRemoveInputSchema;
  }

  async call(input: WikiRemoveInput, context: ToolContext): Promise<ToolOutput<WikiRemoveStructured>> {
    const wikiService = context.session?.wikiService ?? this.wikiService;
    const writesGlobal = !!context.session;
    const skipIndex = context.session?.isWorktreeScoped === true;

    const scope: BlockScope = writesGlobal ? 'GLOBAL' : 'USER';
    const scopeId = scope === 'USER' ? context.userId : null;

    const existing = context.session
      ? await wikiService.readPage(scope, scopeId, input.key)
      : await this.pagesRepository.findPageByKey(scope, scopeId, input.key);
    if (!existing) {
      return {
        markdown: `Page "${input.key}" not found.`,
        structured: { success: false, key: input.key },
      };
    }

    await wikiService.deletePage(scope, scopeId, input.key, SYSTEM_AUTHOR, SYSTEM_EMAIL);
    if (!skipIndex) {
      await wikiService.deleteFromIndex(scope, scopeId, input.key);
    }

    await this.knowledgeRepository.createEvent({
      blockId: null,
      eventType: 'BLOCK_REMOVED',
      actorId: context.userId,
      chatId: null,
      messageId: null,
      payload: { removedKey: input.key, blockKey: input.key },
    });

    if (context.session) {
      context.session.actions.push({
        target: 'wiki',
        type: 'removed',
        key: input.key,
        detail: `Removed page "${input.key}"`,
      });
    }

    return {
      markdown: `Page "${input.key}" removed.`,
      structured: { success: true, key: input.key },
    };
  }
}
