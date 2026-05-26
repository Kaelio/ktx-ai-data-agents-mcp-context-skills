import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { buildKtxProgram, collectCommandFlagsPresent } from '../src/cli-program.js';
import type { KtxCliIo, KtxCliPackageInfo } from '../src/cli-runtime.js';

function stubIo(): KtxCliIo {
  return {
    stdout: { isTTY: false, columns: 80, write: () => {} },
    stderr: { write: () => {} },
  };
}

function stubPackageInfo(): KtxCliPackageInfo {
  return {
    name: '@kaelio/ktx',
    version: '0.0.0-test',
  };
}

describe('buildKtxProgram', () => {
  it('returns a Command named "ktx" with all registered top-level subcommands', () => {
    const program: Command = buildKtxProgram({
      io: stubIo(),
      deps: {},
      packageInfo: stubPackageInfo(),
      runInit: async () => 0,
    });

    expect(program.name()).toBe('ktx');
    const topLevel = program.commands.map((command) => command.name()).sort();
    for (const expected of ['setup', 'connection', 'ingest', 'sl', 'admin']) {
      expect(topLevel).toContain(expected);
    }
  });

  it('does not parse argv or invoke action handlers', () => {
    let wrote = '';
    const io: KtxCliIo = {
      stdout: {
        isTTY: false,
        columns: 80,
        write: (chunk) => {
          wrote += chunk;
        },
      },
      stderr: {
        write: (chunk) => {
          wrote += chunk;
        },
      },
    };

    buildKtxProgram({ io, deps: {}, packageInfo: stubPackageInfo(), runInit: async () => 0 });

    expect(wrote).toBe('');
  });
});

describe('collectCommandFlagsPresent', () => {
  it('records only CLI-sourced flags and ignores positional content that looks like a flag', async () => {
    let captured: Record<string, boolean> | undefined;
    const program = new Command()
      .name('ktx')
      .option('--project-dir <dir>', 'project directory')
      .option('--json', 'json output', false);
    program
      .command('sql')
      .argument('<sql...>')
      .requiredOption('-c, --connection <id>', 'connection id')
      .option('--max-rows <n>', 'cap rows')
      .action(function () {
        captured = collectCommandFlagsPresent(this as unknown as CommandUnknownOpts);
      });

    await program.parseAsync(
      ['--project-dir', '/tmp/p', 'sql', '-c', 'warehouse', '--', '--customer_table', 'SELECT', '1'],
      { from: 'user' },
    );

    expect(captured).toEqual({ projectDir: true, connection: true });
    expect(captured).not.toHaveProperty('customer_table');
    expect(captured).not.toHaveProperty('json');
    expect(captured).not.toHaveProperty('maxRows');
  });
});
