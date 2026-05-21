import { Command } from '@commander-js/extra-typings';
import { describe, expect, it, vi } from 'vitest';
import type { KtxCliCommandContext } from '../cli-program.js';
import { registerSqlCommands } from './sql-commands.js';

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

describe('registerSqlCommands', () => {
  it('routes positional SQL through the sql runner', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const sql = vi.fn(async () => 0);
    const context = makeContext({ deps: { sql } });
    registerSqlCommands(program, context);

    await expect(
      program.parseAsync(
        ['--project-dir', '/tmp/ktx-sql', 'sql', '--connection', 'warehouse', 'select', '1'],
        { from: 'user' },
      ),
    ).resolves.toBe(program);

    expect(sql).toHaveBeenCalledWith(
      {
        command: 'execute',
        projectDir: '/tmp/ktx-sql',
        connectionId: 'warehouse',
        sql: 'select 1',
        maxRows: 1000,
        output: undefined,
        json: false,
        cliVersion: '0.0.0-test',
      },
      context.io,
    );
  });

  it('supports the short connection flag', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const sql = vi.fn(async () => 0);
    const context = makeContext({ deps: { sql } });
    registerSqlCommands(program, context);

    await expect(
      program.parseAsync(['--project-dir', '/tmp/ktx-sql', 'sql', '-c', 'warehouse', 'select 1'], {
        from: 'user',
      }),
    ).resolves.toBe(program);

    expect(sql).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'warehouse', sql: 'select 1' }), context.io);
  });

  it('rejects missing SQL before invoking the runner', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const sql = vi.fn(async () => 0);
    registerSqlCommands(program, makeContext({ deps: { sql } }));

    await expect(
      program.parseAsync(['--project-dir', '/tmp/ktx-sql', 'sql', '--connection', 'warehouse'], {
        from: 'user',
      }),
    ).rejects.toThrow('missing required argument');

    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects maxRows above the CLI cap', async () => {
    const program = new Command().exitOverride().option('--project-dir <path>');
    const sql = vi.fn(async () => 0);
    registerSqlCommands(program, makeContext({ deps: { sql } }));

    await expect(
      program.parseAsync(
        ['--project-dir', '/tmp/ktx-sql', 'sql', '--connection', 'warehouse', '--max-rows', '10001', 'select 1'],
        { from: 'user' },
      ),
    ).rejects.toThrow('must be an integer between 1 and 10000');

    expect(sql).not.toHaveBeenCalled();
  });
});
