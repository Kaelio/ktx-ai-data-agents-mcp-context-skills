import { resolve } from 'node:path';
import type { Command } from '@commander-js/extra-typings';
import { type CommandWithGlobalOptions, type KtxCliCommandContext, resolveCommandProjectDir } from './cli-program.js';
import { registerRuntimeCommands } from './commands/runtime-commands.js';
import { profileMark } from './startup-profile.js';

profileMark('module:dev');

export function registerDevCommands(program: Command, context: KtxCliCommandContext): void {
  const dev = program
    .command('dev')
    .description('Low-level project initialization and runtime management')
    .showHelpAfterError();

  dev.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('dev', actionCommand);
  });

  dev.action(() => {
    dev.outputHelp();
    context.setExitCode(0);
  });

  dev
    .command('init')
    .description('Initialize a Git-backed KTX project directory for maintenance scripts')
    .argument('[directory]', 'Project directory')
    .option('--name <name>', 'Project name written to ktx.yaml')
    .option('--force', 'Rewrite ktx.yaml and scaffold files in an existing project', false)
    .action(
      async (
        projectDir: string | undefined,
        commandOptions: { name?: string; force?: boolean },
        command: CommandWithGlobalOptions,
      ) => {
        context.setExitCode(
          await context.runInit(
            {
              projectDir: projectDir ? resolve(projectDir) : resolveCommandProjectDir(command),
              ...(commandOptions.name ? { projectName: commandOptions.name } : {}),
              force: commandOptions.force === true,
            },
            context.io,
          ),
        );
      },
    );

  registerRuntimeCommands(dev, context);
}
