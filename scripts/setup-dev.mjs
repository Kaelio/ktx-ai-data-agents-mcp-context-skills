#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

function ktxRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function failureText(error) {
  const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const message = error instanceof Error ? error.message.trim() : String(error);
  return [stderr, stdout, message].find((line) => line.length > 0) ?? 'Command failed';
}

export async function runSetupDev(options = {}) {
  const rootDir = options.rootDir ?? ktxRootDir();
  const execFile = options.execFile ?? execFileAsync;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const phases = [
    {
      name: 'dependency install',
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      retry: 'pnpm install --frozen-lockfile',
    },
    {
      name: 'native SQLite rebuild',
      command: 'pnpm',
      args: ['run', 'native:rebuild'],
      retry: 'pnpm run native:rebuild',
    },
    {
      name: 'TypeScript package build',
      command: 'pnpm',
      args: ['run', 'build'],
      retry: 'pnpm run build',
    },
    {
      name: 'runtime wheel assets',
      command: 'pnpm',
      args: ['run', 'artifacts:build-runtime'],
      retry: 'pnpm run artifacts:build-runtime',
    },
    {
      name: 'doctor setup',
      command: process.execPath,
      args: ['packages/cli/dist/bin.js', 'status', '--no-input'],
      retry: 'pnpm run ktx -- status --no-input',
    },
  ];

  for (const phase of phases) {
    log(`RUN  ${phase.name}: ${phase.command} ${phase.args.join(' ')}`);
    try {
      await execFile(phase.command, phase.args, { cwd: rootDir, maxBuffer: 1024 * 1024 });
      log(`PASS ${phase.name}`);
    } catch (error) {
      log(`FAIL ${phase.name}: ${failureText(error)}`);
      log(`Retry: ${phase.retry}`);
      return { ok: false, failedPhase: phase };
    }
  }

  log('Workspace CLI: pnpm run ktx -- --help');
  log('Optional global dev link: pnpm run link:dev');
  return { ok: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runSetupDev();
  if (!result.ok) {
    process.exitCode = 1;
  }
}
