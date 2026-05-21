import { Command } from '@commander-js/extra-typings';
import { describe, expect, it, vi } from 'vitest';
import type { KtxCliCommandContext } from '../cli-program.js';
import { registerMcpCommands } from './mcp-commands.js';

function makeContext(overrides: Partial<KtxCliCommandContext> = {}): KtxCliCommandContext {
  let exitCode = 0;
  return {
    io: {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    },
    deps: {},
    packageInfo: { name: '@ktx/cli', version: '0.0.0-test' },
    setExitCode: (code) => {
      exitCode = code;
    },
    runInit: vi.fn(),
    writeDebug: vi.fn(),
    ...overrides,
    get exitCode() {
      return exitCode;
    },
  } as KtxCliCommandContext;
}

describe('registerMcpCommands', () => {
  it('registers the public mcp lifecycle commands', () => {
    const program = new Command().exitOverride();
    registerMcpCommands(program, makeContext());
    const mcp = program.commands.find((command) => command.name() === 'mcp');

    expect(mcp?.commands.map((command) => command.name()).sort()).toEqual([
      'logs',
      'serve-internal',
      'start',
      'status',
      'stdio',
      'stop',
    ]);
    expect(
      (mcp?.commands.find((command) => command.name() === 'serve-internal') as { _hidden?: boolean } | undefined)
        ?._hidden,
    ).toBe(true);
  });

  it('rejects non-loopback start without token before spawning', async () => {
    const program = new Command().exitOverride();
    const startDaemon = vi.fn();
    const context = makeContext({ deps: { mcp: { startDaemon } } });
    registerMcpCommands(program, context);

    await expect(program.parseAsync(['mcp', 'start', '--host', '0.0.0.0'], { from: 'user' })).rejects.toThrow(
      'Binding KTX MCP to 0.0.0.0 requires --token or KTX_MCP_TOKEN',
    );
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it('prints "already running" when startDaemon reports already-running', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const startDaemon = vi.fn().mockResolvedValue({
      status: 'already-running',
      url: 'http://127.0.0.1:7878/mcp',
      state: {
        schemaVersion: 1,
        pid: 4242,
        host: '127.0.0.1',
        port: 7878,
        tokenAuth: false,
        projectDir: '/tmp/ktx-already',
        startedAt: '2026-05-14T00:00:00.000Z',
        logPath: '/tmp/ktx-already/.ktx/logs/mcp.log',
      },
    });
    const context = makeContext({ deps: { mcp: { startDaemon } } });
    registerMcpCommands(program, context);

    await program.parseAsync(['--project-dir', '/tmp/ktx-already', 'mcp', 'start'], { from: 'user' });

    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(context.io.stdout.write).toHaveBeenCalledWith(
      [
        'KTX MCP daemon already running: http://127.0.0.1:7878/mcp',
        '',
        'KTX is ready for configured agents.',
        'Open your agent for this KTX project and ask a data question, for example:',
        '  "Use KTX to show me the available tables and metrics."',
        '',
      ].join('\n'),
    );
  });

  it('prints a friendly next step after starting the daemon', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const startDaemon = vi.fn().mockResolvedValue({
      status: 'started',
      url: 'http://127.0.0.1:7878/mcp',
      state: {
        schemaVersion: 1,
        pid: 4242,
        host: '127.0.0.1',
        port: 7878,
        tokenAuth: false,
        projectDir: '/tmp/ktx-started',
        startedAt: '2026-05-14T00:00:00.000Z',
        logPath: '/tmp/ktx-started/.ktx/logs/mcp.log',
      },
    });
    const context = makeContext({ deps: { mcp: { startDaemon } } });
    registerMcpCommands(program, context);

    await program.parseAsync(['--project-dir', '/tmp/ktx-started', 'mcp', 'start'], { from: 'user' });

    expect(context.io.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('KTX MCP daemon started: http://127.0.0.1:7878/mcp\n\nKTX is ready for configured agents.'),
    );
    expect(context.io.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('"Use KTX to show me the available tables and metrics."'),
    );
  });

  it('runs the stdio server with the resolved project directory', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const runStdioServer = vi.fn().mockResolvedValue(undefined);
    const context = makeContext({ deps: { mcp: { runStdioServer } } });
    registerMcpCommands(program, context);

    await expect(program.parseAsync(['--project-dir', '/tmp/ktx6', 'mcp', 'stdio'], { from: 'user' })).resolves.toBe(
      program,
    );

    expect(runStdioServer).toHaveBeenCalledWith({
      projectDir: '/tmp/ktx6',
      cliVersion: '0.0.0-test',
      io: context.io,
    });
  });
});
