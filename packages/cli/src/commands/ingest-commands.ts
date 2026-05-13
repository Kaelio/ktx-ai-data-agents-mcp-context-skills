import { resolve } from 'node:path';
import { type Command, Option } from '@commander-js/extra-typings';
import {
  type KtxCliCommandContext,
  type OutputModeOptions,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import type { KtxCliDeps, KtxCliIo } from '../index.js';
import type { KtxIngestArgs, KtxIngestOutputMode } from '../ingest.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
import type { KtxPublicIngestArgs } from '../public-ingest.js';
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

function resolvedOptions<T extends object>(command: Command, fallback: T): T {
  return (command.optsWithGlobals ? command.optsWithGlobals() : fallback) as T;
}

function assertOutputModeCompatible(options: OutputModeOptions): void {
  const requested = [
    options.plain === true ? '--plain' : undefined,
    options.json === true ? '--json' : undefined,
    options.viz === true ? '--viz' : undefined,
  ].filter((option): option is string => option !== undefined);
  if (requested.length > 1) {
    throw new Error(`Output mode options cannot be used together: ${requested.join(', ')}`);
  }
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
    .description('Build or inspect KTX context')
    .usage('[options] [connectionId]')
    .argument('[connectionId]', 'Configured connection id to ingest')
    .option('--all', 'Ingest all configured connections', false)
    .addOption(new Option('--fast', 'Use deterministic database schema ingest').conflicts('deep'))
    .addOption(new Option('--deep', 'Use AI-enriched database ingest').conflicts('fast'))
    .addOption(new Option('--query-history', 'Include database query-history usage patterns').conflicts('noQueryHistory'))
    .addOption(new Option('--no-query-history', 'Skip database query-history usage patterns'))
    .option('--query-history-window-days <days>', 'Query-history lookback window for this run', parsePositiveIntegerOption)
    .addOption(new Option('--plain', 'Print plain text output').conflicts(['json']))
    .addOption(new Option('--json', 'Print JSON output').conflicts(['plain']))
    .option('--no-input', 'Disable interactive terminal input')
    .showHelpAfterError();

  ingest.action(async (connectionId: string | undefined, options, command) => {
    const { runKtxPublicIngest } = await import('../public-ingest.js');
    const queryHistory =
      options.queryHistory === true ? 'enabled' : options.queryHistory === false ? 'disabled' : 'default';
    const args: KtxPublicIngestArgs = {
      command: 'run',
      projectDir: resolveCommandProjectDir(command),
      ...(connectionId ? { targetConnectionId: connectionId } : {}),
      all: options.all === true,
      json: options.json === true,
      inputMode: options.input === false ? 'disabled' : 'auto',
      ...(options.fast === true ? { depth: 'fast' as const } : {}),
      ...(options.deep === true ? { depth: 'deep' as const } : {}),
      queryHistory,
      ...(options.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: options.queryHistoryWindowDays } : {}),
    };
    context.setExitCode(await (context.deps.publicIngest ?? runKtxPublicIngest)(args, context.io));
  });

  ingest.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('ingest', actionCommand);
  });

  ingest
    .command('run', { hidden: true })
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
      const commandOptionsWithGlobals = resolvedOptions(command, options);
      assertOutputModeCompatible(commandOptionsWithGlobals);
      if (options.reportFile) {
        throw new Error('--report-file is only supported for ingest status/watch');
      }
      await runIngestArgs(
        context,
        {
          command: 'run',
          projectDir: resolveCommandProjectDir(command),
          connectionId: commandOptionsWithGlobals.connectionId,
          adapter: commandOptionsWithGlobals.adapter,
          sourceDir: commandOptionsWithGlobals.sourceDir ? resolve(commandOptionsWithGlobals.sourceDir) : undefined,
          databaseIntrospectionUrl: commandOptionsWithGlobals.databaseIntrospectionUrl || undefined,
          cliVersion: context.packageInfo.version,
          runtimeInstallPolicy: runtimeInstallPolicyFromFlags({ yes: commandOptionsWithGlobals.yes }),
          ...(commandOptionsWithGlobals.debugLlmRequestFile
            ? { debugLlmRequestFile: resolve(commandOptionsWithGlobals.debugLlmRequestFile) }
            : {}),
          outputMode: outputMode(commandOptionsWithGlobals),
          ...inputMode(commandOptionsWithGlobals),
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
      const commandOptionsWithGlobals = resolvedOptions(command, options);
      assertOutputModeCompatible(commandOptionsWithGlobals);
      await runIngestArgs(
        context,
        {
          command: 'status',
          projectDir: resolveCommandProjectDir(command),
          ...(runId ? { runId } : {}),
          ...(commandOptionsWithGlobals.reportFile ? { reportFile: resolve(commandOptionsWithGlobals.reportFile) } : {}),
          outputMode: outputMode(commandOptionsWithGlobals),
          ...inputMode(commandOptionsWithGlobals),
        },
        commandOptions,
      );
    });

  ingest
    .command('watch', { hidden: true })
    .description('Open the latest or selected stored ingest visual report')
    .argument('[runId]', 'Local ingest run id, report id, run id, or job id')
    .option('--report-file <path>', 'Bundle ingest report JSON file to render')
    .addOption(new Option('--plain', 'Print plain text output').conflicts(['json', 'viz']))
    .addOption(new Option('--json', 'Print JSON output').conflicts(['plain', 'viz']))
    .addOption(new Option('--viz', 'Render memory-flow TUI output').conflicts(['plain', 'json']))
    .option('--no-input', 'Disable interactive terminal input for visualization')
    .action(async (runId: string | undefined, options, command) => {
      const commandOptionsWithGlobals = resolvedOptions(command, options);
      assertOutputModeCompatible(commandOptionsWithGlobals);
      await runIngestArgs(
        context,
        {
          command: 'watch',
          projectDir: resolveCommandProjectDir(command),
          ...(runId ? { runId } : {}),
          ...(commandOptionsWithGlobals.reportFile ? { reportFile: resolve(commandOptionsWithGlobals.reportFile) } : {}),
          outputMode: watchOutputMode(commandOptionsWithGlobals),
          ...inputMode(commandOptionsWithGlobals),
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
      const commandOptionsWithGlobals = resolvedOptions(command, options);
      assertOutputModeCompatible(commandOptionsWithGlobals);
      await runIngestArgs(
        context,
        {
          command: 'replay',
          projectDir: resolveCommandProjectDir(command),
          runId,
          ...(commandOptionsWithGlobals.reportFile ? { reportFile: resolve(commandOptionsWithGlobals.reportFile) } : {}),
          outputMode: outputMode(commandOptionsWithGlobals),
          ...inputMode(commandOptionsWithGlobals),
        },
        commandOptions,
      );
    });
}
