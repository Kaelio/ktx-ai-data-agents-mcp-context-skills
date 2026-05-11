import { type Command, InvalidArgumentError } from '@commander-js/extra-typings';
import { type KtxCliCommandContext, resolveCommandProjectDir } from '../cli-program.js';
import { runtimeInstallPolicyFromFlags } from '../managed-python-command.js';
import type { KtxServeArgs } from '../serve.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/serve-commands');

function parseMcp(value: string): 'stdio' {
  if (value === 'stdio') {
    return 'stdio';
  }
  throw new InvalidArgumentError('Only stdio is supported in this phase');
}

export function registerServeCommands(program: Command, context: KtxCliCommandContext): void {
  program
    .command('serve')
    .description('Run standalone KTX services such as MCP stdio')
    .requiredOption('--mcp <mode>', 'MCP transport mode', parseMcp)
    .option('--user-id <id>', 'Local user id', 'local')
    .option('--semantic-compute', 'Enable semantic-layer compute', false)
    .option('--semantic-compute-url <url>', 'HTTP semantic-layer compute URL')
    .option('--yes', 'Install the managed Python runtime without prompting when required', false)
    .option('--no-input', 'Disable interactive managed runtime installation')
    .option('--database-introspection-url <url>', 'Daemon URL for live-database introspection')
    .option('--execute-queries', 'Allow semantic-layer query execution', false)
    .option('--memory-capture', 'Enable memory capture', false)
    .option('--memory-model <model>', 'Memory capture model')
    .showHelpAfterError()
    .action(async (options, command): Promise<void> => {
      const semanticCompute = options.semanticCompute === true || Boolean(options.semanticComputeUrl);
      if (options.executeQueries === true && !semanticCompute) {
        throw new Error('--execute-queries requires --semantic-compute');
      }
      const args: KtxServeArgs = {
        mcp: options.mcp,
        projectDir: resolveCommandProjectDir(command),
        userId: options.userId,
        semanticCompute,
        semanticComputeUrl: options.semanticComputeUrl,
        databaseIntrospectionUrl: options.databaseIntrospectionUrl,
        executeQueries: options.executeQueries === true,
        memoryCapture: options.memoryCapture === true,
        memoryModel: options.memoryModel,
        cliVersion: context.packageInfo.version,
        runtimeInstallPolicy: runtimeInstallPolicyFromFlags(options),
      };
      const runner = context.deps.serveStdio ?? (await import('../serve.js')).runKtxServeStdio;
      context.setExitCode(await runner(args));
    });
}
