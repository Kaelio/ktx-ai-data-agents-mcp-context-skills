import { createLocalKtxLlmProviderFromConfig } from '@ktx/context';
import { createDefaultLocalQueryExecutor, type KtxSqlQueryExecutorPort } from '@ktx/context/connections';
import {
  createHttpSemanticLayerComputePort,
  type KtxSemanticLayerComputePort,
} from '@ktx/context/daemon';
import { createDefaultLocalIngestAdapters, type LocalIngestMcpOptions } from '@ktx/context/ingest';
import {
  createDefaultKtxMcpServer,
  createLocalProjectMcpContextPorts,
  type KtxMcpContextPorts,
} from '@ktx/context/mcp';
import { createLocalProjectMemoryCapture, type MemoryCaptureService } from '@ktx/context/memory';
import { type KtxLocalProject, loadKtxProject } from '@ktx/context/project';
import type { LocalScanMcpOptions } from '@ktx/context/scan';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { KtxCliIo } from './cli-runtime.js';
import { createKtxCliLocalIngestAdapters } from './local-adapters.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import {
  createManagedPythonSemanticLayerComputePort,
  type KtxManagedPythonInstallPolicy,
} from './managed-python-command.js';
import { profileMark } from './startup-profile.js';

profileMark('module:serve');

export interface KtxServeArgs {
  mcp: 'stdio';
  projectDir: string;
  userId: string;
  semanticCompute: boolean;
  semanticComputeUrl?: string;
  databaseIntrospectionUrl?: string;
  executeQueries: boolean;
  memoryCapture: boolean;
  memoryModel?: string;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
}

interface KtxServeIo {
  stderr: { write(chunk: string): void };
}

interface LocalProjectContextToolOptions {
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  localIngest?: LocalIngestMcpOptions;
  localScan?: LocalScanMcpOptions;
}

interface KtxServeDeps {
  loadProject?: typeof loadKtxProject;
  createContextTools?: (project: KtxLocalProject, options?: LocalProjectContextToolOptions) => KtxMcpContextPorts;
  createSemanticLayerCompute?: () => KtxSemanticLayerComputePort;
  createManagedSemanticLayerCompute?: typeof createManagedPythonSemanticLayerComputePort;
  managedRuntimeIo?: KtxCliIo;
  createHttpSemanticLayerCompute?: (baseUrl: string) => KtxSemanticLayerComputePort;
  createIngestAdapters?: typeof createDefaultLocalIngestAdapters;
  createQueryExecutor?: () => KtxSqlQueryExecutorPort;
  createMemoryCapture?: typeof createLocalProjectMemoryCapture;
  createServer?: typeof createDefaultKtxMcpServer;
  createTransport?: () => StdioServerTransport;
  stderr?: KtxServeIo['stderr'];
}

function requiredManagedRuntimeCliVersion(args: KtxServeArgs): string {
  if (!args.cliVersion) {
    throw new Error('Managed Python semantic compute requires a CLI version.');
  }
  return args.cliVersion;
}

async function createServeSemanticLayerCompute(
  args: KtxServeArgs,
  deps: KtxServeDeps,
): Promise<KtxSemanticLayerComputePort | undefined> {
  if (!args.semanticCompute) {
    return undefined;
  }
  if (args.semanticComputeUrl) {
    return (deps.createHttpSemanticLayerCompute ?? ((baseUrl) => createHttpSemanticLayerComputePort({ baseUrl })))(
      args.semanticComputeUrl,
    );
  }
  if (deps.createSemanticLayerCompute) {
    return deps.createSemanticLayerCompute();
  }
  const createManagedSemanticLayerCompute =
    deps.createManagedSemanticLayerCompute ?? createManagedPythonSemanticLayerComputePort;
  return createManagedSemanticLayerCompute({
    cliVersion: requiredManagedRuntimeCliVersion(args),
    installPolicy: args.runtimeInstallPolicy ?? 'prompt',
    io: deps.managedRuntimeIo ?? process,
  });
}

export async function runKtxServeStdio(args: KtxServeArgs, deps: KtxServeDeps = {}): Promise<number> {
  const loadProjectFn = deps.loadProject ?? loadKtxProject;
  const createContextToolsFn = deps.createContextTools ?? createLocalProjectMcpContextPorts;
  const createServerFn = deps.createServer ?? createDefaultKtxMcpServer;
  const createTransportFn = deps.createTransport ?? (() => new StdioServerTransport());
  const stderr = deps.stderr ?? process.stderr;

  const project = await loadProjectFn({ projectDir: args.projectDir });
  const semanticLayerCompute = await createServeSemanticLayerCompute(args, deps);
  const queryExecutor = args.executeQueries
    ? (deps.createQueryExecutor ?? createDefaultLocalQueryExecutor)()
    : undefined;
  const createIngestAdapters = deps.createIngestAdapters ?? createKtxCliLocalIngestAdapters;
  const localAdapters = createIngestAdapters(project, {
    databaseIntrospectionUrl: args.databaseIntrospectionUrl,
  });
  const llmProvider = args.memoryCapture
    ? (createLocalKtxLlmProviderFromConfig(project.config.llm) ?? undefined)
    : undefined;
  const memoryCapture: MemoryCaptureService | undefined = args.memoryCapture
    ? (deps.createMemoryCapture ?? createLocalProjectMemoryCapture)(project, {
        llmProvider,
        semanticLayerCompute,
      })
    : undefined;
  const localIngest: LocalIngestMcpOptions = {
    adapters: localAdapters,
    ...(semanticLayerCompute ? { semanticLayerCompute } : {}),
    ...(queryExecutor ? { queryExecutor } : {}),
  };
  const localScan: LocalScanMcpOptions = {
    adapters: localAdapters,
    databaseIntrospectionUrl: args.databaseIntrospectionUrl,
    createConnector: (connectionId) => createKtxCliScanConnector(project, connectionId),
  };
  const contextToolOptions: LocalProjectContextToolOptions = {
    localIngest,
    localScan,
    ...(semanticLayerCompute ? { semanticLayerCompute } : {}),
    ...(queryExecutor ? { queryExecutor } : {}),
  };
  const contextTools = createContextToolsFn(project, contextToolOptions);
  const server = createServerFn({
    name: 'ktx',
    version: '0.0.0-private',
    userContext: { userId: args.userId },
    contextTools,
    memoryCapture,
  });
  const transport = createTransportFn();
  await server.connect(transport);
  stderr.write(`ktx MCP server running on stdio for ${project.projectDir}\n`);
  return 0;
}
