import { type Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import {
  collectOption,
  type KtxCliCommandContext,
  parseBooleanStringOption,
  parseNonEmptyAssignmentOption,
  parseNonNegativeIntegerOption,
  parsePositiveIntegerOption,
  parseSafeConnectionIdOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import { connectionAddCommandSchema } from '../command-schemas.js';
import type { KtxConnectionArgs } from '../connection.js';
import { profileMark } from '../startup-profile.js';
import type { KtxConnectionMappingArgs } from './connection-mapping.js';
import { registerConnectionMetabaseCommands } from './connection-metabase-commands.js';
import { registerConnectionNotionCommands } from './connection-notion-commands.js';

profileMark('module:commands/connection-commands');

const CRAWL_MODE_CHOICES = ['all_accessible', 'selected_roots'] as const;
const SYNC_MODE_CHOICES = ['ALL', 'ONLY', 'EXCEPT'] as const;

function parseCsvIds(value: string): number[] {
  return value
    .split(',')
    .filter(Boolean)
    .map((item) => parsePositiveIntegerOption(item));
}

function parseCsvStrings(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMappingFieldOption(value: string): 'databaseMappings' | 'connectionMappings' {
  if (value === 'databaseMappings' || value === 'connectionMappings') {
    return value;
  }
  throw new InvalidArgumentError('must be databaseMappings or connectionMappings');
}

async function runConnectionArgs(context: KtxCliCommandContext, args: KtxConnectionArgs): Promise<void> {
  const runner = context.deps.connection ?? (await import('../connection.js')).runKtxConnection;
  context.setExitCode(await runner(args, context.io));
}

async function runMappingArgs(context: KtxCliCommandContext, args: KtxConnectionMappingArgs): Promise<void> {
  const { runKtxConnectionMapping } = await import('./connection-mapping.js');
  context.setExitCode(await runKtxConnectionMapping(args, context.io));
}

export function registerConnectionCommands(program: Command, context: KtxCliCommandContext, commandName = 'connection'): void {
  const connection = program
    .command(commandName)
    .description('Add, list, test, and map data sources')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the nearest ktx.yaml or current working directory.\n',
    );
  connection.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.(commandName, actionCommand);
  });

  connection
    .command('list')
    .description('List configured connections')
    .action(async (_options: unknown, command) => {
      await runConnectionArgs(context, { command: 'list', projectDir: resolveCommandProjectDir(command) });
    });

  connection
    .command('test')
    .description('Test a configured connection')
    .argument('<connectionId>', 'KTX connection id')
    .action(async (connectionId: string, _options: unknown, command) => {
      await runConnectionArgs(context, {
        command: 'test',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
      });
    });

  connection
    .command('add')
    .description('Add or replace a configured connection')
    .argument('<driver>', 'Connection driver')
    .argument('<connectionId>', 'KTX connection id')
    .option('--url <url>', 'Connection URL, env:NAME, or file:/path reference')
    .option('--schema <schema>', 'Schema to include; repeatable', collectOption, [])
    .option('--readonly', 'Mark the connection as read-only', false)
    .option('--force', 'Replace an existing connection', false)
    .option('--allow-literal-credentials', 'Allow writing a literal credential URL to ktx.yaml', false)
    .addOption(new Option('--token-env <name>', 'Environment variable containing Notion auth token').conflicts('tokenFile'))
    .addOption(new Option('--token-file <path>', 'File containing Notion auth token').conflicts('tokenEnv'))
    .addOption(
      new Option('--crawl-mode <mode>', 'Notion crawl mode: all_accessible or selected_roots')
        .choices(CRAWL_MODE_CHOICES)
        .default('selected_roots'),
    )
    .option('--root-page-id <id>', 'Root page to crawl; repeatable', collectOption, [])
    .option('--root-database-id <id>', 'Root database to crawl; repeatable', collectOption, [])
    .option('--root-data-source-id <id>', 'Root data source to crawl; repeatable', collectOption, [])
    .option('--max-pages <n>', 'Maximum pages per run', parsePositiveIntegerOption)
    .option('--max-knowledge-creates <n>', 'Maximum knowledge creates per run', parseNonNegativeIntegerOption)
    .option('--max-knowledge-updates <n>', 'Maximum knowledge updates per run', parseNonNegativeIntegerOption)
    .action(async (driver: string, connectionId: string, options, command) => {
      const notion =
        driver === 'notion'
          ? {
              authTokenRef: options.tokenEnv
                ? `env:${options.tokenEnv}`
                : options.tokenFile
                  ? `file:${options.tokenFile}`
                  : '',
              crawlMode: options.crawlMode,
              rootPageIds: options.rootPageId,
              rootDatabaseIds: options.rootDatabaseId,
              rootDataSourceIds: options.rootDataSourceId,
              maxPagesPerRun: options.maxPages,
              maxKnowledgeCreatesPerRun: options.maxKnowledgeCreates,
              maxKnowledgeUpdatesPerRun: options.maxKnowledgeUpdates,
            }
          : undefined;

      if (driver === 'notion' && !notion?.authTokenRef) {
        throw new Error('connection add notion requires --token-env NAME or --token-file PATH');
      }
      if (
        driver === 'notion' &&
        notion?.crawlMode === 'selected_roots' &&
        notion.rootPageIds.length + notion.rootDatabaseIds.length + notion.rootDataSourceIds.length === 0
      ) {
        throw new Error('connection add notion selected_roots requires at least one root id');
      }

      const args = connectionAddCommandSchema.parse({
        command: 'add',
        projectDir: resolveCommandProjectDir(command),
        driver,
        connectionId,
        url: options.url,
        schemas: options.schema.filter(Boolean),
        readonly: options.readonly === true,
        force: options.force === true,
        allowLiteralCredentials: options.allowLiteralCredentials === true,
        notion,
      });

      await runConnectionArgs(context, args);
    });

  connection
    .command('remove')
    .description('Remove a configured connection from ktx.yaml')
    .argument('<connectionId>', 'KTX connection id')
    .option('--force', 'Remove without prompting', false)
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (connectionId: string, options: { force?: boolean; input?: boolean }, command) => {
      await runConnectionArgs(context, {
        command: 'remove',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        force: options.force === true,
        ...(options.input === false ? { inputMode: 'disabled' } : {}),
      });
    });

  connection
    .command('map')
    .description('Refresh and validate BI-to-warehouse mappings')
    .argument('<sourceConnectionId>', 'Source BI connection id')
    .option('--json', 'Print JSON output', false)
    .action(async (sourceConnectionId: string, options: { json?: boolean }, command) => {
      await runConnectionArgs(context, {
        command: 'map',
        projectDir: resolveCommandProjectDir(command),
        sourceConnectionId,
        json: options.json === true,
      });
    });

  registerConnectionMappingCommands(connection, context);
  registerConnectionMetabaseCommands(connection, context);
  registerConnectionNotionCommands(connection, context);
}

