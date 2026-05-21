import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerKtxContextTools } from './context-tools.js';
import type { KtxMcpServerDeps, KtxMcpServerLike } from './types.js';

/** @internal */
export function createKtxMcpServer(deps: KtxMcpServerDeps): KtxMcpServerDeps['server'] {
  if (deps.contextTools) {
    registerKtxContextTools({
      server: deps.server,
      ports: deps.contextTools,
      userContext: deps.userContext,
    });
  }

  return deps.server;
}

export function createDefaultKtxMcpServer(
  deps: Omit<KtxMcpServerDeps, 'server'> & { name?: string; version?: string },
): McpServer {
  const server = new McpServer({
    name: deps.name ?? 'ktx',
    version: deps.version ?? '0.0.0-private',
  });
  createKtxMcpServer({
    server: server as KtxMcpServerLike,
    userContext: deps.userContext,
    contextTools: deps.contextTools,
  });
  return server;
}
