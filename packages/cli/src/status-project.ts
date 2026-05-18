import { basename } from 'node:path';
import { runClaudeCodeAuthProbe } from '@ktx/context';
import type {
  KtxConfigIssue,
  KtxLocalProject,
  KtxProjectConfig,
  KtxProjectConnectionConfig,
  KtxProjectEmbeddingConfig,
  KtxProjectLlmConfig,
} from '@ktx/context/project';
import type { PostgresPgssProbeResult } from '@ktx/context/ingest';
import {
  formatClaudeCodePromptCachingFix,
  formatClaudeCodePromptCachingWarning,
  ignoredClaudeCodePromptCachingFields,
} from './claude-code-prompt-caching.js';
import type { DoctorCheck } from './doctor.js';
import {
  bold as _bold,
  dim as _dim,
  green,
  red,
  yellow,
} from './io/symbols.js';
import { KTX_NEXT_STEP_DIRECT_COMMANDS } from './next-steps.js';

type ProjectStatusLevel = 'ok' | 'warn' | 'fail';
type ProjectVerdict = 'ready' | 'partial' | 'blocked';

interface ProjectStatusLine {
  status: ProjectStatusLevel;
  detail: string;
  fix?: string;
}

interface LlmStatus extends ProjectStatusLine {
  backend: string;
  model?: string;
}

interface EmbeddingsStatus extends ProjectStatusLine {
  backend: string;
  model?: string;
  dimensions?: number;
}

interface ConnectionStatus extends ProjectStatusLine {
  name: string;
  driver: string;
}

interface QueryHistoryStatus extends ProjectStatusLine {
  connection: string;
  dialect: 'postgres';
}

interface PipelineStatus {
  adapters: string[];
  enrichmentMode: string;
  relationshipsEnabled: boolean;
  relationshipsLlmProposals: boolean;
  relationshipsValidationRequired: boolean;
  agentEnabled: boolean;
  agentTools: string[];
  agentMaxIterations: number;
}

interface StorageStatus {
  state: string;
  search: string;
  gitAutoCommit: boolean;
  gitAuthor: string;
}

interface ConfigStatus {
  status: ProjectStatusLevel;
  detail: string;
  issues: KtxConfigIssue[];
}

interface WarningItem {
  message: string;
  fix?: string;
}

