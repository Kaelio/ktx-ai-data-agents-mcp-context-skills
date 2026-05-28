#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
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
  return [stderr, stdout, message].filter((line) => line.length > 0).join('\n') || 'Command failed';
}

function commandText(command, args) {
  return [command, ...args].join(' ');
}

function pythonDependencyUpdatePhases() {
  const manifests = ['pyproject.toml', 'python/ktx-sl/pyproject.toml', 'python/ktx-daemon/pyproject.toml'];
  return manifests.map((manifest) => ({
    name: `Python dependency constraints: ${manifest}`,
    command: 'uvx',
    args: ['dependency-check-updates', '--manifest', manifest, '-u'],
    retry: commandText('uvx', ['dependency-check-updates', '--manifest', manifest, '-u']),
  }));
}

async function pnpmMinimumReleaseAgeCooldown(rootDir, readFile) {
  let workspaceConfig;
  try {
    workspaceConfig = await readFile(resolve(rootDir, 'pnpm-workspace.yaml'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const match = workspaceConfig.match(/^\s*minimumReleaseAge:\s*(\d+)\s*$/m);
  if (!match) {
    return [];
  }
  return ['--cooldown', `${match[1]}m`];
}

export async function runDependencyUpgrade(options = {}) {
  const rootDir = options.rootDir ?? ktxRootDir();
  const execFile = options.execFile ?? execFileAsync;
  const readFile = options.readFile ?? fsReadFile;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const npmCheckUpdatesCooldownArgs = await pnpmMinimumReleaseAgeCooldown(rootDir, readFile);
  const phases = [
    {
      name: 'TypeScript dependency constraints',
      command: 'pnpm',
      args: ['dlx', 'npm-check-updates', '-u', '--deep', ...npmCheckUpdatesCooldownArgs],
      retry: commandText('pnpm', ['dlx', 'npm-check-updates', '-u', '--deep', ...npmCheckUpdatesCooldownArgs]),
    },
    ...pythonDependencyUpdatePhases(),
    {
      name: 'TypeScript lockfile',
      command: 'pnpm',
      args: ['install'],
      retry: 'pnpm install',
    },
    {
      name: 'Python lockfile',
      command: 'uv',
      args: ['lock', '--upgrade'],
      retry: 'uv lock --upgrade',
    },
  ];

  for (const phase of phases) {
    log(`RUN  ${phase.name}: ${commandText(phase.command, phase.args)}`);
    try {
      await execFile(phase.command, phase.args, { cwd: rootDir, maxBuffer: 1024 * 1024 * 64 });
      log(`PASS ${phase.name}`);
    } catch (error) {
      log(`FAIL ${phase.name}: ${failureText(error)}`);
      log(`Retry: ${phase.retry}`);
      return { ok: false, failedPhase: phase };
    }
  }

  log('Dependency manifests and lockfiles were updated. Run `pnpm run check` before committing.');
  return { ok: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDependencyUpgrade();
  if (!result.ok) {
    process.exitCode = 1;
  }
}
