#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PUBLIC_NPM_PACKAGE_NAME = '@kaelio/ktx';
export const PUBLIC_NPM_PACKAGE_VERSION = '0.1.0-rc.1';

export function publicNpmPackageTarballName(version = PUBLIC_NPM_PACKAGE_VERSION) {
  return `kaelio-ktx-${version}.tgz`;
}

export const PUBLIC_BUNDLED_WORKSPACE_PACKAGES = [
  '@ktx/llm',
  '@ktx/context',
  '@ktx/connector-bigquery',
  '@ktx/connector-clickhouse',
  '@ktx/connector-mysql',
  '@ktx/connector-postgres',
  '@ktx/connector-snowflake',
  '@ktx/connector-sqlite',
  '@ktx/connector-sqlserver',
];

export const PUBLIC_BUNDLED_WORKSPACE_PACKAGE_ROOTS = {
  '@ktx/llm': 'packages/llm',
  '@ktx/context': 'packages/context',
  '@ktx/connector-bigquery': 'packages/connector-bigquery',
  '@ktx/connector-clickhouse': 'packages/connector-clickhouse',
  '@ktx/connector-mysql': 'packages/connector-mysql',
  '@ktx/connector-postgres': 'packages/connector-postgres',
  '@ktx/connector-snowflake': 'packages/connector-snowflake',
  '@ktx/connector-sqlite': 'packages/connector-sqlite',
  '@ktx/connector-sqlserver': 'packages/connector-sqlserver',
};

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

function parseCaretVersion(value) {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareParsedVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function mergeDependencyVersion(name, previous, next) {
  if (previous === next) {
    return previous;
  }

  const previousCaret = parseCaretVersion(previous);
  const nextCaret = parseCaretVersion(next);
  if (previousCaret && nextCaret && previousCaret.major === nextCaret.major) {
    return compareParsedVersions(previousCaret, nextCaret) >= 0 ? previous : next;
  }

  throw new Error(`Incompatible dependency versions for ${name}: ${previous} and ${next}`);
}

export function collectPublicDependencies(packageJsons) {
  const dependencies = new Map();

  for (const packageJson of packageJsons) {
    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (isWorkspacePackageName(name)) {
        continue;
      }
      const previous = dependencies.get(name);
      dependencies.set(name, previous ? mergeDependencyVersion(name, previous, version) : version);
    }
  }

  return sortedObject(dependencies);
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
    bundledDependencies: PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
    license: cliPackageJson.license ?? 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/kaelio/ktx.git',
    },
    bugs: {
      url: 'https://github.com/kaelio/ktx/issues',
    },
    homepage: 'https://github.com/kaelio/ktx#readme',
  };
}

function bundledWorkspacePackageJson(packageJson) {
  return {
    name: packageJson.name,
    version: packageJson.version ?? PUBLIC_NPM_PACKAGE_VERSION,
    private: true,
    type: packageJson.type ?? 'module',
    main: packageJson.main,
    types: packageJson.types,
    exports: packageJson.exports,
    files: packageJson.files,
    license: packageJson.license ?? 'Apache-2.0',
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

async function copyBundledWorkspacePackage(rootDir, packageName, packageJson) {
  const packageRoot = PUBLIC_BUNDLED_WORKSPACE_PACKAGE_ROOTS[packageName];
  if (!packageRoot) {
    throw new Error(`Missing bundled workspace package root for ${packageName}`);
  }

  const sourceRoot = join(rootDir, packageRoot);
  const targetRoot = join(rootDir, 'dist', 'public-npm-package', 'node_modules', ...packageName.split('/'));
  await mkdir(targetRoot, { recursive: true });
  await copyPackageFileEntries(sourceRoot, targetRoot, packageJson);
  await writeJson(join(targetRoot, 'package.json'), bundledWorkspacePackageJson(packageJson));
}

export async function createPublicNpmPackageTree(layout = publicNpmPackageLayout()) {
  const cliPackageJson = await readJson(join(layout.cliPackageRoot, 'package.json'));
  const bundledPackageJsons = await Promise.all(
    PUBLIC_BUNDLED_WORKSPACE_PACKAGES.map(async (packageName) => {
      const packageRoot = PUBLIC_BUNDLED_WORKSPACE_PACKAGE_ROOTS[packageName];
      const packageJson = await readJson(join(layout.rootDir, packageRoot, 'package.json'));
      if (packageJson.name !== packageName) {
        throw new Error(`Unexpected package name in ${packageRoot}/package.json: ${packageJson.name}`);
      }
      return packageJson;
    }),
  );
  const dependencies = collectPublicDependencies([cliPackageJson, ...bundledPackageJsons]);

  await rm(layout.packRoot, { recursive: true, force: true });
  await mkdir(layout.packRoot, { recursive: true });
  await mkdir(layout.npmDir, { recursive: true });
  await copyCliPackage(layout, cliPackageJson, dependencies);

  for (const packageJson of bundledPackageJsons) {
    await copyBundledWorkspacePackage(layout.rootDir, packageJson.name, packageJson);
  }

  return {
    layout,
    packageJson: publicNpmPackageJson(cliPackageJson, dependencies, layout.packageVersion),
    bundledPackages: PUBLIC_BUNDLED_WORKSPACE_PACKAGES,
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
