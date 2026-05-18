import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSetupDev } from './setup-dev.mjs';

test('runSetupDev runs phased setup without global linking', async () => {
  const calls = [];
  const logs = [];

  const result = await runSetupDev({
    rootDir: '/workspace/ktx',
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: `${command} ${args.join(' ')}`, stderr: '' };
    },
    log: (line) => logs.push(line),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [
      ['pnpm', ['install', '--frozen-lockfile']],
      ['pnpm', ['run', 'native:rebuild']],
      ['pnpm', ['run', 'build']],
      ['pnpm', ['run', 'artifacts:build-runtime']],
      [process.execPath, ['packages/cli/dist/bin.js', 'status', '--no-input']],
    ],
  );
  assert.equal(calls.some((call) => call.args.includes('link')), false);
  assert.equal(logs.some((line) => line.includes('PASS doctor setup')), true);
});

test('runSetupDev stops at the failed phase and prints a retry command', async () => {
  const calls = [];
  const logs = [];

  const result = await runSetupDev({
    rootDir: '/workspace/ktx',
    execFile: async (command, args) => {
      calls.push({ command, args });
      if (args.includes('native:rebuild')) {
        const error = new Error('native rebuild failed');
        error.stdout = '';
        error.stderr = 'better-sqlite3 rebuild failed';
        throw error;
      }
      return { stdout: '', stderr: '' };
    },
    log: (line) => logs.push(line),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedPhase.name, 'native SQLite rebuild');
  assert.equal(result.failedPhase.retry, 'pnpm run native:rebuild');
  assert.equal(calls.length, 2);
  assert.equal(logs.some((line) => line.includes('Retry: pnpm run native:rebuild')), true);
});
