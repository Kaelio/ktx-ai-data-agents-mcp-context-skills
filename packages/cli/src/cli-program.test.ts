import type { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { buildKtxProgram } from './cli-program.js';
import type { KtxCliIo, KtxCliPackageInfo } from './cli-runtime.js';

function stubIo(): KtxCliIo {
  return {
    stdout: { isTTY: false, columns: 80, write: () => {} },
    stderr: { write: () => {} },
  };
}

function stubPackageInfo(): KtxCliPackageInfo {
  return {
    name: '@ktx/cli',
    version: '0.0.0-test',
    packageVersion: '0.0.0-private',
    runtimeVersion: '0.0.0-test',
    contextPackageName: '@ktx/context',
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