function registerConnectionMappingCommands(connection: Command, context: KtxCliCommandContext): void {
  const mapping = connection
    .command('mapping')
    .description('Manage Metabase warehouse mappings')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    );

  mapping
    .command('list')
    .description('List Metabase database mappings')
    .argument('<connectionId>', 'Metabase connection id')
    .option('--json', 'Print JSON output where supported', false)
    .action(async (connectionId: string, options: { json?: boolean }, command) => {
      await runMappingArgs(context, {
        command: 'list',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        json: options.json === true,
      });
    });

  mapping
    .command('set')
    .description('Set a Metabase or Looker warehouse mapping')
    .argument('<connectionId>', 'Source connection id', parseSafeConnectionIdOption)
    .argument('<field>', 'Mapping field', parseMappingFieldOption)
    .argument('<assignment>', 'Mapping assignment such as 1=prod-warehouse', parseNonEmptyAssignmentOption)
    .action(
      async (
        connectionId: string,
        field: 'databaseMappings' | 'connectionMappings',
        assignment: { key: string; value: string },
        _options: unknown,
        command,
      ) => {
        await runMappingArgs(context, {
          command: 'set',
          projectDir: resolveCommandProjectDir(command),
          connectionId,
          field,
          key: assignment.key,
          value: assignment.value,
        });
      },
    );

  mapping
    .command('apply-bulk')
    .description('Apply mappings from JSON')
    .argument('<connectionId>', 'Metabase connection id')
    .requiredOption('--file <path>', 'JSON mapping file')
    .action(async (connectionId: string, options: { file: string }, command) => {
      await runMappingArgs(context, {
        command: 'apply-bulk',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        filePath: options.file,
      });
    });

  mapping
    .command('set-sync-enabled')
    .description('Enable or disable sync for one Metabase database')
    .argument('<connectionId>', 'Metabase connection id')
    .argument('<metabaseDatabaseId>', 'Metabase database id', parsePositiveIntegerOption)
    .requiredOption('--enabled <value>', 'true or false', parseBooleanStringOption)
    .action(
      async (connectionId: string, metabaseDatabaseId: number, options: { enabled: boolean }, command) => {
        await runMappingArgs(context, {
          command: 'set-sync-enabled',
          projectDir: resolveCommandProjectDir(command),
          connectionId,
          metabaseDatabaseId,
          enabled: options.enabled,
        });
      },
    );

  const syncState = mapping.command('sync-state').description('Manage Metabase sync-state selection');
  syncState
    .command('get')
    .description('Read sync-state selection')
    .argument('<connectionId>', 'Metabase connection id')
    .option('--json', 'Print JSON output where supported', false)
    .action(async (connectionId: string, options: { json?: boolean }, command) => {
      await runMappingArgs(context, {
        command: 'sync-state-get',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        json: options.json === true,
      });
    });

  syncState
    .command('set')
    .description('Write sync-state selection')
    .argument('<connectionId>', 'Metabase connection id')
    .addOption(new Option('--mode <mode>', 'ALL, ONLY, or EXCEPT').choices(SYNC_MODE_CHOICES).makeOptionMandatory())
    .option('--collections <ids>', 'Comma-separated collection ids', parseCsvIds, [])
    .option('--items <ids>', 'Comma-separated item ids', parseCsvIds, [])
    .option('--tag-names <names>', 'Comma-separated tag names', parseCsvStrings, [])
    .action(async (connectionId: string, options, command) => {
      await runMappingArgs(context, {
        command: 'sync-state-set',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        syncMode: options.mode,
        collectionIds: options.collections,
        itemIds: options.items,
        tagNames: options.tagNames,
      });
    });

  mapping
    .command('refresh')
    .description('Refresh Metabase database mappings')
    .argument('<connectionId>', 'Metabase connection id')
    .option('--auto-accept', 'Accept refresh changes without prompting', false)
    .action(async (connectionId: string, options: { autoAccept?: boolean }, command) => {
      await runMappingArgs(context, {
        command: 'refresh',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        autoAccept: options.autoAccept === true,
      });
    });

  mapping
    .command('validate')
    .description('Validate Metabase database mappings')
    .argument('<connectionId>', 'Metabase connection id')
    .action(async (connectionId: string, _options: unknown, command) => {
      await runMappingArgs(context, {
        command: 'validate',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
      });
    });

  mapping
    .command('clear')
    .description('Clear Metabase database mappings')
    .argument('<connectionId>', 'Metabase connection id')
    .argument('[metabaseDatabaseId]', 'Metabase database id', parsePositiveIntegerOption)
    .action(async (connectionId: string, metabaseDatabaseId: number | undefined, _options: unknown, command) => {
      await runMappingArgs(context, {
        command: 'clear',
        projectDir: resolveCommandProjectDir(command),
        connectionId,
        ...(metabaseDatabaseId ? { metabaseDatabaseId } : {}),
      });
    });
}
