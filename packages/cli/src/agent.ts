import { readFile } from 'node:fs/promises';
import type { KtxCliIo } from './cli-runtime.js';
import {
  createKtxAgentRuntime,
  parseAgentMaxRows,
  readAgentJsonFile,
  writeAgentJson,
  writeAgentJsonError,
  type KtxAgentRuntime,
  type KtxAgentRuntimeDeps,
} from './agent-runtime.js';
import {
  isMissingProjectConfigError,
  missingConnectionSlSearchReadiness,
  missingProjectSlSearchReadiness,
  noConnectionsSlSearchReadiness,
  noIndexedSourcesSlSearchReadiness,
  type KtxAgentSlSearchReadinessDetail,
} from './agent-search-readiness.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import { readKtxSetupStatus, type KtxSetupStatus } from './setup.js';

export type KtxAgentArgs =
  | { command: 'tools'; projectDir: string; json: true }
  | { command: 'context'; projectDir: string; json: true }
  | { command: 'sl-list'; projectDir: string; json: true; connectionId?: string; query?: string }
  | { command: 'sl-read'; projectDir: string; json: true; connectionId?: string; sourceName: string }
  | {
      command: 'sl-query';
      projectDir: string;
      json: true;
      connectionId: string;
      queryFile: string;
      execute: boolean;
      maxRows?: number;
      cliVersion: string;
      runtimeInstallPolicy: KtxManagedPythonInstallPolicy;
    }
  | { command: 'wiki-search'; projectDir: string; json: true; query: string; limit: number }
  | { command: 'wiki-read'; projectDir: string; json: true; pageId: string }
  | { command: 'sql-execute'; projectDir: string; json: true; connectionId: string; sqlFile: string; maxRows?: number };

export interface KtxAgentDeps extends KtxAgentRuntimeDeps {
  createRuntime?: (options: {
    projectDir: string;
    enableSemanticCompute: boolean;
    enableQueryExecution: boolean;
    cliVersion?: string;
    runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
    io?: KtxCliIo;
  }) => Promise<KtxAgentRuntime>;
  readSetupStatus?: (
    projectDir: string,
  ) => Promise<KtxSetupStatus | { project: { path?: string; ready: boolean }; agents: unknown[] }>;
}

const AGENT_TOOLS = [
  { name: 'context', command: 'ktx agent context --json' },
  { name: 'sl.list', command: 'ktx agent sl list --json [--connection-id <id>] [--query <text>]' },
  { name: 'sl.read', command: 'ktx agent sl read <sourceName> --json [--connection-id <id>]' },
  {
    name: 'sl.query',
    command: 'ktx agent sl query --json --connection-id <id> --query-file <path> --execute --max-rows 100',
  },
  { name: 'wiki.search', command: 'ktx agent wiki search <query> --json [--limit 10]' },
  { name: 'wiki.read', command: 'ktx agent wiki read <pageId> --json' },
  {
    name: 'sql.execute',
    command: 'ktx agent sql execute --json --connection-id <id> --sql-file <path> --max-rows 100',
  },
] as const;

function writeAgentSlSearchReadinessError(io: KtxCliIo, detail: KtxAgentSlSearchReadinessDetail): void {
  writeAgentJsonError(io, detail.message, { code: detail.code, nextSteps: detail.nextSteps });
}

async function runtimeFor(args: KtxAgentArgs, deps: KtxAgentDeps, io: KtxCliIo): Promise<KtxAgentRuntime> {
  const needsSemanticCompute = args.command === 'sl-query';
  const needsQueryExecution = args.command === 'sql-execute' || (args.command === 'sl-query' && args.execute);
  const runtimeOptions = {
    projectDir: args.projectDir,
    enableSemanticCompute: needsSemanticCompute,
    enableQueryExecution: needsQueryExecution,
    ...(args.command === 'sl-query'
      ? {
          cliVersion: args.cliVersion,
          runtimeInstallPolicy: args.runtimeInstallPolicy,
          io,
        }
      : {}),
  };
  return deps.createRuntime ? deps.createRuntime(runtimeOptions) : createKtxAgentRuntime(runtimeOptions, deps);
}

function connectionIdForSource(runtime: KtxAgentRuntime, requested: string | undefined): string {
  if (requested) return requested;
  const ids = Object.keys(runtime.project.config.connections ?? {});
  if (ids.length === 1) return ids[0] as string;
  throw new Error('Use --connection-id when the project has zero or multiple connections.');
}

