#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { packageArtifactLayout } from './package-artifacts.mjs';
import { releaseReadinessReport } from './release-readiness.mjs';

const execFileAsync = promisify(execFile);

export function resolvePublishMode(args = process.argv.slice(2)) {
  return { live: args.includes('--publish') };
}

export function requireNpmPublicReleaseReady(report) {
  if (report.releaseMode !== 'npm-public-release-ready' || report.npmPublishEnabled !== true || !report.npmPublish) {
    throw new Error('release-policy.json must use npm-public-release-ready before publishing');
  }
  return report.npmPublish;
}

export function buildNpmPublishCommand(tarballPath, publish, mode) {
  return {
    command: 'pnpm',
    args: [
      'publish',
      tarballPath,
      '--access',
      publish.access,
      '--tag',
      publish.tag,
      ...(mode.live ? [] : ['--dry-run', '--no-git-checks']),
    ],
    env: publish.registry ? { npm_config_registry: publish.registry } : {},
  };
}

async function assertFileExists(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing npm tarball: ${path}. Run pnpm run artifacts:check first.`);
  }
}

async function runPublishCommand(command) {
  process.stdout.write(`$ ${command.command} ${command.args.join(' ')}\n`);
  await execFileAsync(command.command, command.args, {
    env: { ...process.env, ...command.env },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
}

export async function publishPublicNpmPackage(options = {}) {
  const rootDir = options.rootDir;
  const mode = options.mode ?? resolvePublishMode(options.args);
  const report = await releaseReadinessReport(rootDir);
  const publish = requireNpmPublicReleaseReady(report);
  const layout = packageArtifactLayout(rootDir);
  const tarballPath = layout.cliTarball;

  await assertFileExists(tarballPath);
  const command = buildNpmPublishCommand(tarballPath, publish, mode);
  await runPublishCommand(command);

  process.stdout.write(
    mode.live
      ? `Published ${publish.packageName}@${publish.version} with tag ${publish.tag}\n`
      : `Dry-run verified ${publish.packageName}@${publish.version} with tag ${publish.tag}\n`,
  );
}

async function main() {
  await publishPublicNpmPackage({ args: process.argv.slice(2) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
