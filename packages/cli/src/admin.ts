import { resolve } from 'node:path';
import type { Command } from '@commander-js/extra-typings';
import { type CommandWithGlobalOptions, type KtxCliCommandContext, resolveCommandProjectDir } from './cli-program.js';
import { registerAdminReindexCommand } from './admin-reindex.js';
import { registerRuntimeCommands } from './commands/runtime-commands.js';
import { profileMark } from './startup-profile.js';

profileMark('module:admin');

export function registerAdminCommands(program: Command, context: KtxCliCommandContext): void {
  const admin = program
    .command('admin')
    .description('Low-level project initialization, runtime, and index management')
    .showHelpAfterError();

  admin.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('admin', actionCommand);
  });

  admin.action(() => {
    admin.outputHelp();
    context.setExitCode(0);
  });

  admin
    .command('init')
    .description('Initialize a Git-backed KTX project directory for maintenance scripts')
    .argument('[directory]', 'Project directory')
    .option('--force', 'Rewrite ktx.yaml and scaffold files in an existing project', false)
    .action(
      async (
        projectDir: string | undefined,
        commandOptions: { force?: boolean },
        command: CommandWithGlobalOptions,
      ) => {
        context.setExitCode(
          await context.runInit(
            {
              projectDir: projectDir ? resolve(projectDir) : resolveCommandProjectDir(command),
              force: commandOptions.force === true,
            },
            context.io,
          ),
        );
      },
    );

  admin
    .command('schema')
    .description('Print a JSON Schema describing ktx.yaml (for editors and LLM agents)')
    .option('--output <file>', 'Write the schema to a file instead of stdout')
    .action(async (options: { output?: string }) => {
      const { generateKtxProjectConfigJsonSchema } = await import('./context/project/index.js');
      const json = `${JSON.stringify(generateKtxProjectConfigJsonSchema(), null, 2)}\n`;
      if (options.output) {
        const { writeFile } = await import('node:fs/promises');
        const target = resolve(options.output);
        await writeFile(target, json, 'utf8');
        context.io.stdout.write(`Wrote ${target}\n`);
      } else {
        context.io.stdout.write(json);
      }
      context.setExitCode(0);
    });

  registerRuntimeCommands(admin, context);
  registerAdminReindexCommand(admin, context);
}