type ClaudeCodeAuthProbe = (input: {
  projectDir: string;
  model: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<{ ok: true } | { ok: false; message: string }>;

const PROJECT_READY_COMMANDS = KTX_NEXT_STEP_DIRECT_COMMANDS.map((step) => step.command);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export interface ProjectStatus {
  projectName: string;
  projectDir: string;
  config: ConfigStatus;
  llm: LlmStatus;
  embeddings: EmbeddingsStatus;
  storage: StorageStatus;
  connections: ConnectionStatus[];
  queryHistory: QueryHistoryStatus[];
  pipeline: PipelineStatus;
  warnings: WarningItem[];
  verdict: ProjectVerdict;
  verdictReason: string;
  nextActions: string[];
  promptCaching?: { enabled: boolean; systemTtl?: string; toolsTtl?: string; historyTtl?: string };
  workUnits?: { stepBudget: number; maxConcurrency: number; failureMode: string };
  memoryAutoCommit: boolean;
  relationshipsDetail?: {
    acceptThreshold: number;
    reviewThreshold: number;
    maxLlmTablesPerBatch: number;
    validationConcurrency: number;
  };
}

function resolveRef(value: unknown, env: NodeJS.ProcessEnv): { resolved: string; via: 'literal' | 'env' | 'file' | 'missing' } {
  if (typeof value !== 'string') return { resolved: '', via: 'missing' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { resolved: '', via: 'missing' };
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice(4).trim();
    const v = env[name];
    return v && v.trim().length > 0 ? { resolved: v, via: 'env' } : { resolved: '', via: 'missing' };
  }
  if (trimmed.startsWith('file:')) {
    return { resolved: trimmed.slice(5), via: 'file' };
  }
  return { resolved: trimmed, via: 'literal' };
}

function envHint(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().startsWith('env:')) {
    return value.trim().slice(4).trim();
  }
  return undefined;
}

async function buildLlmStatus(
  config: KtxProjectLlmConfig,
  options: {
    projectDir: string;
    env: NodeJS.ProcessEnv;
    claudeCodeAuthProbe?: ClaudeCodeAuthProbe;
  },
): Promise<LlmStatus> {
  const env = options.env;
  const backend = config.provider.backend;
  const model = config.models?.default;
  if (backend === 'none') {
    return {
      backend,
      model,
      status: 'fail',
      detail: 'no LLM configured; research agent will not run',
      fix: 'Run: ktx setup (choose an LLM provider)',
    };
  }
  if (backend === 'anthropic') {
    const ref = config.provider.anthropic?.api_key;
    const resolved = resolveRef(ref, env);
    if (resolved.resolved.length > 0) {
      return { backend, model, status: 'ok', detail: `key set${resolved.via === 'env' ? ` (env)` : ''}` };
    }
    if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0) {
      return { backend, model, status: 'ok', detail: 'key set (env: ANTHROPIC_API_KEY)' };
    }
    const hint = envHint(ref);
    return {
      backend,
      model,
      status: 'warn',
      detail: hint ? `key missing (env: ${hint})` : 'key missing',
      fix: hint ? `Set ${hint}` : 'Set ANTHROPIC_API_KEY or rerun `ktx setup`',
    };
  }
  if (backend === 'vertex') {
    const project = config.provider.vertex?.project;
    if (project && project.length > 0) {
      return { backend, model, status: 'ok', detail: `project=${project}` };
    }
    return { backend, model, status: 'warn', detail: 'vertex project not configured', fix: 'Rerun `ktx setup`' };
  }
  if (backend === 'gateway') {
    const ref = config.provider.gateway?.api_key;
    const resolved = resolveRef(ref, env);
    if (resolved.resolved.length > 0) {
      return { backend, model, status: 'ok', detail: 'key set' };
    }
    const hint = envHint(ref);
    return {
      backend,
      model,
      status: 'warn',
      detail: hint ? `key missing (env: ${hint})` : 'key missing',
      fix: hint ? `Set ${hint}` : 'Set the gateway api_key or rerun `ktx setup`',
    };
  }
  if (backend === 'claude-code') {
    const modelName = model ?? 'sonnet';
    const probe = options.claudeCodeAuthProbe ?? runClaudeCodeAuthProbe;
    const auth = await probe({ projectDir: options.projectDir, model: modelName, env });
    if (auth.ok) {
      return {
        backend,
        model: modelName,
        status: 'ok',
        detail: 'local Claude Code session authenticated',
      };
    }
    return {
      backend,
      model: modelName,
      status: 'fail',
      detail: auth.message,
      fix: 'Authenticate Claude Code locally with the Claude Code CLI, then rerun `ktx status`.',
    };
  }
  return { backend, model, status: 'warn', detail: 'unknown LLM backend' };
}

function buildEmbeddingsStatus(config: KtxProjectEmbeddingConfig, env: NodeJS.ProcessEnv): EmbeddingsStatus {
  const backend = config.backend;
  const model = config.model;
  const dimensions = config.dimensions;
  if (backend === 'none') {
    return {
      backend,
      model,
      dimensions,
      status: 'warn',
      detail: 'disabled — semantic search will be skipped',
    };
  }
  if (backend === 'deterministic') {
    return {
      backend,
      model,
      dimensions,
      status: 'warn',
      detail: 'deterministic — semantic search degraded (lexical/dictionary lanes still work)',
    };
  }
  if (backend === 'openai') {
    const ref = config.openai?.api_key;
    const resolved = resolveRef(ref, env);
    if (resolved.resolved.length > 0 || (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0)) {
      return { backend, model, dimensions, status: 'ok', detail: 'key set' };
    }
    const hint = envHint(ref);
    return {
      backend,
      model,
      dimensions,
      status: 'warn',
      detail: hint ? `key missing (env: ${hint})` : 'key missing',
      fix: hint ? `Set ${hint}` : 'Set OPENAI_API_KEY or rerun `ktx setup`',
    };
  }
  if (backend === 'sentence-transformers') {
    const url = config.sentenceTransformers?.base_url;
    if (typeof url === 'string' && url.length > 0) {
      return { backend, model, dimensions, status: 'ok', detail: `service: ${url}` };
    }
    return {
      backend,
      model,
      dimensions,
      status: 'warn',
      detail: 'no base_url configured',
      fix: 'Rerun `ktx setup`',
    };
  }
  return { backend, model, dimensions, status: 'warn', detail: 'unknown embedding backend' };
}

