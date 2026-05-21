#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  PUBLIC_NPM_PACKAGE_NAME,
  publicNpmPackageVersion,
} from './public-npm-release-metadata.mjs';

const execFileAsync = promisify(execFile);

export const PUBLIC_NPM_PACKAGE_VERSION = publicNpmPackageVersion();
export { PUBLIC_NPM_PACKAGE_NAME };

export function publicNpmPackageTarballName(version = PUBLIC_NPM_PACKAGE_VERSION) {
  return `kaelio-ktx-${version}.tgz`;
}

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function publicNpmPackageLayout(rootDir = scriptRootDir(), version = PUBLIC_NPM_PACKAGE_VERSION) {
  return {
    rootDir,
    packageVersion: version,
    cliPackageRoot: join(rootDir, 'packages', 'cli'),
    packRoot: join(rootDir, 'dist', 'public-npm-package'),
    npmDir: join(rootDir, 'dist', 'artifacts', 'npm'),
    tarballPath: join(rootDir, 'dist', 'artifacts', 'npm', publicNpmPackageTarballName(version)),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function isWorkspacePackageName(name) {
  return name.startsWith('@ktx/');
}

export function collectPublicDependencies(cliPackageJson) {
  return sortedObject(
    Object.entries(cliPackageJson.dependencies ?? {}).filter(([name]) => !isWorkspacePackageName(name)),
  );
}

export function publicNpmPackageJson(cliPackageJson, dependencies, version = PUBLIC_NPM_PACKAGE_VERSION) {
  return {
    name: PUBLIC_NPM_PACKAGE_NAME,
    version,
    description: 'Standalone KTX context layer for database agents',
    private: false,
    type: 'module',
    engines: cliPackageJson.engines ?? { node: '>=22.0.0' },
    bin: { ktx: './dist/bin.js' },
    main: cliPackageJson.main ?? 'dist/index.js',
    types: cliPackageJson.types ?? 'dist/index.d.ts',
    exports: cliPackageJson.exports ?? {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    },
    files: ['dist', 'assets'],
    dependencies,
    license: cliPackageJson.license ?? 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'https://github.com/Kaelio/ktx',
    },
    bugs: {
      url: 'https://github.com/Kaelio/ktx/issues',
    },
    homepage: 'https://github.com/Kaelio/ktx#readme',
  };
}

async function copyPackageFileEntries(sourceRoot, targetRoot, packageJson) {
  for (const entry of packageJson.files ?? ['dist']) {
    await cp(join(sourceRoot, entry), join(targetRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

async function copyCliPackage(layout, cliPackageJson, dependencies) {
  await copyPackageFileEntries(layout.cliPackageRoot, layout.packRoot, cliPackageJson);
  await writeJson(
    join(layout.packRoot, 'package.json'),
    publicNpmPackageJson(cliPackageJson, dependencies, layout.packageVersion),
  );
}

export async function createPublicNpmPackageTree(layout = publicNpmPackageLayout()) {
  const cliPackageJson = await readJson(join(layout.cliPackageRoot, 'package.json'));
  const dependencies = collectPublicDependencies(cliPackageJson);

  await rm(layout.packRoot, { recursive: true, force: true });
  await mkdir(layout.packRoot, { recursive: true });
  await mkdir(layout.npmDir, { recursive: true });
  await copyCliPackage(layout, cliPackageJson, dependencies);

  return {
    layout,
    packageJson: publicNpmPackageJson(cliPackageJson, dependencies, layout.packageVersion),
  };
}

export function publicNpmPackCommand(layout = publicNpmPackageLayout()) {
  return {
    command: 'pnpm',
    args: ['--config.node-linker=hoisted', 'pack', '--out', layout.tarballPath],
    cwd: layout.packRoot,
  };
}

export async function buildPublicNpmPackage(layout = publicNpmPackageLayout()) {
  await createPublicNpmPackageTree(layout);
  const pack = publicNpmPackCommand(layout);
  await execFileAsync(pack.command, pack.args, {
    cwd: pack.cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return layout.tarballPath;
}

async function main() {
  const tarball = await buildPublicNpmPackage();
  process.stdout.write(`Built ${PUBLIC_NPM_PACKAGE_NAME} package: ${tarball}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
