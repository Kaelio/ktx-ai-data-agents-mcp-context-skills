import { Command } from '@commander-js/extra-typings';
import { describe, expect, it, vi } from 'vitest';
import type { KtxCliCommandContext } from '../../src/cli-program.js';
import { registerWikiCommands } from '../../src/commands/knowledge-commands.js';
import { registerSlCommands } from '../../src/commands/sl-commands.js';

function makeContext(overrides: Partial<KtxCliCommandContext> = {}): KtxCliCommandContext {
  let exitCode = 0;
  return {
    io: {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    },
    deps: {},
    packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
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

describe('wiki and sl read command routing', () => {
  it('routes wiki read through the knowledge runner', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const knowledge = vi.fn(async () => 0);
    const context = makeContext({ deps: { knowledge } });
    registerWikiCommands(program, context);

    await expect(
      program.parseAsync(['--project-dir', '/tmp/ktx-project', 'wiki', 'read', 'metrics-revenue'], {
        from: 'user',
      }),
    ).resolves.toBe(program);

    expect(knowledge).toHaveBeenCalledWith(
      {
        command: 'read',
        projectDir: '/tmp/ktx-project',
        key: 'metrics-revenue',
        userId: 'local',
      },
      context.io,
    );
  });

  it('routes wiki read with the parent --user-id option', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const knowledge = vi.fn(async () => 0);
    const context = makeContext({ deps: { knowledge } });
    registerWikiCommands(program, context);

    await expect(
      program.parseAsync(
        ['--project-dir', '/tmp/ktx-project', 'wiki', '--user-id', 'alex', 'read', 'handoff'],
        { from: 'user' },
      ),
    ).resolves.toBe(program);

    expect(knowledge).toHaveBeenCalledWith(
      {
        command: 'read',
        projectDir: '/tmp/ktx-project',
        key: 'handoff',
        userId: 'alex',
      },
      context.io,
    );
  });

  it('routes sl read through the semantic-layer runner', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const sl = vi.fn(async () => 0);
    const context = makeContext({ deps: { sl } });
    registerSlCommands(program, context);

    await expect(
      program.parseAsync(
        ['--project-dir', '/tmp/ktx-project', 'sl', '--connection-id', 'warehouse', 'read', 'orders'],
        { from: 'user' },
      ),
    ).resolves.toBe(program);

    expect(sl).toHaveBeenCalledWith(
      {
        command: 'read',
        projectDir: '/tmp/ktx-project',
        connectionId: 'warehouse',
        sourceName: 'orders',
      },
      context.io,
    );
  });

  it('routes sl read without --connection-id through the semantic-layer runner', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const sl = vi.fn(async () => 0);
    const context = makeContext({ deps: { sl } });
    registerSlCommands(program, context);

    await expect(
      program.parseAsync(['--project-dir', '/tmp/ktx-project', 'sl', 'read', 'orders'], { from: 'user' }),
    ).resolves.toBe(program);

    expect(sl).toHaveBeenCalledWith(
      {
        command: 'read',
        projectDir: '/tmp/ktx-project',
        connectionId: undefined,
        sourceName: 'orders',
      },
      context.io,
    );
  });

  it('routes sl validate without --connection-id through the semantic-layer runner', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const sl = vi.fn(async () => 0);
    const context = makeContext({ deps: { sl } });
    registerSlCommands(program, context);

    await expect(
      program.parseAsync(['--project-dir', '/tmp/ktx-project', 'sl', 'validate', 'orders'], { from: 'user' }),
    ).resolves.toBe(program);

    expect(sl).toHaveBeenCalledWith(
      {
        command: 'validate',
        projectDir: '/tmp/ktx-project',
        connectionId: undefined,
        sourceName: 'orders',
      },
      context.io,
    );
  });
});
