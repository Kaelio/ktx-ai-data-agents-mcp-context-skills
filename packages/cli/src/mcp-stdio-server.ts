import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { loadKtxProject } from './context/project/project.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getKtxCliPackageInfo, type KtxCliIo } from './cli-runtime.js';
import { createKtxMcpServerFactory } from './mcp-server-factory.js';

export interface RunKtxMcpStdioServerOptions {
  projectDir: string;
  cliVersion?: string;
  io?: KtxCliIo;
  createMcpServer?: () => McpServer;
  loadProject?: typeof loadKtxProject;
  stdin?: Readable;
  stdout?: Writable;
}

export async function runKtxMcpStdioServer(options: RunKtxMcpStdioServerOptions): Promise<void> {
  const project =
    options.createMcpServer === undefined
      ? await (options.loadProject ?? loadKtxProject)({ projectDir: options.projectDir })
      : undefined;
  const protocolIo: KtxCliIo = {
    stdout: { write() {} },
    stderr: options.io?.stderr ?? process.stderr,
  };
  const createMcpServer =
    options.createMcpServer ??
    (await createKtxMcpServerFactory({
      project: project!,
      projectDir: options.projectDir,
      cliVersion: options.cliVersion ?? getKtxCliPackageInfo().version,
      io: protocolIo,
    }));
  const stdin = options.stdin ?? process.stdin;
  const transport = new StdioServerTransport(stdin, options.stdout);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      stdin.off('end', closeTransport);
      stdin.off('close', closeTransport);
      callback();
    };
    const closeTransport = () => {
      transport.close().catch((error: unknown) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
    };
    transport.onclose = () => settle(resolve);
    transport.onerror = (error) => {
      options.io?.stderr.write(`ktx MCP stdio transport error: ${error.message}\n`);
      settle(() => reject(error));
    };
    stdin.once('end', closeTransport);
    stdin.once('close', closeTransport);
    createMcpServer().connect(transport).catch((error: unknown) => {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}
