import { type Command, Option } from '@commander-js/extra-typings';
import {
  collectOption,
  type KtxCliCommandContext,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import { wikiWriteCommandSchema } from '../command-schemas.js';
import type { KtxKnowledgeArgs } from '../knowledge.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/knowledge-commands');

async function runKnowledgeArgs(context: KtxCliCommandContext, args: KtxKnowledgeArgs): Promise<void> {
  const runner = context.deps.knowledge ?? (await import('../knowledge.js')).runKtxKnowledge;
  context.setExitCode(await runner(args, context.io));
}

export function registerWikiCommands(program: Command, context: KtxCliCommandContext): void {
  const wiki = program
    .command('wiki')
    .description('List, read, search, or write local wiki pages')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    );

  wiki
    .command('list')
    .description('List local wiki pages')
    .option('--json', 'Print JSON output', false)
    .option('--user-id <id>', 'Local user id', 'local')
    .action(async (options: { userId: string; json?: boolean }, command) => {
      await runKnowledgeArgs(context, {
        command: 'list',
        projectDir: resolveCommandProjectDir(command),
        userId: options.userId,
        json: options.json,
      });
    });

  wiki
    .command('read')
    .description('Read one local wiki page')
    .argument('<key>', 'Wiki page key')
    .option('--json', 'Print JSON output', false)
    .option('--user-id <id>', 'Local user id', 'local')
    .action(async (key: string, options: { userId: string; json?: boolean }, command) => {
      await runKnowledgeArgs(context, {
        command: 'read',
        projectDir: resolveCommandProjectDir(command),
        key,
        userId: options.userId,
        json: options.json,
      });
    });

  wiki
    .command('search')
    .description('Search local wiki pages')
    .argument('<query>', 'Search query')
    .option('--json', 'Print JSON output', false)
    .option('--user-id <id>', 'Local user id', 'local')
    .option('--limit <number>', 'Maximum search results', parsePositiveIntegerOption)
    .action(async (query: string, options: { userId: string; json?: boolean; limit?: number }, command) => {
      await runKnowledgeArgs(context, {
        command: 'search',
        projectDir: resolveCommandProjectDir(command),
        query,
        userId: options.userId,
        json: options.json,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
    });

  wiki
    .command('write')
    .description('Write one local wiki page')
    .argument('<key>', 'Wiki page key')
    .option('--user-id <id>', 'Local user id', 'local')
    .addOption(new Option('--scope <scope>', 'global or user').choices(['global', 'user']).default('global'))
    .requiredOption('--summary <summary>', 'Wiki summary')
    .requiredOption('--content <content>', 'Wiki content')
    .option('--tag <tag>', 'Wiki tag; repeatable', collectOption, [])
    .option('--ref <ref>', 'Wiki ref; repeatable', collectOption, [])
    .option('--sl-ref <ref>', 'Semantic-layer ref; repeatable', collectOption, [])
    .action(async (key: string, options, command) => {
      const args = wikiWriteCommandSchema.parse({
        command: 'write',
        projectDir: resolveCommandProjectDir(command),
        key,
        scope: options.scope === 'user' ? 'USER' : 'GLOBAL',
        userId: options.userId,
        summary: options.summary,
        content: options.content,
        tags: options.tag,
        refs: options.ref,
        slRefs: options.slRef,
      });
      await runKnowledgeArgs(context, args);
    });
}
