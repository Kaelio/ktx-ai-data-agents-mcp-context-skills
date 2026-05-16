#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { packageArtifactLayout } from './package-artifacts.mjs';
import { releaseReadinessReport } from './release-readiness.mjs';

export const NPM_PUBLISH_TIMEOUT_MS = 180_000;

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
    command: 'npm',
    args: [
      'publish',
      tarballPath,
      '--access',
      publish.access,
      '--tag',
      publish.tag,
      ...(mode.live ? [] : ['--dry-run']),
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

  await new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(command.command, command.args, {
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      settle(reject, new Error(`Timed out after ${NPM_PUBLISH_TIMEOUT_MS}ms while publishing npm package`));
    }, NPM_PUBLISH_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      settle(reject, error);
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        settle(resolvePromise);
        return;
      }
      settle(reject, new Error(`npm publish failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
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
