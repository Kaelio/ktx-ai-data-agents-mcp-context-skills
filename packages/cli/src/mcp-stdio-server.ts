import type { Readable, Writable } from 'node:stream';
import { loadKtxProject } from '@ktx/context/project';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { KtxCliIo } from './cli-runtime.js';
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
    stderr: options.io?.stderr ?? { write() {} },
  };
  const createMcpServer =
    options.createMcpServer ??
    (await createKtxMcpServerFactory({
      project: project!,
      projectDir: options.projectDir,
      cliVersion: options.cliVersion ?? '0.0.0-private',
      io: protocolIo,
    }));
  const transport = new StdioServerTransport(options.stdin, options.stdout);

  await new Promise<void>((resolve, reject) => {
    transport.onclose = resolve;
    transport.onerror = (error) => {
      options.io?.stderr.write(`KTX MCP stdio transport error: ${error.message}\n`);
      reject(error);
    };
    createMcpServer().connect(transport).catch(reject);
  });
}
