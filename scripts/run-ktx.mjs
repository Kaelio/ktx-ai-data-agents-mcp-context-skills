#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access as fsAccess,
  readdir as fsReaddir,
  stat as fsStat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function ktxRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function cliBinPath(rootDir) {
  return resolve(rootDir, 'packages', 'cli', 'dist', 'bin.js');
}

function buildStampPath(rootDir) {
  return resolve(rootDir, 'packages', 'cli', 'dist', '.ktx-build-stamp');
}

async function fileExists(path, access) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function packageBuildInputPaths(rootDir, readdir) {
  const paths = [resolve(rootDir, 'package.json'), resolve(rootDir, 'tsconfig.base.json')];
  let packageEntries = [];
  try {
    packageEntries = await readdir(resolve(rootDir, 'packages'), { withFileTypes: true });
  } catch {
    return paths;
  }

  for (const entry of packageEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = resolve(rootDir, 'packages', entry.name);
    paths.push(resolve(packageDir, 'package.json'), resolve(packageDir, 'tsconfig.json'), resolve(packageDir, 'src'));
  }
  return paths;
}

async function newestMtimeMs(path, fs) {
  let stats;
  try {
    stats = await fs.stat(path);
  } catch {
    return 0;
  }
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  let entries = [];
  try {
    entries = await fs.readdir(path, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    newest = Math.max(newest, await newestMtimeMs(resolve(path, entry.name), fs));
  }
  return newest;
}

async function isBuildStale(rootDir, stampPath, fs) {
  let stampStats;
  try {
    stampStats = await fs.stat(stampPath);
  } catch {
    return true;
  }

  const inputPaths = await packageBuildInputPaths(rootDir, fs.readdir);
  for (const inputPath of inputPaths) {
    if ((await newestMtimeMs(inputPath, fs)) > stampStats.mtimeMs) {
      return true;
    }
  }
  return false;
}

async function runBuffered(execFile, stdout, stderr, command, args, options) {
  try {
    const result = await execFile(command, args, { cwd: options.cwd, env: options.env, maxBuffer: 1024 * 1024 * 16 });
    if (result.stdout) {
      stdout.write(result.stdout);
    }
    if (result.stderr) {
      stderr.write(result.stderr);
    }
    return 0;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.length > 0) {
      stdout.write(error.stdout);
    }
    if (typeof error?.stderr === 'string' && error.stderr.length > 0) {
      stderr.write(error.stderr);
    }
    return typeof error?.code === 'number' ? error.code : 1;
  }
}

function runInherited(command, args, options) {
  return new Promise((resolveExitCode) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      env: options.env ?? process.env,
    });

    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (code !== null) {
        resolveExitCode(code);
        return;
      }
      process.stderr.write(`Command terminated by signal ${signal ?? 'unknown'}\n`);
      resolveExitCode(1);
    });
  });
}

export async function runWorkspaceKtx(argv, options = {}) {
  const cliArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const rootDir = options.rootDir ?? ktxRootDir();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const access = options.access ?? fsAccess;
  const fs = {
    stat: options.stat ?? fsStat,
    readdir: options.readdir ?? fsReaddir,
  };
  const writeFile = options.writeFile ?? fsWriteFile;
  const binPath = cliBinPath(rootDir);
  const stampPath = buildStampPath(rootDir);
  const runCommand =
    options.runCommand ??
    (options.execFile
      ? (command, args, commandOptions) => runBuffered(options.execFile, stdout, stderr, command, args, commandOptions)
      : (command, args, commandOptions) => runInherited(command, args, commandOptions));
  const commandEnv = options.env;

  const binExists = await fileExists(binPath, access);
  const needsBuild = !binExists || (await isBuildStale(rootDir, stampPath, fs));
  if (needsBuild) {
    stderr.write(
      binExists
        ? 'ktx CLI build output is stale. Rebuilding it now with `pnpm run build`...\n'
        : 'ktx CLI build output is missing. Building it now with `pnpm run build`...\n',
    );
    const buildExitCode = await runCommand('pnpm', ['run', 'build'], { cwd: rootDir, env: commandEnv });
    if (buildExitCode !== 0) {
      stderr.write(
        '\nktx CLI build failed. Run `pnpm run setup:dev` from the ktx directory, then retry this command.\n',
      );
      return buildExitCode;
    }
    await writeFile(stampPath, '');
  }

  return await runCommand(process.execPath, [binPath, ...cliArgv], { cwd: rootDir, env: commandEnv });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWorkspaceKtx(process.argv.slice(2));
}
