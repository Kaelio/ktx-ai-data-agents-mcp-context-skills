import { type Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import { type KtxCliCommandContext, resolveCommandProjectDir } from '../cli-program.js';
import type { KtxSqlArgs } from '../sql.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/sql-commands');

const DEFAULT_MAX_ROWS = 1000;
const MAX_ROWS_CAP = 10_000;

function parseSqlMaxRowsOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ROWS_CAP) {
    throw new InvalidArgumentError(`must be an integer between 1 and ${MAX_ROWS_CAP}`);
  }
  return parsed;
}

async function runSqlArgs(context: KtxCliCommandContext, args: KtxSqlArgs): Promise<void> {
  const runner = context.deps.sql ?? (await import('../sql.js')).runKtxSql;
  context.setExitCode(await runner(args, context.io));
}

export function registerSqlCommands(program: Command, context: KtxCliCommandContext): void {
  program
    .command('sql')
    .description('Execute parser-validated read-only SQL against a configured connection')
    .argument('<sql...>', 'SQL query to execute')
    .requiredOption('-c, --connection <id>', 'ktx connection id')
    .option('--max-rows <n>', 'Maximum rows to return', parseSqlMaxRowsOption, DEFAULT_MAX_ROWS)
    .addOption(
      new Option('--output <mode>', 'Output mode: pretty (default), plain (TSV), or json').choices([
        'pretty',
        'plain',
        'json',
      ]),
    )
    .option('--json', 'Shortcut for --output=json (overrides --output)', false)
    .action(
      async (
        sqlParts: string[],
        options: {
          connection: string;
          maxRows: number;
          output?: 'pretty' | 'plain' | 'json';
          json?: boolean;
        },
        command,
      ) => {
        await runSqlArgs(context, {
          command: 'execute',
          projectDir: resolveCommandProjectDir(command),
          connectionId: options.connection,
          sql: sqlParts.join(' '),
          maxRows: options.maxRows,
          output: options.output,
          json: options.json === true,
          cliVersion: context.packageInfo.version,
        });
      },
    );
}
