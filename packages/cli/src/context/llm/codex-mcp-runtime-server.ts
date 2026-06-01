import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KtxMcpServerLike } from '../mcp/types.js';
import { runKtxMcpHttpServer, type KtxMcpHttpServerHandle } from '../../mcp-http-server.js';
import type { KtxRuntimeToolSet } from './runtime-port.js';
import { normalizeKtxRuntimeToolOutput } from './runtime-tools.js';

export interface CreateCodexRuntimeMcpServerInput {
  server?: KtxMcpServerLike;
  toolSet: KtxRuntimeToolSet;
}

export interface CodexRuntimeMcpServerHandle {
  url: string;
  bearerTokenEnvVar: 'KTX_CODEX_RUNTIME_MCP_TOKEN';
  bearerToken: string;
  close(): Promise<void>;
}

type RunServer = typeof runKtxMcpHttpServer;

export interface StartCodexRuntimeMcpServerInput {
  projectDir: string;
  toolSet: KtxRuntimeToolSet;
  runServer?: RunServer;
}

export function createCodexRuntimeMcpServer(input: CreateCodexRuntimeMcpServerInput): KtxMcpServerLike {
  const server =
    input.server ??
    (new McpServer({
      name: 'ktx-runtime',
      version: '0.0.0',
    }) as KtxMcpServerLike);

  for (const descriptor of Object.values(input.toolSet)) {
    server.registerTool(
      descriptor.name,
      {
        description: descriptor.description,
        inputSchema: descriptor.inputSchema.shape,
      },
      async (toolInput) => {
        const normalized = normalizeKtxRuntimeToolOutput(await descriptor.execute(toolInput));
        return {
          content: [{ type: 'text', text: normalized.markdown }],
          ...(normalized.structured !== undefined && normalized.structured !== null && typeof normalized.structured === 'object'
            ? { structuredContent: normalized.structured as object }
            : {}),
        };
      },
    );
  }

  return server;
}

function serverPort(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : fallback;
}

export async function startCodexRuntimeMcpServer(
  input: StartCodexRuntimeMcpServerInput,
): Promise<CodexRuntimeMcpServerHandle> {
  const bearerToken = randomBytes(32).toString('hex');
  const runServer = input.runServer ?? runKtxMcpHttpServer;
  const handle = (await runServer({
    projectDir: input.projectDir,
    host: '127.0.0.1',
    port: 0,
    token: bearerToken,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: [],
    createMcpServer: () => createCodexRuntimeMcpServer({ toolSet: input.toolSet }) as McpServer,
  })) as KtxMcpHttpServerHandle;
  const port = serverPort(handle.server, 0);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    bearerTokenEnvVar: 'KTX_CODEX_RUNTIME_MCP_TOKEN',
    bearerToken,
    close: () => handle.close(),
  };
}
