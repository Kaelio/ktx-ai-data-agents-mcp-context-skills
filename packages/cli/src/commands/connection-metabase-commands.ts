import { type Command, Option } from '@commander-js/extra-typings';

import {
  type KtxCliCommandContext,
  parseNonEmptyAssignmentOption,
  parsePositiveIntegerOption,
  parseSafeConnectionIdOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import {
  type KtxConnectionMetabaseSetupArgs,
  type MetabaseSetupMappingAssignment,
  type MetabaseSetupSyncMode,
  runKtxConnectionMetabaseSetup,
} from './connection-metabase-setup.js';

const SYNC_MODE_CHOICES = ['ALL', 'ONLY', 'EXCEPT'] as const satisfies readonly MetabaseSetupSyncMode[];

interface ConnectionMetabaseSetupOptions {
  id?: string;
  url?: string;
  apiKey?: string;
  mintApiKey?: boolean;
  username?: string;
  password?: string;
  map: MetabaseSetupMappingAssignment[];
  sync: number[];
  syncMode: MetabaseSetupSyncMode;
  runIngest?: boolean;
  yes?: boolean;
  input?: boolean;
}

function collectPositiveIntegerOption(value: string, previous: number[] = []): number[] {
  return [...previous, parsePositiveIntegerOption(value)];
}

function parseMappingAssignment(value: string): MetabaseSetupMappingAssignment {
  const assignment = parseNonEmptyAssignmentOption(value);
  return {
    metabaseDatabaseId: parsePositiveIntegerOption(assignment.key),
    targetConnectionId: parseSafeConnectionIdOption(assignment.value),
  };
}

function collectMappingOption(
  value: string,
  previous: MetabaseSetupMappingAssignment[] = [],
): MetabaseSetupMappingAssignment[] {
  return [...previous, parseMappingAssignment(value)];
}

async function runMetabaseSetupArgs(
  context: KtxCliCommandContext,
  args: KtxConnectionMetabaseSetupArgs,
): Promise<void> {
  const runner = context.deps.connectionMetabaseSetup ?? runKtxConnectionMetabaseSetup;
  context.setExitCode(await runner(args, context.io));
}

export function registerConnectionMetabaseCommands(connection: Command, context: KtxCliCommandContext): void {
  const metabase = connection
    .command('metabase')
    .description('Configure Metabase connections')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    );

  metabase.action(() => {
    metabase.outputHelp();
    context.setExitCode(0);
  });

  metabase
    .command('setup')
    .description('Guided setup for a Metabase connection')
    .option('--id <connectionId>', 'KTX connection id to write', parseSafeConnectionIdOption)
    .option('--url <url>', 'Metabase API URL')
    .addOption(new Option('--api-key <key>', 'Metabase API key').conflicts('mintApiKey'))
    .option('--mint-api-key', 'Mint a Metabase API key with credentials', false)
    .option('--username <email>', 'Metabase admin username for API-key minting')
    .option('--password <password>', 'Metabase admin password for API-key minting')
    .addHelpText(
      'after',
      '\nGuided equivalent of:\n' +
        '  ktx connection mapping refresh <connectionId> --auto-accept\n' +
        '  ktx connection mapping set <connectionId> databaseMappings <id>=<target>\n' +
        '  ktx connection mapping set-sync-enabled <connectionId> <id> --enabled true\n' +
        '  ktx ingest run --connection-id <connectionId> --adapter metabase\n',
    )
    .option(
      '--map <metabaseDatabaseId=targetConnectionId>',
      'Assign a Metabase database id to a warehouse connection; repeatable',
      collectMappingOption,
      [],
    )
    .option(
      '--sync <metabaseDatabaseId>',
      'Enable Metabase sync for a discovered database; repeatable',
      collectPositiveIntegerOption,
      [],
    )
    .addOption(
      new Option('--sync-mode <mode>', 'Metabase sync selection mode')
        .choices(SYNC_MODE_CHOICES)
        .default('ALL' satisfies MetabaseSetupSyncMode),
    )
    .option('--run-ingest', 'Run ingest after setup', false)
    .option('--yes', 'Confirm and apply setup changes without prompting', false)
    .option('--no-input', 'Disable interactive terminal input')
    .showHelpAfterError()
    .action(async (options: ConnectionMetabaseSetupOptions, command) => {
      await runMetabaseSetupArgs(context, {
        command: 'setup',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.id,
        url: options.url,
        apiKey: options.apiKey,
        mintApiKey: options.mintApiKey === true,
        metabaseUsername: options.username,
        metabasePassword: options.password,
        mappings: options.map,
        syncEnabledDatabaseIds: options.sync,
        syncMode: options.syncMode ?? 'ALL',
        runIngest: options.runIngest === true,
        yes: options.yes === true,
        inputMode: options.input === false ? 'disabled' : 'auto',
      });
    });
}
