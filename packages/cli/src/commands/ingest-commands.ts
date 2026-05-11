import { resolve } from 'node:path';
import { type Command, Option } from '@commander-js/extra-typings';
import { type KtxCliCommandContext, type OutputModeOptions, resolveCommandProjectDir } from '../cli-program.js';
import type { KtxCliDeps, KtxCliIo } from '../index.js';
import type { KtxIngestArgs, KtxIngestOutputMode } from '../ingest.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/ingest-commands');

interface IngestCommandOptions {
  runIngestWithProgress: (
    args: KtxIngestArgs,
    io: KtxCliIo,
    deps: KtxCliDeps,
    defaultRunIngest: (args: KtxIngestArgs, io: KtxCliIo) => Promise<number>,
  ) => Promise<number>;
}

function outputMode(options: OutputModeOptions): KtxIngestOutputMode {
  if (options.json === true) {
    return 'json';
  }
  if (options.viz === true) {
    return 'viz';
  }
  return 'plain';
}

function watchOutputMode(options: OutputModeOptions): KtxIngestOutputMode {
  if (options.json === true) {
    return 'json';
  }
  if (options.plain === true) {
    return 'plain';
  }
  return 'viz';
}

function inputMode(options: OutputModeOptions): Pick<KtxIngestArgs, 'inputMode'> {
  return options.input === false ? { inputMode: 'disabled' } : {};
}

async function runIngestArgs(
  context: KtxCliCommandContext,
  args: KtxIngestArgs,
  options: IngestCommandOptions,
): Promise<void> {
  const { runKtxIngest } = await import('../ingest.js');
  context.setExitCode(await options.runIngestWithProgress(args, context.io, context.deps, runKtxIngest));
}

export function registerIngestCommands(
  program: Command,
  context: KtxCliCommandContext,
  commandOptions: IngestCommandOptions,
): void {
  const ingest = program
    .command('ingest')
    .description('Run or inspect local ingest memory-flow output')
    .showHelpAfterError();

  ingest.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('ingest', actionCommand);
  });

  ingest
    .command('run')
    .description('Run local ingest for one configured connection and source adapter')
    .requiredOption('--connection-id <connectionId>', 'KTX connection id')
    .requiredOption('--adapter <adapter>', 'Ingest source adapter name')
    .option('--source-dir <path>', 'Directory containing source files')
    .option('--database-introspection-url <url>', 'Daemon URL for live-database introspection')
    .option('--debug-llm-request-file <path>', 'Write sanitized LLM request structure to a JSONL file')
    .option('--report-file <path>', 'Unsupported for ingest run; use ingest status/watch instead')
    .addOption(new Option('--plain', 'Print plain text output').conflicts(['json', 'viz']))
    .addOption(new Option('--json', 'Print JSON output').conflicts(['plain', 'viz']))
    .addOption(new Option('--viz', 'Render memory-flow TUI output').conflicts(['plain', 'json']))
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive terminal input for visualization')
    .action(async (options, command) => {
      if (options.reportFile) {
        throw new Error('--report-file is only supported for ingest status/watch');
      }
      await runIngestArgs(
        context,
        {
          command: 'run',
          projectDir: resolveCommandProjectDir(command),
          connectionId: options.connectionId,
          adapter: options.adapter,
          sourceDir: options.sourceDir ? resolve(options.sourceDir) : undefined,
          databaseIntrospectionUrl: options.databaseIntrospectionUrl || undefined,
          cliVersion: context.packageInfo.version,
          runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
          ...(options.debugLlmRequestFile ? { debugLlmRequestFile: resolve(options.debugLlmRequestFile) } : {}),
          outputMode: outputMode(options),
          ...inputMode(options),
        },
        commandOptions,
      );
    });

  ingest
    .command('status')
    .description('Print status for the latest or selected stored local ingest run or report file')
    .argument('[runId]', 'Local ingest run id, report id, run id, or job id')
    .option('--report-file <path>', 'Bundle ingest report JSON file to render')
    .addOption(new Option('--plain', 'Print plain text output').conflicts(['json', 'viz']))
    .addOption(new Option('--json', 'Print JSON output').conflicts(['plain', 'viz']))
    .addOption(new Option('--viz', 'Render memory-flow TUI output').conflicts(['plain', 'json']))
    .option('--no-input', 'Disable interactive terminal input for visualization')
    .action(async (runId: string | undefined, options, command) => {
      await runIngestArgs(
        context,
        {
          command: 'status',
          projectDir: resolveCommandProjectDir(command),
          ...(runId ? { runId } : {}),
          ...(options.reportFile ? { reportFile: resolve(options.reportFile) } : {}),
          outputMode: outputMode(options),
          ...inputMode(options),
        },
        commandOptions,
      );
    });

  ingest
    .command('watch')
    .description('Open the latest or selected stored ingest visual report')
    .argument('[runId]', 'Local ingest run id, report id, run id, or job id')
    .option('--report-file <path>', 'Bundle ingest report JSON file to render')
    .addOption(new Option('--plain', 'Print plain text output').conflicts(['json', 'viz']))
    .addOption(new Option('--json', 'Print JSON output').conflicts(['plain', 'viz']))
    .addOption(new Option('--viz', 'Render memory-flow TUI output').conflicts(['plain', 'json']))
    .option('--no-input', 'Disable interactive terminal input for visualization')
    .action(async (runId: string | undefined, options, command) => {
      await runIngestArgs(
        context,
        {
          command: 'watch',
          projectDir: resolveCommandProjectDir(command),
          ...(runId ? { runId } : {}),
          ...(options.reportFile ? { reportFile: resolve(options.reportFile) } : {}),
          outputMode: watchOutputMode(options),
          ...inputMode(options),
        },
        commandOptions,
      );
    });

  ingest
    .command('replay')
    .description('Replay a stored ingest run or bundle report through memory-flow output')
    .argument('<runId>', 'Local ingest run id, report id, run id, or job id')
    .option('--report-file <path>', 'Bundle ingest report JSON file to render')
    .addOption(new Option('--plain', 'Print plain text output').conflicts(['json', 'viz']))
    .addOption(new Option('--json', 'Print JSON output').conflicts(['plain', 'viz']))
    .addOption(new Option('--viz', 'Render memory-flow TUI output').conflicts(['plain', 'json']))
    .option('--no-input', 'Disable interactive terminal input for visualization')
    .action(async (runId: string, options, command) => {
      await runIngestArgs(
        context,
        {
          command: 'replay',
          projectDir: resolveCommandProjectDir(command),
          runId,
          ...(options.reportFile ? { reportFile: resolve(options.reportFile) } : {}),
          outputMode: outputMode(options),
          ...inputMode(options),
        },
        commandOptions,
      );
    });
}
