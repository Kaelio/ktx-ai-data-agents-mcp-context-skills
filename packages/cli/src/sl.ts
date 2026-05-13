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
  writeLocalSlSource,
  type SemanticLayerQueryInput,
} from '@ktx/context/sl';
import { writeJsonResult } from './io/print-list.js';
import {
  createManagedPythonSemanticLayerComputePort,
  type KtxManagedPythonInstallPolicy,
} from './managed-python-command.js';
import { profileMark } from './startup-profile.js';

profileMark('module:sl');

type SlQueryFormat = 'json' | 'sql';

export type KtxSlArgs =
  | { command: 'list'; projectDir: string; connectionId?: string; query?: string; output?: string; json?: boolean }
  | { command: 'read'; projectDir: string; connectionId: string; sourceName: string; json?: boolean }
  | { command: 'validate'; projectDir: string; connectionId: string; sourceName: string }
  | { command: 'write'; projectDir: string; connectionId: string; sourceName: string; yaml: string }
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
      const sources = args.query
        ? await searchLocalSlSources(project, {
            connectionId: args.connectionId,
            query: args.query,
            embeddingService: slSearchEmbeddingService(project, deps),
          })
        : await listLocalSlSources(project, { connectionId: args.connectionId });
      const { resolveOutputMode } = await import('./io/mode.js');
      const { printList } = await import('./io/print-list.js');
      const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });
      printList({
        rows: sources,
        columns: [
          { key: 'connectionId', label: 'CONNECTION', plain: '' },
          { key: 'name', label: 'NAME', plain: '' },
          { key: 'columnCount', label: 'COLS', plain: 'columns=', dim: true },
          { key: 'measureCount', label: 'MEASURES', plain: 'measures=', dim: true },
          { key: 'joinCount', label: 'JOINS', plain: 'joins=', dim: true },
          { key: 'description', label: 'DESCRIPTION', plain: false, optional: true, dim: true },
        ],
        groupBy: 'connectionId',
        emptyMessage: `No semantic-layer sources found in ${project.projectDir}`,
        command: 'sl list',
        mode,
        io,
      });
      return 0;
    }
    if (args.command === 'read') {
      const source = await readLocalSlSource(project, {
        connectionId: args.connectionId,
        sourceName: args.sourceName,
      });
      if (!source) {
        throw new Error(`Semantic-layer source "${args.connectionId}/${args.sourceName}" was not found`);
      }
      if (args.json) {
        writeJsonResult(io, {
          kind: 'sl.source',
          data: source,
          meta: { command: 'sl read' },
        });
        return 0;
      }
      io.stdout.write(source.yaml);
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

    const write = await writeLocalSlSource(project, {
      connectionId: args.connectionId,
      sourceName: args.sourceName,
      yaml: args.yaml,
    });
    io.stdout.write(`Wrote ${write.path}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
