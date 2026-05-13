import { resolve } from 'node:path';
import { type Command, Option } from '@commander-js/extra-typings';
import { collectOption, type KtxCliCommandContext, type OutputModeOptions, resolveCommandProjectDir } from '../cli-program.js';
import type { KtxCliDeps, KtxCliIo } from '../index.js';
import type { KtxIngestArgs, KtxIngestOutputMode } from '../ingest.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
import { profileMark } from '../startup-profile.js';
import type { KtxTextIngestArgs } from '../text-ingest.js';

profileMark('module:commands/ingest-commands');

interface IngestCommandOptions {
  runIngestWithProgress: (
    args: KtxIngestArgs,
    io: KtxCliIo,
    deps: KtxCliDeps,
    defaultRunIngest: (args: KtxIngestArgs, io: KtxCliIo) => Promise<number>,
  ) => Promise<number>;
  runTextIngest: (args: KtxTextIngestArgs, io: KtxCliIo, deps: KtxCliDeps) => Promise<number>;
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
          runtimeInstallPolicy: runtimeInstallPolicyFromFlags({ yes: options.yes }),
          ...(options.debugLlmRequestFile ? { debugLlmRequestFile: resolve(options.debugLlmRequestFile) } : {}),
          outputMode: outputMode(options),
          ...inputMode(options),
        },
        commandOptions,
      );
    });

  ingest
    .command('text')
    .description('Ingest free-form text artifacts into KTX memory')
    .argument('[files...]', 'Files to ingest; use - to read one item from stdin')
    .option('--text <content>', 'Text content to ingest; repeat for a batch', collectOption, [])
    .option('--connection-id <connectionId>', 'Optional KTX connection id for semantic-layer capture')
    .option('--user-id <id>', 'Memory user id for capture attribution', 'local-cli')
    .option('--json', 'Print JSON output')
    .option('--fail-fast', 'Stop after the first failed text item', false)
    .action(async (files: string[], options, command) => {
      context.setExitCode(
        await commandOptions.runTextIngest(
          {
            projectDir: resolveCommandProjectDir(command),
            texts: options.text,
            files,
            ...(options.connectionId ? { connectionId: options.connectionId } : {}),
            userId: options.userId,
            json: options.json === true,
            failFast: options.failFast === true,
          },
          context.io,
          context.deps,
        ),
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
