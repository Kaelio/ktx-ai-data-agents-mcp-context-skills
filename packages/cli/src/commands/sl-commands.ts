import { type Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import {
  collectOption,
  type KtxCliCommandContext,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import { slQueryCommandSchema } from '../command-schemas.js';
import type { KtxManagedPythonInstallPolicy } from '../managed-python-command.js';
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

function runtimeInstallPolicy(options: { yes?: boolean; input?: boolean }): KtxManagedPythonInstallPolicy {
  if (options.yes === true && options.input === false) {
    throw new Error('Choose only one runtime install mode: --yes or --no-input');
  }
  if (options.yes === true) {
    return 'auto';
  }
  return options.input === false ? 'never' : 'prompt';
}

async function runSlArgs(context: KtxCliCommandContext, args: KtxSlArgs): Promise<void> {
  const runner = context.deps.sl ?? (await import('../sl.js')).runKtxSl;
  context.setExitCode(await runner(args, context.io));
}

export function registerSlCommands(program: Command, context: KtxCliCommandContext, commandName = 'sl'): void {
  const sl = program
    .command(commandName)
    .description('List, read, validate, query, or write local semantic-layer sources')
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
    .action(async (options: { connectionId?: string; output?: 'pretty' | 'plain' | 'json'; json?: boolean }, command) => {
      await runSlArgs(context, {
        command: 'list',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connectionId,
        output: options.output,
        json: options.json,
      });
    });

  sl.command('read')
    .description('Read a semantic-layer source')
    .argument('<sourceName>', 'Semantic-layer source name')
    .requiredOption('--connection-id <id>', 'KTX connection id')
    .action(async (sourceName: string, options: { connectionId: string }, command) => {
      await runSlArgs(context, {
        command: 'read',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connectionId,
        sourceName,
      });
    });

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

  sl.command('write')
    .description('Write a semantic-layer source')
    .argument('<sourceName>', 'Semantic-layer source name')
    .requiredOption('--connection-id <id>', 'KTX connection id')
    .requiredOption('--yaml <yaml>', 'Semantic-layer source YAML')
    .action(async (sourceName: string, options: { connectionId: string; yaml: string }, command) => {
      await runSlArgs(context, {
        command: 'write',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connectionId,
        sourceName,
        yaml: options.yaml,
      });
    });

  sl.command('query')
    .description('Compile or execute a semantic-layer query')
    .option('--connection-id <id>', 'KTX connection id')
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
      if (options.measure.length === 0) {
        throw new Error('sl query requires at least one --measure');
      }
      const args = slQueryCommandSchema.parse({
        command: 'query',
        projectDir: resolveCommandProjectDir(command),
        connectionId: options.connectionId,
        query: {
          measures: options.measure,
          dimensions: options.dimension,
          ...(options.filter.length > 0 ? { filters: options.filter } : {}),
          ...(options.segment.length > 0 ? { segments: options.segment } : {}),
          ...(options.orderBy.length > 0 ? { order_by: options.orderBy } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.includeEmpty === true ? { include_empty: true } : {}),
        },
        format: options.format,
        execute: options.execute === true,
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicy(options),
        ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      });
      await runSlArgs(context, args);
    });
}
