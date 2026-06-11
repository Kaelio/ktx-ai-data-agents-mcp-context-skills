import type { Command } from '@commander-js/extra-typings';
import type { KtxCliCommandContext } from '../cli-program.js';
import { resolveCommandProjectDir, resolveCommandProjectDirOverride } from '../cli-program.js';
import { findNearestKtxProjectDir } from '../project-resolver.js';
import { emitProjectStackSnapshot } from '../telemetry/index.js';

function outputMode(options: { json?: boolean }): 'plain' | 'json' {
  return options.json === true ? 'json' : 'plain';
}

function inputMode(options: { input?: boolean }): { inputMode?: 'disabled' } {
  return options.input === false ? { inputMode: 'disabled' } : {};
}

export function registerStatusCommands(program: Command, context: KtxCliCommandContext): void {
  program
    .command('status')
    .description('Check current ktx setup and project readiness')
    .option('--json', 'Print JSON output', false)
    .option('-v, --verbose', 'Show every check, including passing ones', false)
    .option('--validate', 'Only validate the ktx.yaml schema; skip readiness checks', false)
    .option('--fast', 'Skip checks that require external communication (DB probes, auth probes)', false)
    .option('--no-input', 'Disable interactive terminal input')
    .action(
      async (
        options: { json?: boolean; verbose?: boolean; validate?: boolean; fast?: boolean; input?: boolean },
        command,
      ) => {
        const runner = context.deps.doctor ?? (await import('../doctor.js')).runKtxDoctor;
        const explicitOrEnvProjectDir = resolveCommandProjectDirOverride(command);
        const nearestProjectDir = explicitOrEnvProjectDir ? undefined : findNearestKtxProjectDir(process.cwd());

        if (options.validate === true) {
          context.setExitCode(
            await runner(
              {
                command: 'validate',
                projectDir: resolveCommandProjectDir(command),
                outputMode: outputMode(options),
                ...inputMode(options),
              },
              context.io,
            ),
          );
          return;
        }

        if (!explicitOrEnvProjectDir && !nearestProjectDir) {
          context.setExitCode(
            await runner(
              {
                command: 'setup',
                outputMode: outputMode(options),
                verbose: options.verbose === true,
                ...inputMode(options),
              },
              context.io,
            ),
          );
          return;
        }
        const projectDir = resolveCommandProjectDir(command);
        context.setExitCode(
          await runner(
            {
              command: 'project',
              projectDir,
              outputMode: outputMode(options),
              verbose: options.verbose === true,
              fast: options.fast === true,
              ...inputMode(options),
            },
            context.io,
          ),
        );
        await emitProjectStackSnapshot({
          projectDir,
          io: context.io,
          packageInfo: context.packageInfo,
        });
      },
    );
}
