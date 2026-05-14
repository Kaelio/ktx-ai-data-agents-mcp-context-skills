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

  dev
    .command('schema')
    .description('Print a JSON Schema describing ktx.yaml (for editors and LLM agents)')
    .option('--output <file>', 'Write the schema to a file instead of stdout')
    .action(async (options: { output?: string }) => {
      const { generateKtxProjectConfigJsonSchema } = await import('@ktx/context/project');
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

  registerRuntimeCommands(dev, context);
}