function buildConnectionStatus(
  name: string,
  conn: KtxProjectConnectionConfig,
  env: NodeJS.ProcessEnv,
): ConnectionStatus {
  const driver = (conn.driver ?? 'unknown').toLowerCase();
  const ok = (detail: string): ConnectionStatus => ({ name, driver, status: 'ok', detail });
  const warn = (detail: string, fix?: string): ConnectionStatus => ({ name, driver, status: 'warn', detail, fix });

  switch (driver) {
    case 'postgres':
    case 'postgresql':
    case 'mysql':
    case 'clickhouse':
    case 'sqlserver': {
      const urlRef = resolveRef(conn.url, env);
      if (urlRef.resolved.length > 0) return ok(`url configured`);
      if (typeof (conn as Record<string, unknown>).host === 'string') return ok('host configured');
      const hint = envHint(conn.url);
      return warn(hint ? `url missing (env: ${hint})` : 'url not set', hint ? `Set ${hint}` : 'Rerun `ktx setup`');
    }
    case 'snowflake': {
      const account = (conn as Record<string, unknown>).account;
      if (typeof account === 'string' && account.length > 0) return ok(`account: ${account}`);
      return warn('account not set', 'Rerun `ktx setup`');
    }
    case 'bigquery': {
      const cred = resolveRef((conn as Record<string, unknown>).credentials_json, env);
      if (cred.resolved.length > 0) return ok('credentials configured');
      const hint = envHint((conn as Record<string, unknown>).credentials_json);
      return warn(hint ? `credentials missing (env: ${hint})` : 'credentials not set', hint ? `Set ${hint}` : 'Rerun `ktx setup`');
    }
    case 'sqlite': {
      const path = (conn as Record<string, unknown>).path;
      if (typeof path === 'string' && path.length > 0) return ok(`path: ${path}`);
      return warn('path not set', 'Rerun `ktx setup`');
    }
    case 'duckdb': {
      const path = (conn as Record<string, unknown>).path ?? (conn as Record<string, unknown>).url;
      if (typeof path === 'string' && path.length > 0) return ok(`path: ${path}`);
      return warn('path not set', 'Rerun `ktx setup`');
    }
    case 'notion': {
      const tokenRef =
        (conn as Record<string, unknown>).auth_token_ref ??
        (conn as Record<string, unknown>).auth_token;
      const resolved = resolveRef(tokenRef, env);
      if (resolved.resolved.length > 0) return ok('auth token configured');
      const hint = envHint(tokenRef);
      return warn(hint ? `auth token missing (env: ${hint})` : 'auth token not set', hint ? `Set ${hint}` : 'Rerun `ktx setup`');
    }
    case 'dbt':
    case 'dbt-core':
    case 'dbt-cloud': {
      const repoUrl =
        (conn as Record<string, unknown>).repoUrl ??
        (conn as Record<string, unknown>).repo_url;
      if (typeof repoUrl === 'string' && repoUrl.length > 0) return ok(`repo: ${repoUrl}`);
      return warn('repoUrl not set', 'Rerun `ktx setup`');
    }
    case 'metabase': {
      const url = (conn as Record<string, unknown>).api_url;
      if (typeof url === 'string' && url.length > 0) return ok(`url: ${url}`);
      return warn('api_url not set', 'Rerun `ktx setup`');
    }
    case 'looker':
    case 'lookml': {
      const url = (conn as Record<string, unknown>).base_url ?? (conn as Record<string, unknown>).url;
      if (typeof url === 'string' && url.length > 0) return ok(`url: ${url}`);
      return warn('base_url not set', 'Rerun `ktx setup`');
    }
    case 'metricflow': {
      const repoUrl = (conn as Record<string, unknown>).repoUrl ?? (conn as Record<string, unknown>).repo_url;
      if (typeof repoUrl === 'string' && repoUrl.length > 0) return ok(`repo: ${repoUrl}`);
      return warn('repoUrl not set', 'Rerun `ktx setup`');
    }
    default:
      return { name, driver, status: 'ok', detail: 'configured' };
  }
}

interface PostgresQueryHistoryProbeInput {
  projectDir: string;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
  env: NodeJS.ProcessEnv;
}

type PostgresQueryHistoryProbe = (
  input: PostgresQueryHistoryProbeInput,
) => Promise<PostgresPgssProbeResult>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function queryHistoryRecord(connection: KtxProjectConnectionConfig): Record<string, unknown> | null {
  const context = recordValue(connection.context);
  return recordValue(context?.queryHistory);
}

function legacyHistoricSqlRecord(connection: KtxProjectConnectionConfig): Record<string, unknown> | null {
  return recordValue(connection.historicSql);
}

function isEnabledPostgresQueryHistory(connection: KtxProjectConnectionConfig): boolean {
  const queryHistory = queryHistoryRecord(connection);
  if (queryHistory) {
    return queryHistory.enabled === true;
  }
  const legacy = legacyHistoricSqlRecord(connection);
  return legacy?.enabled === true && legacy.dialect === 'postgres';
}

function isPostgresDriver(connection: KtxProjectConnectionConfig): boolean {
  const driver = String(connection.driver ?? '').toLowerCase();
  return driver === 'postgres' || driver === 'postgresql';
}

