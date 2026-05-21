import { KtxIngestEmbeddingPortAdapter } from './context/index.js';
import { createDefaultKtxMcpServer, createLocalProjectMcpContextPorts } from './context/mcp/index.js';
import { createLocalProjectMemoryIngest } from './context/memory/index.js';
import type { KtxLocalProject } from './context/project/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KtxCliIo } from './cli-runtime.js';
import { resolveProjectEmbeddingProvider } from './embedding-resolution.js';
import { createKtxCliIngestQueryExecutor } from './ingest-query-executor.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { createManagedPythonSemanticLayerComputePort } from './managed-python-command.js';
import { createManagedDaemonSqlAnalysisPort } from './managed-python-http.js';

function noopMcpIo(): KtxCliIo {
  return {
    stdout: { write() {} },
    stderr: { write() {} },
  };
}

export async function createKtxMcpServerFactory(input: {
  project: KtxLocalProject;
  projectDir: string;
  cliVersion: string;
  io?: KtxCliIo;
}): Promise<() => McpServer> {
  const io = input.io ?? noopMcpIo();
  const queryExecutor = createKtxCliIngestQueryExecutor(input.project);
  const semanticLayerCompute = await createManagedPythonSemanticLayerComputePort({
    cliVersion: input.cliVersion,
    installPolicy: 'auto',
    io,
  });
  const sqlAnalysis = createManagedDaemonSqlAnalysisPort({
    cliVersion: input.cliVersion,
    projectDir: input.projectDir,
    installPolicy: 'auto',
    io,
  });
  const resolution = await resolveProjectEmbeddingProvider(input.project, {
    mode: 'use-if-running',
    cliVersion: input.cliVersion,
    io,
  });
  const embeddingService =
    resolution.kind === 'configured' || resolution.kind === 'managed-running' || resolution.kind === 'managed-started'
      ? new KtxIngestEmbeddingPortAdapter(resolution.provider)
      : null;
  const contextTools = createLocalProjectMcpContextPorts(input.project, {
    semanticLayerCompute,
    queryExecutor,
    sqlAnalysis,
    embeddingService,
    localScan: {
      createConnector: async (connectionId) => createKtxCliScanConnector(input.project, connectionId),
    },
  });

  let memoryIngest: ReturnType<typeof createLocalProjectMemoryIngest> | undefined;
  try {
    memoryIngest = createLocalProjectMemoryIngest(input.project, { semanticLayerCompute, queryExecutor });
  } catch (error) {
    io.stderr.write(`KTX MCP memory_ingest disabled: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  return () =>
    createDefaultKtxMcpServer({
      name: 'ktx',
      version: input.cliVersion,
      userContext: { userId: 'local' },
      contextTools: {
        ...contextTools,
        ...(memoryIngest ? { memoryIngest } : {}),
      },
    });
}
