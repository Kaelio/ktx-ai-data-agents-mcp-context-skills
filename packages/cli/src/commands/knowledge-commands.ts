import { type Command, Option } from '@commander-js/extra-typings';
import {
  type CommandWithGlobalOptions,
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

function isDebugEnabled(command: CommandWithGlobalOptions): boolean {
  const options = (command.optsWithGlobals ? command.optsWithGlobals() : command.opts()) as { debug?: unknown };
  return options.debug === true;
}

export function registerWikiCommands(program: Command, context: KtxCliCommandContext): void {
  program
    .command('wiki')
    .description('List or search local wiki pages')
    .usage('[options] [query...]')
    .argument('[query...]', 'Search query; omit to list all pages')
    .option('--user-id <id>', 'Local user id', 'local')
    .option('--limit <number>', 'Maximum search results (search mode only)', parsePositiveIntegerOption)
    .addOption(
      new Option('--output <mode>', 'Output mode: pretty (default in TTY), plain (TSV), or json').choices([
        'pretty',
        'plain',
        'json',
      ]),
    )
    .option('--json', 'Shortcut for --output=json (overrides --output)', false)
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    )
    .action(
      async (
        query: string[],
        options: {
          userId: string;
          limit?: number;
          output?: 'pretty' | 'plain' | 'json';
          json?: boolean;
        },
        command,
      ) => {
        if (query.length === 0) {
          await runKnowledgeArgs(context, {
            command: 'list',
            projectDir: resolveCommandProjectDir(command),
            userId: options.userId,
            output: options.output,
            json: options.json,
            cliVersion: context.packageInfo.version,
          });
          return;
        }
        await runKnowledgeArgs(context, {
          command: 'search',
          projectDir: resolveCommandProjectDir(command),
          query: query.join(' '),
          userId: options.userId,
          output: options.output,
          json: options.json,
          ...(isDebugEnabled(command) ? { debug: true } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          cliVersion: context.packageInfo.version,
        });
      },
    );
}
