import { z } from 'zod';
import type { KnowledgeIndexPort } from '../ports.js';
import type { KnowledgeEventPort } from '../ports.js';
type BlockScope = 'GLOBAL' | 'USER';
import { KnowledgeWikiService } from '../../../context/wiki/knowledge-wiki.service.js';
import { validateFlatWikiKey } from '../keys.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../context/tools/base-tool.js';
import { validateActionRawPaths } from '../../../context/tools/action-raw-paths.js';

const SYSTEM_AUTHOR = 'System User';
const SYSTEM_EMAIL = 'system@example.com';

const wikiRemoveInputSchema = z.object({
  key: z.string().describe('The page key to remove'),
  rawPaths: z
    .array(z.string().min(1))
    .optional()
    .describe('In ingest sessions, raw source file paths that directly support this removal.'),
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
    return `<purpose>Remove a wiki page that is no longer relevant.</purpose>`;
  }

  get inputSchema() {
    return wikiRemoveInputSchema;
  }

  async call(input: WikiRemoveInput, context: ToolContext): Promise<ToolOutput<WikiRemoveStructured>> {
    const wikiService = context.session?.wikiService ?? this.wikiService;
    const writesGlobal = !!context.session;
    const skipIndex = context.session?.isWorktreeScoped === true;
    const keyValidation = validateFlatWikiKey(input.key);
    if (!keyValidation.ok) {
      return {
        markdown: keyValidation.error,
        structured: { success: false, key: input.key },
      };
    }
    const rawPathValidation = validateActionRawPaths(context.session, input.rawPaths);
    if (!rawPathValidation.ok) {
      return {
        markdown: `Error: ${rawPathValidation.error}`,
        structured: { success: false, key: input.key },
      };
    }

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
        ...(rawPathValidation.rawPaths ? { rawPaths: rawPathValidation.rawPaths } : {}),
      });
    }

    return {
      markdown: `Page "${input.key}" removed.`,
      structured: { success: true, key: input.key },
    };
  }
}