export async function runKtxAgent(args: KtxAgentArgs, io: KtxCliIo, deps: KtxAgentDeps = {}): Promise<number> {
  try {
    if (args.command === 'tools') {
      writeAgentJson(io, { projectDir: args.projectDir, tools: AGENT_TOOLS });
      return 0;
    }

    const runtime = await runtimeFor(args, deps, io);

    if (args.command === 'context') {
      const [status, connections, semanticLayer] = await Promise.all([
        (deps.readSetupStatus ?? readKtxSetupStatus)(args.projectDir),
        runtime.ports.connections?.list() ?? [],
        runtime.ports.semanticLayer?.listSources({}) ?? { sources: [], totalSources: 0 },
      ]);
      writeAgentJson(io, { projectDir: args.projectDir, status, connections, semanticLayer, tools: AGENT_TOOLS });
      return 0;
    }

    if (args.command === 'sl-list') {
      const semanticLayer = runtime.ports.semanticLayer;
      if (!semanticLayer) throw new Error('Semantic-layer tools are not available for this project.');
      if (args.query) {
        const connectionIds = Object.keys(runtime.project.config.connections ?? {});
        if (args.connectionId && !runtime.project.config.connections[args.connectionId]) {
          writeAgentSlSearchReadinessError(
            io,
            missingConnectionSlSearchReadiness(args.projectDir, args.connectionId, args.query),
          );
          return 1;
        }
        if (connectionIds.length === 0) {
          writeAgentSlSearchReadinessError(io, noConnectionsSlSearchReadiness(args.projectDir, args.query));
          return 1;
        }
      }

      const listed = await semanticLayer.listSources({ connectionId: args.connectionId, query: args.query });
      if (args.query && listed.sources.length === 0) {
        const allSources = await semanticLayer.listSources({ connectionId: args.connectionId });
        if (allSources.totalSources === 0) {
          writeAgentSlSearchReadinessError(io, noIndexedSourcesSlSearchReadiness(args.projectDir, args.query));
          return 1;
        }
      }

      writeAgentJson(io, listed);
      return 0;
    }

    if (args.command === 'sl-read') {
      const semanticLayer = runtime.ports.semanticLayer;
      if (!semanticLayer) throw new Error('Semantic-layer tools are not available for this project.');
      const source = await semanticLayer.readSource({
        connectionId: connectionIdForSource(runtime, args.connectionId),
        sourceName: args.sourceName,
      });
      if (!source) throw new Error(`Semantic-layer source "${args.sourceName}" was not found.`);
      writeAgentJson(io, source);
      return 0;
    }

    if (args.command === 'sl-query') {
      const semanticLayer = runtime.ports.semanticLayer;
      if (!semanticLayer) throw new Error('Semantic-layer tools are not available for this project.');
      const query = await readAgentJsonFile(args.queryFile);
      const maxRows = args.execute ? parseAgentMaxRows(args.maxRows) : args.maxRows;
      writeAgentJson(
        io,
        await semanticLayer.query({
          connectionId: args.connectionId,
          query: { ...query, ...(maxRows !== undefined ? { limit: maxRows } : {}) } as never,
        }),
      );
      return 0;
    }

    if (args.command === 'wiki-search') {
      const knowledge = runtime.ports.knowledge;
      if (!knowledge) throw new Error('Wiki tools are not available for this project.');
      writeAgentJson(io, await knowledge.search({ userId: 'agent', query: args.query, limit: args.limit }));
      return 0;
    }

    if (args.command === 'wiki-read') {
      const knowledge = runtime.ports.knowledge;
      if (!knowledge) throw new Error('Wiki tools are not available for this project.');
      const page = await knowledge.read({ userId: 'agent', key: args.pageId });
      if (!page) throw new Error(`Wiki page "${args.pageId}" was not found.`);
      writeAgentJson(io, page);
      return 0;
    }

    const queryExecutor = runtime.queryExecutor;
    if (!queryExecutor) throw new Error('SQL execution is not available for this project.');
    const connection = runtime.project.config.connections[args.connectionId];
    if (!connection) throw new Error(`Connection "${args.connectionId}" was not found.`);
    const maxRows = parseAgentMaxRows(args.maxRows);
    writeAgentJson(
      io,
      await queryExecutor.execute({
        connectionId: args.connectionId,
        projectDir: runtime.project.projectDir,
        connection,
        sql: await readFile(args.sqlFile, 'utf-8'),
        maxRows,
      }),
    );
    return 0;
  } catch (error) {
    if (args.command === 'sl-list' && args.query && isMissingProjectConfigError(error)) {
      writeAgentSlSearchReadinessError(io, missingProjectSlSearchReadiness(args.projectDir, args.query));
      return 1;
    }
    writeAgentJsonError(io, error instanceof Error ? error.message : String(error));
    return 1;
  }
}
