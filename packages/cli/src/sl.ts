import { readFile } from 'node:fs/promises';
import { createDefaultLocalQueryExecutor, type KtxSqlQueryExecutorPort } from '@ktx/context/connections';
import {
  createLocalKtxEmbeddingProviderFromConfig,
  KtxIngestEmbeddingPortAdapter,
  type KtxEmbeddingPort,
} from '@ktx/context';
import type { KtxSemanticLayerComputePort } from '@ktx/context/daemon';
import { loadKtxProject, type KtxLocalProject } from '@ktx/context/project';
import {
  compileLocalSlQuery,
  listLocalSlSources,
  readLocalSlSource,
  searchLocalSlSources,
  validateLocalSlSource,
  type LocalSlSourceSearchResult,
  type LocalSlSourceSummary,
  type SemanticLayerQueryInput,
} from '@ktx/context/sl';
import {
  createManagedPythonSemanticLayerComputePort,
  type KtxManagedPythonInstallPolicy,
} from './managed-python-command.js';
import { profileMark } from './startup-profile.js';

profileMark('module:sl');

type SlQueryFormat = 'json' | 'sql';

export type KtxSlArgs =
  | { command: 'list'; projectDir: string; connectionId?: string; output?: string; json?: boolean }
  | {
      command: 'search';
      projectDir: string;
      connectionId?: string;
      query: string;
      limit?: number;
      output?: string;
      json?: boolean;
    }
  | { command: 'validate'; projectDir: string; connectionId: string; sourceName: string }
  | {
      command: 'query';
      projectDir: string;
      connectionId?: string;
      query?: SemanticLayerQueryInput;
      queryFile?: string;
      format: SlQueryFormat;
      execute: boolean;
      maxRows?: number;
      cliVersion: string;
      runtimeInstallPolicy: KtxManagedPythonInstallPolicy;
    };

interface KtxSlIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

interface KtxSlDeps {
  loadProject?: typeof loadKtxProject;
  embeddingService?: KtxEmbeddingPort | null;
  createEmbeddingProvider?: typeof createLocalKtxEmbeddingProviderFromConfig;
  createSemanticLayerCompute?: () => KtxSemanticLayerComputePort;
  createManagedSemanticLayerCompute?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxSlIo;
  }) => Promise<KtxSemanticLayerComputePort>;
  createQueryExecutor?: () => KtxSqlQueryExecutorPort;
}

function slSearchEmbeddingService(project: KtxLocalProject, deps: KtxSlDeps): KtxEmbeddingPort | null {
  if ('embeddingService' in deps) {
    return deps.embeddingService ?? null;
  }
  const provider = (deps.createEmbeddingProvider ?? createLocalKtxEmbeddingProviderFromConfig)(
    project.config.ingest.embeddings,
  );
  return provider ? new KtxIngestEmbeddingPortAdapter(provider) : null;
}

async function printSlSources(input: {
  rows: ReadonlyArray<LocalSlSourceSummary | LocalSlSourceSearchResult>;
  command: 'sl list' | 'sl search';
  output?: string;
  json?: boolean;
  io: KtxSlIo;
  emptyMessage: string;
}): Promise<void> {
  const { resolveOutputMode } = await import('./io/mode.js');
  const { printList } = await import('./io/print-list.js');
  const mode = resolveOutputMode({ explicit: input.output, json: input.json, io: input.io });
  printList({
    rows: input.rows,
    columns: [
      { key: 'connectionId', label: 'CONNECTION', plain: '' },
      { key: 'name', label: 'NAME', plain: '' },
      { key: 'columnCount', label: 'COLS', plain: 'columns=', dim: true },
      { key: 'measureCount', label: 'MEASURES', plain: 'measures=', dim: true },
      { key: 'joinCount', label: 'JOINS', plain: 'joins=', dim: true },
      { key: 'description', label: 'DESCRIPTION', plain: false, optional: true, dim: true },
    ],
    groupBy: 'connectionId',
    emptyMessage: input.emptyMessage,
    command: input.command,
    mode,
    io: input.io,
  });
}

async function readSlQueryFile(path: string): Promise<SemanticLayerQueryInput> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as SemanticLayerQueryInput;
}

export async function runKtxSl(args: KtxSlArgs, io: KtxSlIo = process, deps: KtxSlDeps = {}): Promise<number> {
  try {
    const project = await (deps.loadProject ?? loadKtxProject)({ projectDir: args.projectDir });
    if (args.command === 'list') {
      const sources = await listLocalSlSources(project, { connectionId: args.connectionId });
      await printSlSources({
        rows: sources,
        emptyMessage: `No semantic-layer sources found in ${project.projectDir}`,
        command: 'sl list',
        output: args.output,
        json: args.json,
        io,
      });
      return 0;
    }
    if (args.command === 'search') {
      const sources = await searchLocalSlSources(project, {
        connectionId: args.connectionId,
        query: args.query,
        embeddingService: slSearchEmbeddingService(project, deps),
        limit: args.limit,
      });
      await printSlSources({
        rows: sources,
        emptyMessage: `No semantic-layer sources matched "${args.query}" in ${project.projectDir}`,
        command: 'sl search',
        output: args.output,
        json: args.json,
        io,
      });
      return 0;
    }
    if (args.command === 'validate') {
      const source = await readLocalSlSource(project, {
        connectionId: args.connectionId,
        sourceName: args.sourceName,
      });
      if (!source) {
        throw new Error(`Semantic-layer source "${args.connectionId}/${args.sourceName}" was not found`);
      }
      const result = await validateLocalSlSource(source.yaml, { project, connectionId: args.connectionId });
      if (!result.valid) {
        for (const error of result.errors) {
          io.stderr.write(`${error}\n`);
        }
        return 1;
      }
      io.stdout.write(`Valid semantic-layer source: ${args.connectionId}/${args.sourceName}\n`);
      return 0;
    }
    if (args.command === 'query') {
      const query = args.query ?? (args.queryFile ? await readSlQueryFile(args.queryFile) : undefined);
      if (!query) {
        throw new Error('sl query requires query input from --query-file or at least one --measure');
      }
      const compute = deps.createSemanticLayerCompute
        ? deps.createSemanticLayerCompute()
        : await (deps.createManagedSemanticLayerCompute ?? createManagedPythonSemanticLayerComputePort)({
            cliVersion: args.cliVersion,
            installPolicy: args.runtimeInstallPolicy,
            io,
          });
      const queryExecutor = args.execute ? (deps.createQueryExecutor ?? createDefaultLocalQueryExecutor)() : undefined;
      const result = await compileLocalSlQuery(project as KtxLocalProject, {
        connectionId: args.connectionId,
        query,
        compute,
        execute: args.execute,
        maxRows: args.maxRows,
        queryExecutor,
      });
      if (args.format === 'sql') {
        io.stdout.write(`${result.sql}\n`);
        return 0;
      }
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const _exhaustive: never = args;
    throw new Error(`Unsupported sl command: ${JSON.stringify(_exhaustive)}`);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
