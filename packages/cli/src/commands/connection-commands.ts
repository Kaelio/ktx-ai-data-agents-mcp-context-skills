import { type Command } from '@commander-js/extra-typings';
import { type KtxCliCommandContext, resolveCommandProjectDir } from '../cli-program.js';
import type { KtxConnectionArgs } from '../connection.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/connection-commands');

async function runConnectionArgs(context: KtxCliCommandContext, args: KtxConnectionArgs): Promise<void> {
  const runner = context.deps.connection ?? (await import('../connection.js')).runKtxConnection;
  context.setExitCode(await runner(args, context.io));
}

export function registerConnectionCommands(program: Command, context: KtxCliCommandContext, commandName = 'connection'): void {
  const connection = program
    .command(commandName)
    .description('List and test configured connections')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the nearest ktx.yaml or current working directory.\n',
    );
  connection.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.(commandName, actionCommand);
  });

  connection
    .command('list')
    .description('List configured connections')
    .action(async (_options: unknown, command) => {
      await runConnectionArgs(context, { command: 'list', projectDir: resolveCommandProjectDir(command) });
    });

  connection
    .command('test')
    .description('Test a configured connection')
    .argument('[connectionId]', 'KTX connection id (omit when --all is set)')
    .option('--all', 'Test every configured connection and print a summary list')
    .action(async (connectionId: string | undefined, options: { all?: boolean }, command) => {
      const all = options.all === true;
      if (all && connectionId !== undefined) {
        command.error('error: --all cannot be combined with a connection id argument');
      }
      if (!all && connectionId === undefined) {
        command.error('error: missing required argument <connectionId> (or pass --all)');
      }
      if (all) {
        await runConnectionArgs(context, { command: 'test-all', projectDir: resolveCommandProjectDir(command) });
        return;
      }
      await runConnectionArgs(context, {
        command: 'test',
        projectDir: resolveCommandProjectDir(command),
        connectionId: connectionId as string,
      });
    });
}
