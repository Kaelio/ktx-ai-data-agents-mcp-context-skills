import { type Command, Option } from '@commander-js/extra-typings';
import type { KtxCliCommandContext } from '../cli-program.js';
import type { KtxRuntimeArgs } from '../runtime.js';

type RuntimeFeature = Extract<KtxRuntimeArgs, { command: 'install' }>['feature'];

function createRuntimeFeatureOption() {
  return new Option('--feature <feature>', 'Runtime feature level')
    .choices(['core', 'local-embeddings'])
    .default('core');
}

async function runRuntimeArgs(context: KtxCliCommandContext, args: KtxRuntimeArgs): Promise<void> {
  const runner = context.deps.runtime ?? (await import('../runtime.js')).runKtxRuntime;
  context.setExitCode(await runner(args, context.io));
}

export function registerRuntimeCommands(program: Command, context: KtxCliCommandContext): void {
  const runtime = program
    .command('runtime')
    .description('Install, start, stop, and inspect the KTX-managed Python runtime')
    .showHelpAfterError();

  runtime
    .command('install')
    .description('Install the bundled Python runtime wheel into the managed runtime')
    .addOption(createRuntimeFeatureOption())
    .option('--yes', 'Accept runtime installation without prompting', false)
    .option('--force', 'Reinstall even when the runtime already looks ready', false)
    .action(async (options: { feature: RuntimeFeature; yes?: boolean; force?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'install',
        cliVersion: context.packageInfo.version,
        feature: options.feature,
        force: options.force === true,
      });
    });

  runtime
    .command('start')
    .description('Start the KTX-managed Python HTTP daemon')
    .addOption(createRuntimeFeatureOption())
    .option('--force', 'Restart even when a matching daemon is already running', false)
    .action(async (options: { feature: RuntimeFeature; force?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'start',
        cliVersion: context.packageInfo.version,
        feature: options.feature,
        force: options.force === true,
      });
    });

  runtime
    .command('stop')
    .description('Stop the KTX-managed Python HTTP daemon')
    .option('--all', 'Stop all KTX daemon processes recorded or discoverable on this machine', false)
    .action(async (options: { all?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'stop',
        cliVersion: context.packageInfo.version,
        all: options.all === true,
      });
    });

  runtime
    .command('status')
    .description('Show managed Python runtime status and readiness checks')
    .option('--json', 'Print JSON output', false)
    .action(async (options: { json?: boolean }) => {
      await runRuntimeArgs(context, {
        command: 'status',
        cliVersion: context.packageInfo.version,
        json: options.json === true,
      });
    });
}