function queryHistoryFailureFix(error: unknown, connectionId: string, projectDir: string): string {
  if (error instanceof Error && error.name === 'HistoricSqlExtensionMissingError' && 'remediation' in error) {
    return String(error.remediation);
  }
  if (error instanceof Error && error.name === 'HistoricSqlGrantsMissingError' && 'remediation' in error) {
    return String(error.remediation);
  }
  if (error instanceof Error && error.name === 'HistoricSqlVersionUnsupportedError') {
    return 'Use PostgreSQL 14 or newer, or disable query history for this connection';
  }
  return `Fix connections.${connectionId} Postgres settings, then rerun \`ktx status --project-dir ${projectDir}\``;
}

function failureDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().split('\n')[0] ?? error.message.trim();
  }
  return String(error);
}

function readinessDetail(result: PostgresPgssProbeResult): string {
  const warningText = result.warnings.length > 0 ? ` with warnings: ${result.warnings.join('; ')}` : '';
  const info = result.info ?? [];
  const infoText = info.length > 0 ? `; info: ${info.join('; ')}` : '';
  return `pg_stat_statements ready (${result.pgServerVersion})${warningText}${infoText}`;
}

async function defaultPostgresQueryHistoryProbe(
  input: PostgresQueryHistoryProbeInput,
): Promise<PostgresPgssProbeResult> {
  const [{ PostgresPgssReader }, { KtxPostgresHistoricSqlQueryClient, isKtxPostgresConnectionConfig }] =
    await Promise.all([import('@ktx/context/ingest'), import('@ktx/connector-postgres')]);

  const inputDriver = input.connection.driver ?? 'unknown';
  if (!isKtxPostgresConnectionConfig(input.connection)) {
    throw new Error(`Native PostgreSQL connector cannot run driver "${inputDriver}"`);
  }

  const client = new KtxPostgresHistoricSqlQueryClient({
    connectionId: input.connectionId,
    connection: input.connection,
    env: input.env,
  });
  try {
    return await new PostgresPgssReader().probe(client);
  } finally {
    await client.cleanup();
  }
}

async function buildQueryHistoryStatus(
  project: KtxLocalProject,
  options: BuildProjectStatusOptions,
): Promise<QueryHistoryStatus[]> {
  const targets = Object.entries(project.config.connections)
    .filter(([, connection]) => isEnabledPostgresQueryHistory(connection))
    .sort(([left], [right]) => left.localeCompare(right));

  const probe = options.postgresQueryHistoryProbe ?? defaultPostgresQueryHistoryProbe;
  const env = options.env ?? process.env;
  const statuses: QueryHistoryStatus[] = [];
  for (const [connectionId, connection] of targets) {
    if (!isPostgresDriver(connection)) {
      statuses.push({
        connection: connectionId,
        dialect: 'postgres',
        status: 'fail',
        detail: `connections.${connectionId}.context.queryHistory is enabled but driver is ${String(connection.driver)}`,
        fix: `Set connections.${connectionId}.driver to postgres or disable query history for this connection`,
      });
      continue;
    }

    try {
      const result = await probe({ projectDir: project.projectDir, connectionId, connection, env });
      statuses.push({
        connection: connectionId,
        dialect: 'postgres',
        status: result.warnings.length > 0 ? 'warn' : 'ok',
        detail: readinessDetail(result),
        ...(result.warnings.length > 0
          ? {
              fix: `Update the Postgres parameter group or config, then rerun \`ktx status --project-dir ${project.projectDir}\``,
            }
          : {}),
      });
    } catch (error) {
      statuses.push({
        connection: connectionId,
        dialect: 'postgres',
        status: 'fail',
        detail: failureDetail(error),
        fix: queryHistoryFailureFix(error, connectionId, project.projectDir),
      });
    }
  }

  return statuses;
}

const ADAPTER_DRIVER_REQUIREMENT: Record<string, string[]> = {
  'live-database': ['postgres', 'postgresql', 'mysql', 'snowflake', 'bigquery', 'clickhouse', 'sqlite', 'sqlserver'],
  dbt: ['dbt', 'dbt-core', 'dbt-cloud'],
  notion: ['notion'],
  metabase: ['metabase'],
  looker: ['looker', 'lookml'],
  lookml: ['looker', 'lookml'],
  metricflow: ['metricflow'],
};

