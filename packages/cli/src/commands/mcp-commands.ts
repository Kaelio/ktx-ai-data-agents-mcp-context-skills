import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Command } from '@commander-js/extra-typings';
import type { KtxCliCommandContext } from '../cli-program.js';
import {
  collectOption,
  parsePositiveIntegerOption,
  resolveCommandProjectDir,
} from '../cli-program.js';
import {
  mcpDaemonLayout,
  readKtxMcpDaemonStatus,
  startKtxMcpDaemon,
  stopKtxMcpDaemon,
} from '../managed-mcp-daemon.js';
import { buildMcpSecurityConfig, runKtxMcpHttpServer } from '../mcp-http-server.js';
import { runKtxMcpStdioServer } from '../mcp-stdio-server.js';

function tokenFromOption(value: string | undefined): string | undefined {
  return value ?? process.env.KTX_MCP_TOKEN;
}

function binPath(): string {
  return fileURLToPath(new URL('../bin.js', import.meta.url));
}

function formatMcpStartResultMessage(input: { status: 'started' | 'already-running'; url: string }): string {
  return [
    input.status === 'started' ? `KTX MCP daemon started: ${input.url}` : `KTX MCP daemon already running: ${input.url}`,
    '',
    'KTX is ready for configured agents.',
    'Open your agent for this KTX project and ask a data question, for example:',
    '  "Use KTX to show me the available tables and metrics."',
    '',
  ].join('\n');
}

export function registerMcpCommands(program: Command, context: KtxCliCommandContext): void {
  const mcp = program.command('mcp').description('Run the KTX MCP HTTP server');

  mcp
    .command('stdio')
    .description('Run the KTX MCP server over stdio')
    .action(async (_options, command) => {
      await (context.deps.mcp?.runStdioServer ?? runKtxMcpStdioServer)({
        projectDir: resolveCommandProjectDir(command),
        cliVersion: context.packageInfo.version,
        io: context.io,
      });
    });

  mcp
    .command('start')
    .description('Start the KTX MCP HTTP server')
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--port <n>', 'Port to bind', parsePositiveIntegerOption, 7878)
    .option('--token <token>', 'Bearer token required for non-loopback binding')
    .option('--foreground', 'Run in the foreground', false)
    .option('--allowed-host <host>', 'Additional allowed Host header', collectOption, [])
    .option('--allowed-origin <origin>', 'Allowed browser Origin header', collectOption, [])
    .action(async (options, command) => {
      const projectDir = resolveCommandProjectDir(command);
      const token = tokenFromOption(options.token);
      buildMcpSecurityConfig({
        host: options.host,
        port: options.port,
        token,
        allowedHosts: options.allowedHost,
        allowedOrigins: options.allowedOrigin,
      });
      if (options.foreground) {
        await (context.deps.mcp?.runServer ?? runKtxMcpHttpServer)({
          projectDir,
          cliVersion: context.packageInfo.version,
          host: options.host,
          port: options.port,
          token,
          allowedHosts: options.allowedHost,
          allowedOrigins: options.allowedOrigin,
          io: context.io,
        });
        context.io.stdout.write(`KTX MCP server listening at http://${options.host}:${options.port}/mcp\n`);
        return;
      }
      const result = await (context.deps.mcp?.startDaemon ?? startKtxMcpDaemon)({
        projectDir,
        cliVersion: context.packageInfo.version,
        host: options.host,
        port: options.port,
        token,
        allowedHosts: options.allowedHost,
        allowedOrigins: options.allowedOrigin,
        binPath: binPath(),
      });
      context.io.stdout.write(formatMcpStartResultMessage({ status: result.status, url: result.url }));
    });

  mcp
    .command('stop')
    .description('Stop the KTX MCP daemon')
    .action(async (_options, command) => {
      const result = await (context.deps.mcp?.stopDaemon ?? stopKtxMcpDaemon)({
        projectDir: resolveCommandProjectDir(command),
      });
      context.io.stdout.write(result.status === 'stopped' ? 'KTX MCP daemon stopped.\n' : 'KTX MCP daemon is not running.\n');
    });

  mcp
    .command('status')
    .description('Show KTX MCP daemon status')
    .action(async (_options, command) => {
      const status = await (context.deps.mcp?.readStatus ?? readKtxMcpDaemonStatus)({
        projectDir: resolveCommandProjectDir(command),
      });
      context.io.stdout.write(`${status.detail}\n`);
      if (status.kind === 'running') {
        context.io.stdout.write(`URL: ${status.url}\n`);
        context.io.stdout.write(`PID: ${status.state.pid}\n`);
        context.io.stdout.write(`Token auth: ${status.state.tokenAuth ? 'enabled' : 'disabled'}\n`);
        context.io.stdout.write(`Project: ${status.state.projectDir}\n`);
      }
    });

  mcp
    .command('logs')
    .description('Print the KTX MCP daemon log')
    .option('--follow', 'Follow log output', false)
    .action(async (options, command) => {
      const logPath = mcpDaemonLayout(resolveCommandProjectDir(command)).logPath;
      if (options.follow) {
        const child = spawn('tail', ['-f', logPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (chunk: Buffer) => context.io.stdout.write(chunk.toString('utf8')));
        child.stderr?.on('data', (chunk: Buffer) => context.io.stderr.write(chunk.toString('utf8')));
        await new Promise((resolve) => child.on('close', resolve));
        return;
      }
      context.io.stdout.write(await readFile(logPath, 'utf8'));
    });

  mcp
    .command('serve-internal', { hidden: true })
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .requiredOption('--port <n>', 'Port to bind', parsePositiveIntegerOption)
    .option('--allowed-host <host>', 'Additional allowed Host header', collectOption, [])
    .option('--allowed-origin <origin>', 'Allowed browser Origin header', collectOption, [])
    .action(async (options, command) => {
      await (context.deps.mcp?.runServer ?? runKtxMcpHttpServer)({
        projectDir: resolveCommandProjectDir(command),
        cliVersion: context.packageInfo.version,
        host: options.host,
        port: options.port,
        token: process.env.KTX_MCP_TOKEN,
        allowedHosts: options.allowedHost,
        allowedOrigins: options.allowedOrigin,
        io: context.io,
      });
    });
}
