import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runDependencyUpgrade } from './upgrade-dependencies.mjs';

test('runDependencyUpgrade updates TypeScript and Python manifests before regenerating lockfiles', async () => {
  const calls = [];
  const logs = [];

  const result = await runDependencyUpgrade({
    rootDir: '/workspace/ktx',
    readFile: async (path) => {
      assert.equal(path, '/workspace/ktx/pnpm-workspace.yaml');
      return 'packages: []\nminimumReleaseAge: 10080\n';
    },
    execFile: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: '', stderr: '' };
    },
    log: (line) => logs.push(line),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [
      ['pnpm', ['dlx', 'npm-check-updates', '-u', '--deep', '--cooldown', '10080m']],
      ['uvx', ['dependency-check-updates', '--manifest', 'pyproject.toml', '-u']],
      ['uvx', ['dependency-check-updates', '--manifest', 'python/ktx-sl/pyproject.toml', '-u']],
      ['uvx', ['dependency-check-updates', '--manifest', 'python/ktx-daemon/pyproject.toml', '-u']],
      ['pnpm', ['install']],
      ['uv', ['lock', '--upgrade']],
    ],
  );
  assert.equal(calls.every((call) => call.cwd === '/workspace/ktx'), true);
  assert.equal(logs.some((line) => line.includes('PASS Python dependency constraints')), true);
});

test('runDependencyUpgrade stops at the failed phase and prints a retry command', async () => {
  const calls = [];
  const logs = [];

  const result = await runDependencyUpgrade({
    rootDir: '/workspace/ktx',
    readFile: async () => 'packages: []\n',
    execFile: async (command, args) => {
      calls.push({ command, args });
      if (command === 'uvx' && args.includes('python/ktx-sl/pyproject.toml')) {
        const error = new Error('dependency-check-updates failed');
        error.stdout = 'checking Python dependencies';
        error.stderr = 'could not read pyproject.toml';
        throw error;
      }
      return { stdout: '', stderr: '' };
    },
    log: (line) => logs.push(line),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failedPhase.name, 'Python dependency constraints: python/ktx-sl/pyproject.toml');
  assert.equal(result.failedPhase.retry, 'uvx dependency-check-updates --manifest python/ktx-sl/pyproject.toml -u');
  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [
      ['pnpm', ['dlx', 'npm-check-updates', '-u', '--deep']],
      ['uvx', ['dependency-check-updates', '--manifest', 'pyproject.toml', '-u']],
      ['uvx', ['dependency-check-updates', '--manifest', 'python/ktx-sl/pyproject.toml', '-u']],
    ],
  );
  assert.equal(logs.some((line) => line.includes('FAIL Python dependency constraints')), true);
  assert.equal(logs.some((line) => line.includes('could not read pyproject.toml')), true);
  assert.equal(logs.some((line) => line.includes('checking Python dependencies')), true);
  assert.equal(
    logs.some((line) => line.includes('Retry: uvx dependency-check-updates --manifest python/ktx-sl/pyproject.toml -u')),
    true,
  );
});

test('runDependencyUpgrade ignores missing pnpm minimum release age config', async () => {
  const calls = [];

  const result = await runDependencyUpgrade({
    rootDir: '/workspace/ktx',
    readFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    execFile: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '', stderr: '' };
    },
    log: () => undefined,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {
    command: 'pnpm',
    args: ['dlx', 'npm-check-updates', '-u', '--deep'],
  });
  assert.equal(
    calls
      .filter((call) => call.command === 'uvx')
      .every((call) => call.args.includes('--manifest') && !call.args.includes('-d')),
    true,
  );
});

test('package scripts expose the full dependency upgrade command', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts['deps:upgrade'], 'node scripts/upgrade-dependencies.mjs');
});