function buildPipelineStatus(config: KtxProjectConfig): PipelineStatus {
  return {
    adapters: config.ingest.adapters,
    enrichmentMode: config.scan.enrichment.mode,
    relationshipsEnabled: config.scan.relationships.enabled,
    relationshipsLlmProposals: config.scan.relationships.llmProposals,
    relationshipsValidationRequired: config.scan.relationships.validationRequiredForManifest,
    agentEnabled: config.agent.run_research.enabled,
    agentTools: config.agent.run_research.default_toolset,
    agentMaxIterations: config.agent.run_research.max_iterations,
  };
}

function buildStorageStatus(config: KtxProjectConfig): StorageStatus {
  return {
    state: config.storage.state,
    search: config.storage.search,
    gitAutoCommit: config.storage.git.auto_commit,
    gitAuthor: config.storage.git.author,
  };
}

function buildWarnings(
  config: KtxProjectConfig,
  connections: ConnectionStatus[],
  llm: LlmStatus,
  embeddings: EmbeddingsStatus,
): WarningItem[] {
  const warnings: WarningItem[] = [];

  for (const [connectionId, connection] of Object.entries(config.connections)) {
    const driver = String(connection.driver ?? '').toLowerCase();
    if (hasOwnField(connection, 'readonly')) {
      warnings.push({
        message: `connections.${connectionId}.readonly is no longer used.`,
        fix: `Remove connections.${connectionId}.readonly from ktx.yaml.`,
      });
    }

    if ((driver === 'sqlite' || driver === 'sqlite3') && hasOwnField(connection, 'file_path')) {
      warnings.push({
        message: `connections.${connectionId}.file_path was removed.`,
        fix: `Rename connections.${connectionId}.file_path to path.`,
      });
    }

    if (driver === 'notion' && hasOwnField(connection, 'last_successful_cursor')) {
      warnings.push({
        message: `connections.${connectionId}.last_successful_cursor is local sync state.`,
        fix: 'Remove it from ktx.yaml. KTX stores the Notion cursor in .ktx/db.sqlite.',
      });
    }

    const historicSql = isRecord(connection.historicSql) ? connection.historicSql : null;
    if (!historicSql) {
      continue;
    }
    if (hasOwnField(historicSql, 'concurrency')) {
      warnings.push({
        message: `connections.${connectionId}.historicSql.concurrency is no longer used.`,
        fix: `Remove connections.${connectionId}.historicSql.concurrency from ktx.yaml.`,
      });
    }
    const historicDialect = String(historicSql.dialect ?? driver).toLowerCase();
    if (
      (historicDialect === 'postgres' || historicDialect === 'postgresql') &&
      hasOwnField(historicSql, 'windowDays')
    ) {
      warnings.push({
        message: `connections.${connectionId}.historicSql.windowDays does not constrain pg_stat_statements.`,
        fix: `Remove connections.${connectionId}.historicSql.windowDays from ktx.yaml.`,
      });
    }
  }

  for (const adapter of config.ingest.adapters) {
    const requiredDrivers = ADAPTER_DRIVER_REQUIREMENT[adapter];
    if (!requiredDrivers) continue;
    const hasMatching = connections.some((c) => requiredDrivers.includes(c.driver));
    if (!hasMatching) {
      warnings.push({
        message: `Adapter "${adapter}" is enabled but no connection of type ${requiredDrivers.slice(0, 2).join('/')} is configured.`,
        fix: 'Rerun `ktx setup` to add a connection, or remove the adapter from ingest.adapters.',
      });
    }
  }

  if (config.agent.run_research.enabled && llm.backend === 'none') {
    warnings.push({
      message: 'Research agent is enabled but LLM is not configured.',
      fix: 'Set up an LLM provider via `ktx setup` or disable agent.run_research.enabled.',
    });
  }

  if (embeddings.backend === 'none' && config.ingest.adapters.includes('live-database')) {
    warnings.push({
      message: 'Semantic search is off (embeddings backend = none). Lexical/dictionary lanes still work.',
    });
  }

  const warning = formatClaudeCodePromptCachingWarning(ignoredClaudeCodePromptCachingFields(config.llm));
  if (warning) {
    warnings.push({
      message: warning,
      fix: formatClaudeCodePromptCachingFix(),
    });
  }

  return warnings;
}

