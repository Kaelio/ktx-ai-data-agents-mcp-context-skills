import { type Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import type { KtxCliCommandContext } from '../cli-program.js';
import { resolveCommandProjectDir } from '../cli-program.js';
import type { KtxSetupDatabaseDriver } from '../setup-databases.js';
import type { KtxSetupLlmBackend } from '../setup-models.js';
import type { KtxSetupSourceType } from '../setup-sources.js';

async function runSetupArgs(
  context: KtxCliCommandContext,
  args: Parameters<NonNullable<typeof context.deps.setup>>[0],
) {
  const runner = context.deps.setup ?? (await import('../setup.js')).runKtxSetup;
  context.setExitCode(await runner(args, context.io));
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function embeddingBackend(value: string): 'openai' | 'sentence-transformers' {
  if (value === 'openai' || value === 'sentence-transformers') {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function llmBackend(value: string): KtxSetupLlmBackend {
  if (value === 'anthropic' || value === 'vertex') {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function databaseDriver(value: string): KtxSetupDatabaseDriver {
  if (
    value === 'sqlite' ||
    value === 'postgres' ||
    value === 'mysql' ||
    value === 'clickhouse' ||
    value === 'sqlserver' ||
    value === 'bigquery' ||
    value === 'snowflake'
  ) {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function sourceType(value: string): KtxSetupSourceType {
  if (
    value === 'dbt' ||
    value === 'metricflow' ||
    value === 'metabase' ||
    value === 'looker' ||
    value === 'lookml' ||
    value === 'notion'
  ) {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function agentScope(value: string): 'project' | 'global' {
  if (value === 'project' || value === 'global') {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function positiveNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function optionWasSpecified(command: Command, optionName: string): boolean {
  const commandWithSources = command as Command & {
    getOptionValueSource?: (name: string) => string | undefined;
    getOptionValueSourceWithGlobals?: (name: string) => string | undefined;
  };
  const source =
    commandWithSources.getOptionValueSourceWithGlobals?.(optionName) ??
    commandWithSources.getOptionValueSource?.(optionName);
  return source !== undefined && source !== 'default';
}

function shouldShowSetupEntryMenu(
  options: {
    new?: boolean;
    existing?: boolean;
    agents?: boolean;
    target?: string;
    global?: boolean;
    project?: boolean;
    skipAgents?: boolean;
    yes?: boolean;
    input?: boolean;
    llmBackend?: KtxSetupLlmBackend;
    anthropicApiKeyEnv?: string;
    anthropicApiKeyFile?: string;
    anthropicModel?: string;
    vertexProject?: string;
    vertexLocation?: string;
    skipLlm?: boolean;
    embeddingBackend?: string;
    embeddingApiKeyEnv?: string;
    embeddingApiKeyFile?: string;
    skipEmbeddings?: boolean;
    database?: KtxSetupDatabaseDriver[];
    databaseConnectionId?: string[];
    newDatabaseConnectionId?: string;
    databaseUrl?: string;
    databaseSchema?: string[];
    enableQueryHistory?: boolean;
    disableQueryHistory?: boolean;
    queryHistoryWindowDays?: number;
    queryHistoryMinExecutions?: number;
    queryHistoryServiceAccountPattern?: string[];
    queryHistoryRedactionPattern?: string[];
    skipDatabases?: boolean;
    source?: KtxSetupSourceType;
    sourceConnectionId?: string;
    sourcePath?: string;
    sourceGitUrl?: string;
    sourceBranch?: string;
    sourceSubpath?: string;
    sourceAuthTokenRef?: string;
    sourceUrl?: string;
    sourceApiKeyRef?: string;
    sourceClientId?: string;
    sourceClientSecretRef?: string;
    sourceWarehouseConnectionId?: string;
    sourceProjectName?: string;
    sourceProfilesPath?: string;
    sourceTarget?: string;
    metabaseDatabaseId?: number;
    notionCrawlMode?: string;
    notionRootPageId?: string[];
    skipInitialSourceIngest?: boolean;
    skipSources?: boolean;
  },
  command: Command,
): boolean {
  if (options.database && options.database.length > 0) {
    return false;
  }
  if (options.databaseConnectionId && options.databaseConnectionId.length > 0) {
    return false;
  }
  if (options.databaseSchema && options.databaseSchema.length > 0) {
    return false;
  }
  if (options.queryHistoryServiceAccountPattern && options.queryHistoryServiceAccountPattern.length > 0) {
    return false;
  }
  if (options.queryHistoryRedactionPattern && options.queryHistoryRedactionPattern.length > 0) {
    return false;
  }
  if (options.notionRootPageId && options.notionRootPageId.length > 0) {
    return false;
  }

  return ![
    'new',
    'existing',
    'agents',
    'target',
    'global',
    'project',
    'skipAgents',
    'yes',
    'input',
    'llmBackend',
    'anthropicApiKeyEnv',
    'anthropicApiKeyFile',
    'anthropicModel',
    'vertexProject',
    'vertexLocation',
    'skipLlm',
    'embeddingBackend',
    'embeddingApiKeyEnv',
    'embeddingApiKeyFile',
    'skipEmbeddings',
    'newDatabaseConnectionId',
    'databaseUrl',
    'enableQueryHistory',
    'disableQueryHistory',
    'queryHistoryWindowDays',
    'queryHistoryMinExecutions',
    'skipDatabases',
    'source',
    'sourceConnectionId',
    'sourcePath',
    'sourceGitUrl',
    'sourceBranch',
    'sourceSubpath',
    'sourceAuthTokenRef',
    'sourceUrl',
    'sourceApiKeyRef',
    'sourceClientId',
    'sourceClientSecretRef',
    'sourceWarehouseConnectionId',
    'sourceProjectName',
    'sourceProfilesPath',
    'sourceTarget',
    'metabaseDatabaseId',
    'notionCrawlMode',
    'skipInitialSourceIngest',
    'skipSources',
  ].some((optionName) => optionWasSpecified(command, optionName));
}

export function registerSetupCommands(program: Command, context: KtxCliCommandContext): void {
  const setup = program
    .command('setup')
    .description('Set up or resume a local KTX project')
    .option('--project-dir <path>', 'KTX project directory')
    .option('--new', 'Create a new KTX project before setup', false)
    .option('--existing', 'Use an existing KTX project', false)
    .option('--agents', 'Install agent integration only', false)
    .addOption(
      new Option('--target <target>', 'Agent target').choices([
        'claude-code',
        'codex',
        'cursor',
        'opencode',
        'universal',
      ]),
    )
    .addOption(new Option('--agent-scope <scope>', 'Agent install scope').argParser(agentScope).default('project'))
    .option('--project', 'Install agent integration into the project scope', false)
    .option('--global', 'Install agent integration into the global target scope', false)
    .option('--skip-agents', 'Leave agent integration incomplete for now', false)
    .option('--yes', 'Accept safe defaults in non-interactive setup', false)
    .option('--no-input', 'Disable interactive terminal input')
    .addOption(new Option('--llm-backend <backend>', 'LLM backend').argParser(llmBackend))
    .option('--anthropic-api-key-env <name>', 'Environment variable containing the Anthropic API key')
    .option('--anthropic-api-key-file <path>', 'File containing the Anthropic API key')
    .option('--anthropic-model <model>', 'Anthropic model ID to validate and save')
    .option('--vertex-project <project>', 'Google Vertex AI project ID, env:NAME, or file:/path')
    .option('--vertex-location <location>', 'Google Vertex AI location, env:NAME, or file:/path')
    .addOption(new Option('--skip-llm', 'Leave LLM setup incomplete for now').hideHelp().default(false))
    .addOption(new Option('--embedding-backend <backend>', 'Embedding backend').argParser(embeddingBackend))
    .option('--embedding-api-key-env <name>', 'Environment variable containing the embedding provider API key')
    .option('--embedding-api-key-file <path>', 'File containing the embedding provider API key')
    .addOption(new Option('--skip-embeddings', 'Leave embedding setup incomplete for now').hideHelp().default(false))
    .option(
      '--database <driver>',
      'Database driver to configure; repeatable',
      (value, previous: KtxSetupDatabaseDriver[]) => {
        return [...previous, databaseDriver(value)];
      },
      [] as KtxSetupDatabaseDriver[],
    )
    .option(
      '--database-connection-id <id>',
      'Existing selected connection id or new connection id',
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option('--new-database-connection-id <id>', 'Connection id for one new database connection', (value) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
        throw new InvalidArgumentError(`Unsafe connection id: ${value}`);
      }
      return value;
    })
    .option('--database-url <url>', 'URL, env:NAME, or file:/path for one new URL-style database connection')
    .option(
      '--database-schema <schema>',
      'Database schema to include; repeatable',
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option('--enable-query-history', 'Enable query history when the selected database supports it', false)
    .option('--disable-query-history', 'Disable query history for the selected database', false)
    .option('--query-history-window-days <number>', 'Query-history lookback window', positiveInteger)
    .option('--query-history-min-executions <number>', 'Minimum executions for a query-history template', positiveInteger)
    .option(
      '--query-history-service-account-pattern <pattern>',
      'Query-history service-account regex; repeatable',
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--query-history-redaction-pattern <pattern>',
      'Query-history SQL-literal redaction regex; repeatable',
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option('--skip-databases', 'Leave database setup incomplete; KTX cannot work until a database is added', false)
    .addOption(new Option('--source <type>', 'Source connector type').argParser(sourceType))
    .option('--source-connection-id <id>', 'Connection id for source setup')
    .option('--source-path <path>', 'Local source path for dbt, MetricFlow, or LookML')
    .option('--source-git-url <url>', 'Git URL for dbt, MetricFlow, or LookML')
    .option('--source-branch <branch>', 'Git branch for source setup')
    .option('--source-subpath <path>', 'Repo subpath for source setup')
    .option('--source-auth-token-ref <ref>', 'env: or file: credential ref for source repo auth')
    .option('--source-url <url>', 'Source service URL for Metabase or Looker')
    .option('--source-api-key-ref <ref>', 'env: or file: API key ref for Metabase or Notion')
    .option('--source-client-id <id>', 'Looker client id')
    .option('--source-client-secret-ref <ref>', 'env: or file: Looker client secret ref')
    .option('--source-warehouse-connection-id <id>', 'Mapped warehouse connection id')
    .option('--source-project-name <name>', 'dbt project name override')
    .option('--source-profiles-path <path>', 'dbt profiles path')
    .option('--source-target <target>', 'dbt target or source-specific mapping target')
    .option('--metabase-database-id <id>', 'Metabase database id to map', positiveNumber)
    .addOption(
      new Option('--notion-crawl-mode <mode>', 'Notion crawl mode').choices(['all_accessible', 'selected_roots']),
    )
    .option(
      '--notion-root-page-id <id>',
      'Notion root page id; repeatable',
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option('--skip-initial-source-ingest', 'Validate source setup without building source context during setup', false)
    .option('--skip-sources', 'Mark optional source setup complete with no sources', false)
    .showHelpAfterError();

  setup.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('setup', actionCommand);
  });

  setup.action(async (options, command) => {
    if (options.anthropicApiKeyEnv && options.anthropicApiKeyFile) {
      context.io.stderr.write(
        'Choose only one Anthropic credential source: --anthropic-api-key-env or --anthropic-api-key-file.\n',
      );
      context.setExitCode(1);
      return;
    }
    if (options.llmBackend === 'vertex' && (options.anthropicApiKeyEnv || options.anthropicApiKeyFile)) {
      context.io.stderr.write('Anthropic API key flags are only valid with --llm-backend anthropic.\n');
      context.setExitCode(1);
      return;
    }
    if (options.llmBackend === 'anthropic' && (options.vertexProject || options.vertexLocation)) {
      context.io.stderr.write('Vertex AI flags are only valid with --llm-backend vertex.\n');
      context.setExitCode(1);
      return;
    }
    if (options.embeddingApiKeyEnv && options.embeddingApiKeyFile) {
      context.io.stderr.write(
        'Choose only one embedding credential source: --embedding-api-key-env or --embedding-api-key-file.\n',
      );
      context.setExitCode(1);
      return;
    }
    if (options.enableQueryHistory && options.disableQueryHistory) {
      context.io.stderr.write(
        'Choose only one query-history action: --enable-query-history or --disable-query-history.\n',
      );
      context.setExitCode(1);
      return;
    }
    if (options.sourcePath && options.sourceGitUrl) {
      context.io.stderr.write('Choose only one source location: --source-path or --source-git-url.\n');
      context.setExitCode(1);
      return;
    }
    if (options.skipSources && options.source) {
      context.io.stderr.write('Choose either --source or --skip-sources.\n');
      context.setExitCode(1);
      return;
    }

    const mode = options.new ? 'new' : options.existing ? 'existing' : 'auto';
    const resolvedAgentScope = options.global ? 'global' : options.agentScope;
    await runSetupArgs(context, {
      command: 'run',
      projectDir: resolveCommandProjectDir(command),
      mode,
      agents: options.agents === true,
      ...(options.target ? { target: options.target } : {}),
      agentScope: resolvedAgentScope,
      skipAgents: options.skipAgents === true,
      inputMode: options.input === false ? 'disabled' : 'auto',
      yes: options.yes === true,
      cliVersion: context.packageInfo.version,
      ...(options.llmBackend ? { llmBackend: options.llmBackend } : {}),
      ...(options.anthropicApiKeyEnv ? { anthropicApiKeyEnv: options.anthropicApiKeyEnv } : {}),
      ...(options.anthropicApiKeyFile ? { anthropicApiKeyFile: options.anthropicApiKeyFile } : {}),
      ...(options.anthropicModel ? { anthropicModel: options.anthropicModel } : {}),
      ...(options.vertexProject ? { vertexProject: options.vertexProject } : {}),
      ...(options.vertexLocation ? { vertexLocation: options.vertexLocation } : {}),
      skipLlm: options.skipLlm === true,
      ...(options.embeddingBackend ? { embeddingBackend: options.embeddingBackend } : {}),
      ...(options.embeddingApiKeyEnv ? { embeddingApiKeyEnv: options.embeddingApiKeyEnv } : {}),
      ...(options.embeddingApiKeyFile ? { embeddingApiKeyFile: options.embeddingApiKeyFile } : {}),
      skipEmbeddings: options.skipEmbeddings === true,
      ...(options.database.length > 0 ? { databaseDrivers: options.database } : {}),
      ...(options.databaseConnectionId.length > 0 ? { databaseConnectionIds: options.databaseConnectionId } : {}),
      ...(options.newDatabaseConnectionId ? { databaseConnectionId: options.newDatabaseConnectionId } : {}),
      ...(options.databaseUrl ? { databaseUrl: options.databaseUrl } : {}),
      databaseSchemas: options.databaseSchema,
      ...(options.enableQueryHistory ? { enableQueryHistory: true } : {}),
      ...(options.disableQueryHistory ? { disableQueryHistory: true } : {}),
      ...(options.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: options.queryHistoryWindowDays } : {}),
      ...(options.queryHistoryMinExecutions !== undefined
        ? { queryHistoryMinExecutions: options.queryHistoryMinExecutions }
        : {}),
      ...(options.queryHistoryServiceAccountPattern.length > 0
        ? { queryHistoryServiceAccountPatterns: options.queryHistoryServiceAccountPattern }
        : {}),
      ...(options.queryHistoryRedactionPattern.length > 0
        ? { queryHistoryRedactionPatterns: options.queryHistoryRedactionPattern }
        : {}),
      skipDatabases: options.skipDatabases === true,
      ...(options.source ? { source: options.source } : {}),
      ...(options.sourceConnectionId ? { sourceConnectionId: options.sourceConnectionId } : {}),
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      ...(options.sourceGitUrl ? { sourceGitUrl: options.sourceGitUrl } : {}),
      ...(options.sourceBranch ? { sourceBranch: options.sourceBranch } : {}),
      ...(options.sourceSubpath ? { sourceSubpath: options.sourceSubpath } : {}),
      ...(options.sourceAuthTokenRef ? { sourceAuthTokenRef: options.sourceAuthTokenRef } : {}),
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
      ...(options.sourceApiKeyRef ? { sourceApiKeyRef: options.sourceApiKeyRef } : {}),
      ...(options.sourceClientId ? { sourceClientId: options.sourceClientId } : {}),
      ...(options.sourceClientSecretRef ? { sourceClientSecretRef: options.sourceClientSecretRef } : {}),
      ...(options.sourceWarehouseConnectionId
        ? { sourceWarehouseConnectionId: options.sourceWarehouseConnectionId }
        : {}),
      ...(options.sourceProjectName ? { sourceProjectName: options.sourceProjectName } : {}),
      ...(options.sourceProfilesPath ? { sourceProfilesPath: options.sourceProfilesPath } : {}),
      ...(options.sourceTarget ? { sourceTarget: options.sourceTarget } : {}),
      ...(options.metabaseDatabaseId !== undefined ? { metabaseDatabaseId: options.metabaseDatabaseId } : {}),
      ...(options.notionCrawlMode ? { notionCrawlMode: options.notionCrawlMode } : {}),
      ...(options.notionRootPageId.length > 0 ? { notionRootPageIds: options.notionRootPageId } : {}),
      runInitialSourceIngest: false,
      skipSources: options.skipSources === true,
      showEntryMenu: shouldShowSetupEntryMenu(options, command),
    });
  });
}
