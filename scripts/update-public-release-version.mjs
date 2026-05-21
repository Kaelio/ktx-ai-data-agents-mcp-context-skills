#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PUBLIC_NPM_PACKAGE_NAME,
  assertPublicNpmPackageVersion,
  assertPublicNpmReleaseTag,
  publicNpmPackageVersionToPythonVersion,
  releasePolicyPath,
} from './public-npm-release-metadata.mjs';

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function pyprojectWithProjectVersion(source, version) {
  const lines = source.split('\n');
  let inProject = false;
  let replaced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      inProject = sectionMatch[1] === 'project';
      continue;
    }
    if (inProject && /^\s*version\s*=\s*"[^"]*"\s*$/.test(line)) {
      lines[index] = `version = "${version}"`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    throw new Error('No [project].version assignment found in pyproject.toml');
  }
  return lines.join('\n');
}

async function rewritePyprojectVersion(path, version) {
  const source = await readFile(path, 'utf8');
  await writeFile(path, pyprojectWithProjectVersion(source, version));
}

function safePythonVersionFor(version) {
  try {
    return publicNpmPackageVersionToPythonVersion(version);
  } catch {
    return null;
  }
}

export async function updatePublicReleaseVersion(rootDir, version, tag) {
  const safeVersion = assertPublicNpmPackageVersion(version);
  const safeTag = assertPublicNpmReleaseTag(tag);

  const packageJsonPath = join(rootDir, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  packageJson.version = safeVersion;
  await writeJson(packageJsonPath, packageJson);

  const cliPackageJsonPath = join(rootDir, 'packages', 'cli', 'package.json');
  const cliPackageJson = await readJson(cliPackageJsonPath);
  cliPackageJson.version = safeVersion;
  await writeJson(cliPackageJsonPath, cliPackageJson);

  const pythonVersion = safePythonVersionFor(safeVersion);
  if (pythonVersion !== null) {
    await rewritePyprojectVersion(join(rootDir, 'python', 'ktx-daemon', 'pyproject.toml'), pythonVersion);
    await rewritePyprojectVersion(join(rootDir, 'python', 'ktx-sl', 'pyproject.toml'), pythonVersion);
  }

  const policyPath = releasePolicyPath(rootDir);
  const policy = await readJson(policyPath);
  delete policy.publicNpmPackageVersion;
  policy.releaseMode = 'npm-public-release-ready';
  policy.requiredBeforePublishing = [];
  policy.npm = {
    ...policy.npm,
    publish: true,
    registry: policy.npm?.registry ?? null,
    access: 'public',
    tag: safeTag,
    packages: [PUBLIC_NPM_PACKAGE_NAME],
  };
  policy.publishedPackageSmoke = {
    ...policy.publishedPackageSmoke,
    packageName: PUBLIC_NPM_PACKAGE_NAME,
    version: safeVersion,
  };
  await writeJson(policyPath, policy);

  return {
    version: safeVersion,
    tag: safeTag,
    pythonVersion,
  };
}

async function main() {
  const [version, tag] = process.argv.slice(2);
  if (!version || !tag) {
    throw new Error('Usage: node scripts/update-public-release-version.mjs <version> <latest|next>');
  }

  const result = await updatePublicReleaseVersion(scriptRootDir(), version, tag);
  process.stdout.write(`Updated ${PUBLIC_NPM_PACKAGE_NAME} release metadata to ${result.version} (${result.tag})\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