function buildVerdict(
  llm: LlmStatus,
  embeddings: EmbeddingsStatus,
  connections: ConnectionStatus[],
  queryHistory: QueryHistoryStatus[],
  warnings: WarningItem[],
): { verdict: ProjectVerdict; reason: string; nextActions: string[] } {
  if (llm.status === 'fail') {
    return {
      verdict: 'blocked',
      reason: 'LLM not configured; research agent will not run.',
      nextActions: ['ktx setup'],
    };
  }
  const failedQueryHistory = queryHistory.filter((entry) => entry.status === 'fail').length;
  if (failedQueryHistory > 0) {
    return {
      verdict: 'blocked',
      reason: `Query history readiness failed for ${failedQueryHistory} connection${failedQueryHistory === 1 ? '' : 's'}.`,
      nextActions: ['ktx status --verbose'],
    };
  }

  const reasons: string[] = [];
  if (llm.status === 'warn') reasons.push('LLM credentials missing');
  if (embeddings.status === 'warn') {
    if (embeddings.backend === 'deterministic' || embeddings.backend === 'none') {
      reasons.push('semantic search disabled');
    } else {
      reasons.push('embedding credentials missing');
    }
  }
  const missing = connections.filter((c) => c.status !== 'ok').length;
  if (missing > 0) reasons.push(`${missing} connection${missing === 1 ? '' : 's'} need configuration`);
  const queryHistoryWarnings = queryHistory.filter((entry) => entry.status === 'warn').length;
  if (queryHistoryWarnings > 0) {
    reasons.push(`${queryHistoryWarnings} query history warning${queryHistoryWarnings === 1 ? '' : 's'}`);
  }
  if (warnings.length > 0) reasons.push(`${warnings.length} config warning${warnings.length === 1 ? '' : 's'}`);

  if (reasons.length === 0) {
    return {
      verdict: 'ready',
      reason: 'Ready.',
      nextActions: [...PROJECT_READY_COMMANDS],
    };
  }

  return {
    verdict: 'partial',
    reason: `Partially ready — ${reasons.join('; ')}.`,
    nextActions: ['ktx setup'],
  };
}

export interface BuildProjectStatusOptions {
  env?: NodeJS.ProcessEnv;
  postgresQueryHistoryProbe?: PostgresQueryHistoryProbe;
  claudeCodeAuthProbe?: ClaudeCodeAuthProbe;
  configIssues?: KtxConfigIssue[];
}

function buildConfigStatus(issues: KtxConfigIssue[] | undefined): ConfigStatus {
  const list = issues ?? [];
  if (list.length === 0) {
    return { status: 'ok', detail: 'ktx.yaml schema valid', issues: [] };
  }
  return {
    status: 'warn',
    detail: `${list.length} issue${list.length === 1 ? '' : 's'} in ktx.yaml`,
    issues: list,
  };
}

