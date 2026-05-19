#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

export function normalizeLcovContent(content, packagePath) {
  const normalizedPackagePath = toPosix(packagePath).replace(/\/$/, '');

  return content.replace(/^SF:(.+)$/gm, (line, sourcePath) => {
    const normalizedSourcePath = toPosix(sourcePath);

    if (
      path.isAbsolute(sourcePath) ||
      normalizedSourcePath.startsWith(`${normalizedPackagePath}/`) ||
      normalizedSourcePath.startsWith('../')
    ) {
      return line;
    }

    return `SF:${normalizedPackagePath}/${normalizedSourcePath}`;
  });
}

export async function normalizeLcovFile(rootDir, reportPath) {
  const absoluteReportPath = path.resolve(rootDir, reportPath);
  const packagePath = toPosix(path.relative(rootDir, path.dirname(path.dirname(absoluteReportPath))));
  const content = await readFile(absoluteReportPath, 'utf8');
  const normalizedContent = normalizeLcovContent(content, packagePath);

  if (normalizedContent !== content) {
    await writeFile(absoluteReportPath, normalizedContent);
  }
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, '..');
  const reportPaths = process.argv.slice(2);

  if (reportPaths.length === 0) {
    throw new Error('Usage: normalize-lcov-paths.mjs <coverage/lcov.info> [...]');
  }

  for (const reportPath of reportPaths) {
    await normalizeLcovFile(rootDir, reportPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
