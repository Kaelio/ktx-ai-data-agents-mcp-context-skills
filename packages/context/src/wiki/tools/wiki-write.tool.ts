import { z } from 'zod';
import type { KnowledgeIndexPort } from '../ports.js';
import type { KnowledgeEventPort } from '../ports.js';
type BlockScope = 'GLOBAL' | 'USER';
import { KnowledgeWikiService, type WikiFrontmatter } from '../index.js';
import { applySqlEdits } from '../../tools/sql-edit-replacer.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../tools/index.js';

const MAX_USER_BLOCKS = 100;
const SYSTEM_AUTHOR = 'System User';
const SYSTEM_EMAIL = 'system@example.com';

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

const wikiWriteInputSchema = z.object({
  key: z.string().max(120),
  summary: z.string().max(200),
  content: z.string().max(4000).optional(),
  replacements: z
    .array(z.object({ oldText: z.string(), newText: z.string(), reason: z.string().optional() }))
    .optional(),
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

type WikiWriteInput = z.infer<typeof wikiWriteInputSchema>;

interface WikiWriteStructured {
  success: boolean;
  key: string;
  action?: 'created' | 'updated';
}

function looksLikeEscapedMarkdown(content: string): boolean {
  const withoutInlineCode = content.replace(/`[^`]*`/g, '');
  return /\\n\\n|(?:^|\\n)#{1,6}\s|\\n[-*]\s|\\n\d+\.\s|\\n```|\\n\|/.test(withoutInlineCode);
}

function normalizeAccidentalEscapedMarkdownNewlines(content: string): string {
  const escapedBreaks = content.match(/\\[rn]/g)?.length ?? 0;
  if (escapedBreaks < 2) return content;

  const actualBreaks = content.match(/\r?\n/g)?.length ?? 0;
  if (actualBreaks > 0 && escapedBreaks <= actualBreaks * 4) return content;
  if (!looksLikeEscapedMarkdown(content)) return content;

  return content.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
}

export class WikiWriteTool extends BaseTool<typeof wikiWriteInputSchema> {
  readonly name = 'wiki_write';

  constructor(
    private readonly wikiService: KnowledgeWikiService,
    private readonly pagesRepository: KnowledgeIndexPort,
    private readonly knowledgeRepository: KnowledgeEventPort,
  ) {
    super();
  }

  get description(): string {
    return `<purpose>
Create or update a knowledge page. Provide content for create/rewrite, or replacements for targeted edits.
For existing pages, you may provide only frontmatter fields such as summary, tags, refs, or sl_refs to update metadata while preserving content.
tags/refs/sl_refs use REPLACE semantics: omit to keep existing on update, [] to clear, [values] to set.
</purpose>`;
  }

  get inputSchema() {
    return wikiWriteInputSchema;
  }

  async call(input: WikiWriteInput, context: ToolContext): Promise<ToolOutput<WikiWriteStructured>> {
    const wikiService = context.session?.wikiService ?? this.wikiService;
    const writesGlobal = !!context.session;
    const skipIndex = context.session?.isWorktreeScoped === true;

    const scope: BlockScope = writesGlobal ? 'GLOBAL' : 'USER';
    const scopeId = scope === 'USER' ? context.userId : null;
    const existing = await wikiService.readPage(scope, scopeId, input.key);

    const content = input.content;
    const hasContent = typeof content === 'string' && content.length > 0;
    const hasReplacements = !!input.replacements && input.replacements.length > 0;
    if (!existing && !hasContent && !hasReplacements) {
      return {
        markdown: 'Error: provide either content (for create/rewrite) or replacements (for edits).',
        structured: { success: false, key: input.key },
      };
    }

    if (!existing && !input.content) {
      return {
        markdown: `Page "${input.key}" does not exist. Provide content to create it.`,
        structured: { success: false, key: input.key },
      };
    }

    if (scope === 'USER' && !existing) {
      const count = await this.pagesRepository.getUserPageCount(context.userId);
      if (count >= MAX_USER_BLOCKS) {
        return {
          markdown: `Cannot create "${input.key}": user has reached the limit of ${MAX_USER_BLOCKS} pages.`,
          structured: { success: false, key: input.key },
        };
      }
    }

    const existingFm = existing?.frontmatter;
    const resolvedTags = input.tags === undefined ? existingFm?.tags : input.tags;
    const resolvedRefs = input.refs === undefined ? existingFm?.refs : input.refs;
    const resolvedSlRefs = input.sl_refs === undefined ? existingFm?.sl_refs : input.sl_refs;

    let finalContent: string;
    const finalFm: WikiFrontmatter = {
      summary: input.summary,
      usage_mode: existingFm?.usage_mode ?? 'auto',
      sort_order: existingFm?.sort_order ?? 0,
      tags: resolvedTags,
      refs: resolvedRefs,
      sl_refs: resolvedSlRefs,
      source: input.source === undefined ? existingFm?.source : input.source,
      intent: input.intent === undefined ? existingFm?.intent : input.intent,
      tables: input.tables === undefined ? existingFm?.tables : input.tables,
      representative_sql:
        input.representative_sql === undefined ? existingFm?.representative_sql : input.representative_sql,
      usage: input.usage === undefined ? existingFm?.usage : input.usage,
      fingerprints: input.fingerprints === undefined ? existingFm?.fingerprints : input.fingerprints,
    };

    if (hasContent) {
      finalContent = normalizeAccidentalEscapedMarkdownNewlines(content);
    } else if (hasReplacements) {
      const editResult = applySqlEdits(existing?.content ?? '', input.replacements ?? []);
      if (!editResult.success) {
        return {
          markdown: `Edit errors: ${editResult.errors.join('; ')}`,
          structured: { success: false, key: input.key },
        };
      }
      finalContent = editResult.sql;
    } else {
      finalContent = existing?.content ?? '';
    }

    await wikiService.writePage(scope, scopeId, input.key, finalFm, finalContent, SYSTEM_AUTHOR, SYSTEM_EMAIL);
    if (!skipIndex) {
      await wikiService.syncSinglePage(scope, scopeId, input.key, finalFm, finalContent);
    }

    await this.knowledgeRepository.createEvent({
      blockId: null,
      eventType: existing ? 'BLOCK_UPDATED' : 'BLOCK_CREATED',
      actorId: context.userId,
      chatId: null,
      messageId: null,
      payload: {
        pageKey: input.key,
        previousContent: existing ? existing.content.slice(0, 500) : null,
      },
    });

    const action = existing ? 'updated' : 'created';
    if (context.session) {
      context.session.actions.push({ target: 'wiki', type: action, key: input.key, detail: input.summary });
    }

    return {
      markdown: `Page "${input.key}" ${action}.`,
      structured: { success: true, key: input.key, action },
    };
  }
}