export async function buildProjectStatus(project: KtxLocalProject, options: BuildProjectStatusOptions = {}): Promise<ProjectStatus> {
  const env = options.env ?? process.env;
  const config = project.config;

  const configStatus = buildConfigStatus(options.configIssues);
  const llm = await buildLlmStatus(config.llm, {
    projectDir: project.projectDir,
    env,
    claudeCodeAuthProbe: options.claudeCodeAuthProbe,
  });
  const embeddings = buildEmbeddingsStatus(config.ingest.embeddings, env);
  const storage = buildStorageStatus(config);
  const connections = Object.entries(config.connections).map(([name, conn]) =>
    buildConnectionStatus(name, conn, env),
  );
  const queryHistory = await buildQueryHistoryStatus(project, options);
  const pipeline = buildPipelineStatus(config);
  const warnings = buildWarnings(config, connections, llm, embeddings);
  const { verdict, reason, nextActions } = buildVerdict(llm, embeddings, connections, queryHistory, warnings);

  return {
    projectName: basename(project.projectDir) || project.projectDir,
    projectDir: project.projectDir,
    config: configStatus,
    llm,
    embeddings,
    storage,
    connections,
    queryHistory,
    pipeline,
    warnings,
    verdict,
    verdictReason: reason,
    nextActions,
    promptCaching: config.llm.promptCaching
      ? {
          enabled: config.llm.promptCaching.enabled ?? false,
          systemTtl: config.llm.promptCaching.systemTtl,
          toolsTtl: config.llm.promptCaching.toolsTtl,
          historyTtl: config.llm.promptCaching.historyTtl,
        }
      : undefined,
    workUnits: {
      stepBudget: config.ingest.workUnits.stepBudget,
      maxConcurrency: config.ingest.workUnits.maxConcurrency,
      failureMode: config.ingest.workUnits.failureMode,
    },
    memoryAutoCommit: config.memory.auto_commit,
    relationshipsDetail: {
      acceptThreshold: config.scan.relationships.acceptThreshold,
      reviewThreshold: config.scan.relationships.reviewThreshold,
      maxLlmTablesPerBatch: config.scan.relationships.maxLlmTablesPerBatch,
      validationConcurrency: config.scan.relationships.validationConcurrency,
    },
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

const SYMBOL: Record<ProjectStatusLevel, string> = { ok: '✓', warn: '⚠', fail: '✗' };

function colorForLevel(useColor: boolean, level: ProjectStatusLevel, text: string): string {
  if (!useColor) return text;
  return level === 'ok' ? green(text) : level === 'warn' ? yellow(text) : red(text);
}


function abbreviateHome(filePath: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (home && (filePath === home || filePath.startsWith(`${home}/`))) {
    return filePath === home ? '~' : `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

export interface RenderProjectStatusOptions {
  verbose?: boolean;
  useColor?: boolean;
  durationMs?: number;
  toolchainChecks?: DoctorCheck[];
  env?: NodeJS.ProcessEnv;
}

export function renderProjectStatus(status: ProjectStatus, options: RenderProjectStatusOptions = {}): string {
  const verbose = options.verbose ?? false;
  const useColor = options.useColor ?? false;
  const env = options.env ?? process.env;
  const dim = useColor ? _dim : (s: string) => s;
  const bold = useColor ? _bold : (s: string) => s;
  const color = (level: ProjectStatusLevel, s: string) => colorForLevel(useColor, level, s);
  const sym = (level: ProjectStatusLevel) => color(level, SYMBOL[level]);

  const lines: string[] = [];
  const dirStr = abbreviateHome(status.projectDir, env);
  lines.push(`${bold('KTX status')} ${dim('·')} ${status.projectName} ${dim(`(${dirStr})`)}`);
  lines.push('');

  const labelPad = 'Connections'.length;
  const label = (text: string) => text.padEnd(labelPad);

  // Core readiness rows
  const llmDetail = [status.llm.backend, status.llm.model].filter(Boolean).join(` ${dim('·')} `);
  lines.push(`  ${label('LLM')}   ${llmDetail}  ${sym(status.llm.status)} ${dim(status.llm.detail)}`);

  const embedParts = [status.embeddings.backend];
  if (status.embeddings.model) embedParts.push(status.embeddings.model);
  const embedDim = status.embeddings.dimensions ? `(${status.embeddings.dimensions}d)` : '';
  const embedDetail = `${embedParts.join(` ${dim('·')} `)}${embedDim ? ` ${embedDim}` : ''}`;
  lines.push(`  ${label('Embeddings')}   ${embedDetail}  ${sym(status.embeddings.status)} ${dim(status.embeddings.detail)}`);

  lines.push(`  ${label('Storage')}   ${dim(`${status.storage.state} (state) · ${status.storage.search} (search)`)}`);
  lines.push(`  ${label('Config')}   ${sym(status.config.status)} ${dim(status.config.detail)}`);
  if (status.config.issues.length > 0) {
    for (const issue of status.config.issues) {
      lines.push(`      ${color('warn', SYMBOL.warn)} ${issue.message}`);
      if (issue.fix) lines.push(`        ${dim(`→ ${issue.fix}`)}`);
    }
  }
  lines.push('');

  // Connections
  if (status.connections.length === 0) {
    lines.push(`  ${bold('Connections')} ${dim('(none)')}`);
    lines.push(`      ${dim('No connections configured. Run `ktx setup` to add one.')}`);
  } else {
    lines.push(`  ${bold('Connections')} ${dim(`(${status.connections.length})`)}`);
    const nameWidth = Math.max(...status.connections.map((c) => c.name.length));
    const driverWidth = Math.max(...status.connections.map((c) => c.driver.length));
    for (const conn of status.connections) {
      lines.push(
        `    ${sym(conn.status)} ${conn.name.padEnd(nameWidth)}   ${dim(conn.driver.padEnd(driverWidth))}   ${conn.detail}`,
      );
      if (conn.fix && conn.status !== 'ok') {
        const indent = 6 + nameWidth + 3 + driverWidth + 3;
        lines.push(`${' '.repeat(indent)}${dim(`→ ${conn.fix}`)}`);
      }
    }
  }
  lines.push('');

  if (status.queryHistory.length > 0) {
    lines.push(`  ${bold('Query history')}`);
    const connectionWidth = Math.max(...status.queryHistory.map((entry) => entry.connection.length));
    for (const entry of status.queryHistory) {
      lines.push(
        `    ${sym(entry.status)} ${entry.connection.padEnd(connectionWidth)}   ${dim(entry.dialect)}   ${entry.detail}`,
      );
      if (entry.fix && entry.status !== 'ok') {
        const indent = 6 + connectionWidth + 3 + entry.dialect.length + 3;
        lines.push(`${' '.repeat(indent)}${dim(`→ ${entry.fix}`)}`);
      }
    }
    lines.push('');
  }

  // Pipeline
  lines.push(`  ${bold('Pipeline')}`);
  const pipelineLabelWidth = Math.max('Adapters'.length, 'Enrichment'.length, 'Research agent'.length);
  const pLabel = (text: string) => text.padEnd(pipelineLabelWidth);
  lines.push(`    ${pLabel('Adapters')}   ${status.pipeline.adapters.length > 0 ? status.pipeline.adapters.join(', ') : dim('(none)')}`);
  const enrichmentDetail = [`${status.pipeline.enrichmentMode} mode`];
  if (status.pipeline.relationshipsEnabled) {
    const bits = ['relationships on'];
    if (status.pipeline.relationshipsLlmProposals) bits.push('LLM proposals');
    if (status.pipeline.relationshipsValidationRequired) bits.push('validation required');
    enrichmentDetail.push(bits.join(', '));
  } else {
    enrichmentDetail.push('relationships off');
  }
  lines.push(`    ${pLabel('Enrichment')}   ${enrichmentDetail.join(` ${dim('·')} `)}`);
  const agentDetail = status.pipeline.agentEnabled
    ? `enabled ${dim(`(${status.pipeline.agentTools.length} tool${status.pipeline.agentTools.length === 1 ? '' : 's'})`)}`
    : dim('disabled');
  lines.push(`    ${pLabel('Research agent')}   ${agentDetail}`);
  lines.push('');

  // Warnings
  if (status.warnings.length > 0) {
    lines.push(`  ${bold('Warnings')}`);
    for (const w of status.warnings) {
      lines.push(`    ${color('warn', SYMBOL.warn)} ${w.message}`);
      if (w.fix) lines.push(`        ${dim(`→ ${w.fix}`)}`);
    }
    lines.push('');
  }

  // Verbose extras
  if (verbose) {
    if (options.toolchainChecks && options.toolchainChecks.length > 0) {
      lines.push(`  ${bold('Toolchain')}`);
      for (const check of options.toolchainChecks) {
        const lv: ProjectStatusLevel = check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : 'fail';
        lines.push(`    ${sym(lv)} ${check.label}: ${check.detail}`);
        if (check.fix && lv !== 'ok') lines.push(`        ${dim(`→ ${check.fix}`)}`);
      }
      lines.push('');
    }
    if (status.promptCaching) {
      const pc = status.promptCaching;
      const bits = [`enabled=${pc.enabled}`];
      if (pc.systemTtl) bits.push(`system=${pc.systemTtl}`);
      if (pc.toolsTtl) bits.push(`tools=${pc.toolsTtl}`);
      if (pc.historyTtl) bits.push(`history=${pc.historyTtl}`);
      lines.push(`  ${bold('Prompt caching')}   ${dim(bits.join(', '))}`);
    }
    if (status.workUnits) {
      const wu = status.workUnits;
      lines.push(`  ${bold('Work units')}       ${dim(`stepBudget=${wu.stepBudget}, maxConcurrency=${wu.maxConcurrency}, failureMode=${wu.failureMode}`)}`);
    }
    if (status.relationshipsDetail) {
      const r = status.relationshipsDetail;
      lines.push(
        `  ${bold('Relationships')}    ${dim(`accept=${r.acceptThreshold}, review=${r.reviewThreshold}, maxLlmTables=${r.maxLlmTablesPerBatch}, concurrency=${r.validationConcurrency}`)}`,
      );
    }
    lines.push(
      `  ${bold('Agent')}            ${dim(`max_iterations=${status.pipeline.agentMaxIterations}, tools=${status.pipeline.agentTools.join(', ') || '(none)'}`)}`,
    );
    lines.push(`  ${bold('Memory')}           ${dim(`auto_commit=${status.memoryAutoCommit}`)}`);
    lines.push(
      `  ${bold('Git')}              ${dim(`auto_commit=${status.storage.gitAutoCommit}, author=${status.storage.gitAuthor}`)}`,
    );
    lines.push('');
  }

  // Verdict + next steps
  const verdictLevel: ProjectStatusLevel =
    status.verdict === 'ready' ? 'ok' : status.verdict === 'partial' ? 'warn' : 'fail';
  const duration = options.durationMs !== undefined ? ` ${dim(`(${(options.durationMs / 1000).toFixed(2)}s)`)}` : '';
  if (status.verdict === 'ready') {
    const hint = `  ${dim('Try:')} ${status.nextActions.join(dim('  ·  '))}`;
    lines.push(`${color(verdictLevel, status.verdictReason)}${hint}${duration}`);
  } else {
    const hint = status.nextActions.length > 0 ? `  ${dim('Next:')} ${status.nextActions.join(dim('  ·  '))}` : '';
    lines.push(`${color(verdictLevel, status.verdictReason)}${hint}${duration}`);
  }
  lines.push('');

  return lines.join('\n');
}
