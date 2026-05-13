import { type Command, Option } from '@commander-js/extra-typings';
import {
  type KtxCliCommandContext,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import type { KtxPublicIngestArgs } from '../public-ingest.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/ingest-commands');

export function registerIngestCommands(program: Command, context: KtxCliCommandContext): void {
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
}
