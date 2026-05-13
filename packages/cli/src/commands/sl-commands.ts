import { type Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import {
  collectOption,
  type KtxCliCommandContext,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import { slQueryCommandSchema } from '../command-schemas.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
import type { KtxSlArgs } from '../sl.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/sl-commands');

function parseOrderBy(value: string): string | { field: string; direction?: string } {
  const [field, direction] = value.split(':');
  if (!field) {
    throw new InvalidArgumentError('requires a field');
  }
  if (!direction) {
    return field;
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw new InvalidArgumentError('direction must be asc or desc');
  }
  return { field, direction };
}

function collectOrderBy(
  value: string,
  previous: Array<string | { field: string; direction?: string }> = [],
): Array<string | { field: string; direction?: string }> {
  return [...previous, parseOrderBy(value)];
}

async function runSlArgs(context: KtxCliCommandContext, args: KtxSlArgs): Promise<void> {
  const runner = context.deps.sl ?? (await import('../sl.js')).runKtxSl;
  context.setExitCode(await runner(args, context.io));
}

export function registerSlCommands(program: Command, context: KtxCliCommandContext, commandName = 'sl'): void {
  const sl = program
    .command(commandName)
    .description('List, search, validate, or query local semantic-layer sources')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    );

  sl.command('list')
    .description('List semantic-layer sources')
    .option('--connection-id <id>', 'KTX connection id')
    .addOption(
      new Option('--output <mode>', 'Output mode: pretty (default in TTY), plain (TSV), or json').choices([
        'pretty',
        'plain',
        'json',
      ]),
    )
    .option('--json', 'Shortcut for --output=json (overrides --output)', false)
    .action(
      async (options: { connectionId?: string; output?: 'pretty' | 'plain' | 'json'; json?: boolean }, command) => {
        await runSlArgs(context, {
          command: 'list',
          projectDir: resolveCommandProjectDir(command),
          connectionId: options.connectionId,
          output: options.output,
          json: options.json,
        });
      },
    );

  sl.command('search')
    .description('Search semantic-layer sources')
    .argument('<query>', 'Search query')
    .option('--connection-id <id>', 'KTX connection id')
    .option('--limit <number>', 'Maximum search results', parsePositiveIntegerOption)
    .addOption(
      new Option('--output <mode>', 'Output mode: pretty (default in TTY), plain (TSV), or json').choices([
        'pretty',
        'plain',
        'json',
      ]),
    )
    .option('--json', 'Shortcut for --output=json (overrides --output)', false)
    .action(
      async (
        query: string,
        options: { connectionId?: string; limit?: number; output?: 'pretty' | 'plain' | 'json'; json?: boolean },
        command,
      ) => {
        await runSlArgs(context, {
          command: 'search',
          projectDir: resolveCommandProjectDir(command),
          connectionId: options.connectionId,
          query,
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          output: options.output,
          json: options.json,
        });
      },
    );

  sl.command('validate')
    .description('Validate a semantic-layer source')
    .argument('<sourceName>', 'Semantic-layer source name')
    .requiredOption('--connection-id <id>', 'KTX connection id')
    .action(async (sourceName: string, options: { connectionId: string }, command) => {
      await runSlArgs(context, {
        command: 'validate',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connectionId,
        sourceName,
      });
    });

  sl.command('query')
    .description('Compile or execute a semantic-layer query')
    .option('--connection-id <id>', 'KTX connection id')
    .option('--query-file <path>', 'JSON semantic-layer query file')
    .option('--measure <measure>', 'Measure to query; repeatable', collectOption, [])
    .option('--dimension <dimension>', 'Dimension to include; repeatable', collectOption, [])
    .option('--filter <filter>', 'Filter expression; repeatable', collectOption, [])
    .option('--segment <segment>', 'Segment to include; repeatable', collectOption, [])
    .option('--order-by <field[:direction]>', 'Order field, optionally suffixed with :asc or :desc', collectOrderBy, [])
    .option('--limit <n>', 'Query limit', parsePositiveIntegerOption)
    .option('--include-empty', 'Include empty rows', false)
    .addOption(new Option('--format <format>', 'json or sql').choices(['json', 'sql']).default('json'))
    .option('--execute', 'Execute the compiled query', false)
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
    .option('--max-rows <n>', 'Maximum rows to return when executing', parsePositiveIntegerOption)
    .action(async (options, command) => {
      if (options.measure.length === 0 && !options.queryFile) {
        throw new Error('sl query requires at least one --measure');
      }
      const args = slQueryCommandSchema.parse({
        command: 'query',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connectionId,
        ...(options.queryFile
          ? { queryFile: options.queryFile }
          : {
              query: {
                measures: options.measure,
                dimensions: options.dimension,
                ...(options.filter.length > 0 ? { filters: options.filter } : {}),
                ...(options.segment.length > 0 ? { segments: options.segment } : {}),
                ...(options.orderBy.length > 0 ? { order_by: options.orderBy } : {}),
                ...(options.limit !== undefined ? { limit: options.limit } : {}),
                ...(options.includeEmpty === true ? { include_empty: true } : {}),
              },
            }),
        format: options.format,
        execute: options.execute === true,
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
        ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      });
      await runSlArgs(context, args);
    });
}
