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
    .usage('[options] [query...]')
    .argument('[query...]', 'Search query; omit to list all sources')
    .option('--connection-id <id>', 'KTX connection id')
    .option('--limit <number>', 'Maximum search results (search mode only)', parsePositiveIntegerOption)
    .addOption(
      new Option('--output <mode>', 'Output mode: pretty (default in TTY), plain (TSV), or json').choices([
        'pretty',
        'plain',
        'json',
      ]),
    )
    .option('--json', 'Shortcut for --output=json (overrides --output)', false)
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    )
    .action(
      async (
        query: string[],
        options: {
          connectionId?: string;
          limit?: number;
          output?: 'pretty' | 'plain' | 'json';
          json?: boolean;
        },
        command,
      ) => {
        if (query.length === 0) {
          await runSlArgs(context, {
            command: 'list',
            projectDir: resolveCommandProjectDir(command),
            connectionId: options.connectionId,
            output: options.output,
            json: options.json,
            cliVersion: context.packageInfo.version,
          });
          return;
        }
        await runSlArgs(context, {
          command: 'search',
          projectDir: resolveCommandProjectDir(command),
          connectionId: options.connectionId,
          query: query.join(' '),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          output: options.output,
          json: options.json,
          cliVersion: context.packageInfo.version,
        });
      },
    );

  sl.command('read')
    .description('Read a semantic-layer source YAML file (set --connection-id on `ktx sl`)')
    .argument('<sourceName>', 'Semantic-layer source name')
    .action(async (sourceName: string, _options, command) => {
      const parentOpts = command.parent?.opts() as { connectionId?: string } | undefined;
      const connectionId = parentOpts?.connectionId;
      if (connectionId === undefined) {
        command.error("error: required option '--connection-id <id>' not specified");
      }
      await runSlArgs(context, {
        command: 'read',
        projectDir: resolveCommandProjectDir(command),
        connectionId: connectionId as string,
        sourceName,
      });
    });

  sl.command('validate')
    .description('Validate a semantic-layer source (set --connection-id on `ktx sl`)')
    .argument('<sourceName>', 'Semantic-layer source name')
    .action(async (sourceName: string, _options, command) => {
      const parentOpts = command.parent?.opts() as { connectionId?: string } | undefined;
      const connectionId = parentOpts?.connectionId;
      if (connectionId === undefined) {
        command.error("error: required option '--connection-id <id>' not specified");
      }
      await runSlArgs(context, {
        command: 'validate',
        projectDir: resolveCommandProjectDir(command),
        connectionId: connectionId as string,
        sourceName,
      });
    });

  sl.command('query')
    .description('Compile or execute a semantic-layer query (set --connection-id on `ktx sl`)')
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
      const parentOpts = command.parent?.opts() as { connectionId?: string } | undefined;
      const args = slQueryCommandSchema.parse({
        command: 'query',
        projectDir: resolveCommandProjectDir(command),
        connectionId: parentOpts?.connectionId,
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
