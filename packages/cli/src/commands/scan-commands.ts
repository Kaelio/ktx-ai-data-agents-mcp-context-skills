import { type Command, InvalidArgumentError } from '@commander-js/extra-typings';
import { type KtxCliCommandContext, resolveCommandProjectDir } from '../cli-program.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
import type { KtxScanArgs } from '../scan.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/scan-commands');

async function runScanArgs(context: KtxCliCommandContext, args: KtxScanArgs): Promise<void> {
  const runner = context.deps.scan ?? (await import('../scan.js')).runKtxScan;
  context.setExitCode(await runner(args, context.io));
}

type KtxScanModeOption = Extract<KtxScanArgs, { command: 'run' }>['mode'];

const REMOVED_SCAN_SUBCOMMAND_NAMES = new Set([
  'status',
  'report',
  'relationships',
  'relationship-apply',
  'relationship-feedback',
  'relationship-calibration',
  'relationship-thresholds',
]);

function parseScanModeOption(value: string): KtxScanModeOption {
  if (value === 'structural' || value === 'enriched' || value === 'relationships') {
    return value;
  }
  throw new InvalidArgumentError('Allowed choices are structural, enriched, relationships');
}

function parseConnectionId(value: string): string {
  if (REMOVED_SCAN_SUBCOMMAND_NAMES.has(value)) {
    throw new InvalidArgumentError(`"${value}" is not a scan connection id`);
  }
  return value;
}

export function registerScanCommands(program: Command, context: KtxCliCommandContext): void {
  program
    .command('scan', { hidden: true })
    .description('Run a standalone connection scan')
    .argument('<connectionId>', 'KTX connection id to scan', parseConnectionId)
    .option(
      '--mode <mode>',
      'Scan mode: structural, enriched, relationships (default: structural)',
      parseScanModeOption,
    )
    .option('--dry-run', 'Run without writing scan results', false)
    .option('--database-introspection-url <url>', 'Daemon URL for live-database introspection')
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    )
    .hook('preAction', (_thisCommand, actionCommand) => {
      context.writeDebug?.('scan', actionCommand);
    })
    .action(async (connectionId: string, options, command) => {
      const mode = options.mode ?? 'structural';
      await runScanArgs(context, {
        command: 'run',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        mode,
        detectRelationships: mode === 'relationships',
        dryRun: options.dryRun === true,
        databaseIntrospectionUrl: options.databaseIntrospectionUrl,
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
      });
    });
}
