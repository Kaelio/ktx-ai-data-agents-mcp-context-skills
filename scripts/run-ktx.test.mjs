import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkspaceKtx } from './run-ktx.mjs';

function freshBuildFs() {
  return {
    stat: async (path) => ({
      mtimeMs: path.endsWith('/packages/cli/dist/bin.js') ? 2000 : 1000,
      isDirectory: () => path.endsWith('/src') || path.endsWith('/packages'),
    }),
    readdir: async (path) => {
      if (path.endsWith('/packages')) {
        return [{ name: 'cli', isDirectory: () => true }];
      }
      if (path.endsWith('/src')) {
        return [{ name: 'bin.ts', isDirectory: () => false }];
      }
      return [];
    },
  };
}

test('runWorkspaceKtx runs the built CLI when it already exists', async () => {
  const calls = [];
  const logs = [];
  const fs = freshBuildFs();

  const exitCode = await runWorkspaceKtx(['--version'], {
    rootDir: '/workspace/ktx',
    access: async () => undefined,
    stat: fs.stat,
    readdir: fs.readdir,
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: '@ktx/cli 0.0.0-private\n', stderr: '' };
    },
    stdout: { write: (chunk) => logs.push(['stdout', chunk]) },
    stderr: { write: (chunk) => logs.push(['stderr', chunk]) },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      command: process.execPath,
      args: ['/workspace/ktx/packages/cli/dist/bin.js', '--version'],
      cwd: '/workspace/ktx',
    },
  ]);
  assert.deepEqual(logs, [['stdout', '@ktx/cli 0.0.0-private\n']]);
});

test('runWorkspaceKtx forwards a caller-provided environment to buffered commands', async () => {
  const calls = [];
  const fs = freshBuildFs();

  const exitCode = await runWorkspaceKtx(['--version'], {
    rootDir: '/workspace/ktx',
    access: async () => undefined,
    stat: fs.stat,
    readdir: fs.readdir,
    env: { PATH: '/bin', GIT_CEILING_DIRECTORIES: '/workspace/ktx/examples' },
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env });
      return { stdout: '@ktx/cli 0.0.0-private\n', stderr: '' };
    },
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      command: process.execPath,
      args: ['/workspace/ktx/packages/cli/dist/bin.js', '--version'],
      cwd: '/workspace/ktx',
      env: { PATH: '/bin', GIT_CEILING_DIRECTORIES: '/workspace/ktx/examples' },
    },
  ]);
});

test('runWorkspaceKtx drops a leading npm argument separator', async () => {
  const calls = [];
  const fs = freshBuildFs();

  const exitCode = await runWorkspaceKtx(['--', 'connection', 'test', 'warehouse', '--help'], {
    rootDir: '/workspace/ktx',
    access: async () => undefined,
    stat: fs.stat,
    readdir: fs.readdir,
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: 'Usage: ktx connection test\n', stderr: '' };
    },
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      command: process.execPath,
      args: ['/workspace/ktx/packages/cli/dist/bin.js', 'connection', 'test', 'warehouse', '--help'],
      cwd: '/workspace/ktx',
    },
  ]);
});

test('runWorkspaceKtx builds the workspace CLI before running it when dist is missing', async () => {
  const calls = [];
  const logs = [];
  let binExists = false;

  const exitCode = await runWorkspaceKtx(['setup', 'demo', '--mode', 'replay', '--no-input', '--viz'], {
    rootDir: '/workspace/ktx',
    access: async () => {
      if (!binExists) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === 'pnpm') {
        binExists = true;
        return { stdout: 'build ok\n', stderr: '' };
      }
      return { stdout: 'Replay complete\n', stderr: '' };
    },
    stdout: { write: (chunk) => logs.push(['stdout', chunk]) },
    stderr: { write: (chunk) => logs.push(['stderr', chunk]) },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [
      ['pnpm', ['run', 'build']],
      [
        process.execPath,
        ['/workspace/ktx/packages/cli/dist/bin.js', 'setup', 'demo', '--mode', 'replay', '--no-input', '--viz'],
      ],
    ],
  );
  assert.deepEqual(logs, [
    ['stderr', 'KTX CLI build output is missing. Building it now with `pnpm run build`...\n'],
    ['stdout', 'build ok\n'],
    ['stdout', 'Replay complete\n'],
  ]);
});

test('runWorkspaceKtx rebuilds before running when workspace sources are newer than dist', async () => {
  const calls = [];
  const logs = [];
  let sourceMtimeMs = 3000;

  const exitCode = await runWorkspaceKtx(['status', '--json', '--no-input'], {
    rootDir: '/workspace/ktx',
    access: async () => undefined,
    stat: async (path) => ({
      mtimeMs: path.endsWith('/packages/cli/dist/bin.js') ? 2000 : sourceMtimeMs,
      isDirectory: () => path.endsWith('/src') || path.endsWith('/packages'),
    }),
    readdir: async (path) => {
      if (path.endsWith('/packages')) {
        return [{ name: 'context', isDirectory: () => true }];
      }
      if (path.endsWith('/src')) {
        return [{ name: 'scan.ts', isDirectory: () => false }];
      }
      return [];
    },
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === 'pnpm') {
        sourceMtimeMs = 1000;
        return { stdout: 'build ok\n', stderr: '' };
      }
      return { stdout: '{"status":"ready"}\n', stderr: '' };
    },
    stdout: { write: (chunk) => logs.push(['stdout', chunk]) },
    stderr: { write: (chunk) => logs.push(['stderr', chunk]) },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [
      ['pnpm', ['run', 'build']],
      [process.execPath, ['/workspace/ktx/packages/cli/dist/bin.js', 'status', '--json', '--no-input']],
    ],
  );
  assert.deepEqual(logs, [
    ['stderr', 'KTX CLI build output is stale. Rebuilding it now with `pnpm run build`...\n'],
    ['stdout', 'build ok\n'],
    ['stdout', '{"status":"ready"}\n'],
  ]);
});
