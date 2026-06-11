#!/usr/bin/env node

import { constants } from 'node:fs';
import { access, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function ktxRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function cliBinPath(rootDir = ktxRootDir()) {
  return resolve(rootDir, 'packages', 'cli', 'dist', 'bin.js');
}

async function canExecute(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureCliBinExecutable(rootDir = ktxRootDir()) {
  const binPath = cliBinPath(rootDir);
  await access(binPath, constants.R_OK);

  if (process.platform !== 'win32' && !(await canExecute(binPath))) {
    await chmod(binPath, 0o755);
  }

  return binPath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const binPath = await ensureCliBinExecutable();
    process.stdout.write(`Prepared ktx CLI bin: ${binPath}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
