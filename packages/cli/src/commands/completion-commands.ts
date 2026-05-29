import { Argument, type Command } from '@commander-js/extra-typings';
import type { KtxCliCommandContext } from '../cli-program.js';
import { computeCompletions } from '../completion/complete-engine.js';
import { completionScript } from '../completion/completion-scripts.js';
import { createProjectCompletionProviders } from '../completion/dynamic-candidates.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/completion-commands');

export function registerCompletionCommands(program: Command, context: KtxCliCommandContext): void {
  program
    .command('completion')
    .description('Print a shell completion script for ktx')
    .addArgument(new Argument('<shell>', 'Target shell').choices(['zsh', 'bash']))
    .addHelpText(
      'after',
      '\nEnable completion by adding the matching line to your shell startup file:\n' +
        '  zsh:  eval "$(ktx completion zsh)"\n' +
        '  bash: eval "$(ktx completion bash)"\n',
    )
    .action((shell) => {
      context.io.stdout.write(completionScript(shell));
    });

  // Hidden command invoked by the generated shell scripts. It must only ever
  // print newline-separated candidates to stdout and exit 0, so a TAB press is
  // never disrupted by an error, a telemetry notice, or a parse failure.
  program
    .command('__complete', { hidden: true })
    .argument('[words...]')
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (words: string[]) => {
      try {
        const candidates = await computeCompletions(program, words, createProjectCompletionProviders());
        if (candidates.length > 0) {
          context.io.stdout.write(`${candidates.join('\n')}\n`);
        }
      } catch {
        // Swallow: completion must never break the shell.
      }
      context.setExitCode(0);
    });
}
