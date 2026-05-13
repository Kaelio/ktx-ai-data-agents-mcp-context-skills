import { type Command } from '@commander-js/extra-typings';
import {
  type KtxCliCommandContext,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
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
    .description('List or search local wiki pages')
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
}
