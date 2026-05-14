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
    packageInfo: { name: '@ktx/cli', version: '0.0.0-test', contextPackageName: '@ktx/context' },
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
});
