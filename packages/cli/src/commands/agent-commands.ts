import { Option, type Command } from '@commander-js/extra-typings';
import type { KtxAgentArgs } from '../agent.js';
import type { KtxCliCommandContext } from '../cli-program.js';
import { parsePositiveIntegerOption, resolveCommandProjectDir } from '../cli-program.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';

async function runAgent(context: KtxCliCommandContext, args: KtxAgentArgs): Promise<void> {
  const runner = context.deps.agent ?? (await import('../agent.js')).runKtxAgent;
  context.setExitCode(await runner(args, context.io));
}

function jsonOption(): Option {
  return new Option('--json', 'Print JSON output').makeOptionMandatory();
}

export function registerAgentCommands(program: Command, context: KtxCliCommandContext): void {
  const agent = program
    .command('agent', { hidden: true })
    .description('Machine-readable KTX commands for coding agents')
    .showHelpAfterError();

  agent.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('agent', actionCommand);
  });

  agent
    .command('tools')
    .description('Print available agent-facing KTX tools')
    .addOption(jsonOption())
    .action(async (_options, command) => {
      await runAgent(context, { command: 'tools', projectDir: resolveCommandProjectDir(command), json: true });
    });

  agent
    .command('context')
    .description('Print project context for agent planning')
    .addOption(jsonOption())
    .action(async (_options, command) => {
      await runAgent(context, { command: 'context', projectDir: resolveCommandProjectDir(command), json: true });
    });

  const sl = agent.command('sl').description('Semantic-layer agent commands');
  sl.command('list')
    .description('List semantic-layer sources')
    .addOption(jsonOption())
    .option('--connection-id <id>', 'Filter by connection id')
    .option('--query <text>', 'Search source names and descriptions')
    .action(async (options: { connectionId?: string; query?: string }, command) => {
      await runAgent(context, {
        command: 'sl-list',
        projectDir: resolveCommandProjectDir(command),
        json: true,
        ...(options.connectionId ? { connectionId: options.connectionId } : {}),
        ...(options.query ? { query: options.query } : {}),
      });
    });
  sl.command('read')
    .description('Read one semantic-layer source')
    .argument('<sourceName>')
    .addOption(jsonOption())
    .option('--connection-id <id>', 'Connection id containing the source')
    .action(async (sourceName: string, options: { connectionId?: string }, command) => {
      await runAgent(context, {
        command: 'sl-read',
        projectDir: resolveCommandProjectDir(command),
        json: true,
        sourceName,
        ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      });
    });
  sl.command('query')
    .description('Run a semantic-layer query JSON file')
    .addOption(jsonOption())
    .requiredOption('--connection-id <id>', 'Connection id for execution')
    .requiredOption('--query-file <path>', 'JSON semantic-layer query file')
    .option('--execute', 'Execute the compiled query against the connection', false)
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
    .option('--max-rows <number>', 'Maximum rows to return when executing', parsePositiveIntegerOption)
    .action(
      async (
        options: {
          connectionId: string;
          queryFile: string;
          execute: boolean;
          maxRows?: number;
          yes?: boolean;
          input?: boolean;
        },
        command,
      ) => {
        await runAgent(context, {
          command: 'sl-query',
          projectDir: resolveCommandProjectDir(command),
          json: true,
          connectionId: options.connectionId,
          queryFile: options.queryFile,
          execute: options.execute,
          cliVersion: context.packageInfo.version,
          runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
          ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
        });
      },
    );

  const wiki = agent.command('wiki').description('KTX wiki agent commands');
  wiki
    .command('search')
    .description('Search KTX wiki pages')
    .argument('<query>')
    .addOption(jsonOption())
    .option('--limit <number>', 'Maximum search results', parsePositiveIntegerOption, 10)
    .action(async (query: string, options: { limit: number }, command) => {
      await runAgent(context, {
        command: 'wiki-search',
        projectDir: resolveCommandProjectDir(command),
        json: true,
        query,
        limit: options.limit,
      });
    });
  wiki
    .command('read')
    .description('Read one KTX wiki page')
    .argument('<pageId>')
    .addOption(jsonOption())
    .action(async (pageId: string, _options, command) => {
      await runAgent(context, { command: 'wiki-read', projectDir: resolveCommandProjectDir(command), json: true, pageId });
    });

  const sql = agent.command('sql').description('Safe SQL execution commands');
  sql
    .command('execute')
    .description('Execute read-only SQL with a row limit')
    .addOption(jsonOption())
    .requiredOption('--connection-id <id>', 'Connection id for execution')
    .requiredOption('--sql-file <path>', 'SQL file to execute')
    .requiredOption('--max-rows <number>', 'Maximum rows to return', parsePositiveIntegerOption)
    .action(async (options: { connectionId: string; sqlFile: string; maxRows: number }, command) => {
      await runAgent(context, {
        command: 'sql-execute',
        projectDir: resolveCommandProjectDir(command),
        json: true,
        connectionId: options.connectionId,
        sqlFile: options.sqlFile,
        maxRows: options.maxRows,
      });
    });
}
