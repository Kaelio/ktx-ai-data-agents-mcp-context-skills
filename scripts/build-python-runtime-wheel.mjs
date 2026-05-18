#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { publicPythonRuntimePackageVersion } from './public-npm-release-metadata.mjs';

const execFileAsync = promisify(execFile);

export const RUNTIME_WHEEL_DISTRIBUTION_NAME = 'kaelio-ktx';
export const RUNTIME_WHEEL_NORMALIZED_NAME = 'kaelio_ktx';
export const RUNTIME_WHEEL_PACKAGE_VERSION = publicPythonRuntimePackageVersion();

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function runtimeWheelLayout(rootDir = scriptRootDir()) {
  return {
    rootDir,
    semanticLayerSourceDir: join(rootDir, 'python', 'ktx-sl', 'semantic_layer'),
    daemonSourceDir: join(rootDir, 'python', 'ktx-daemon', 'src', 'ktx_daemon'),
    buildRoot: join(rootDir, 'dist', 'runtime-wheel-src'),
    outputDir: join(rootDir, 'dist', 'artifacts', 'python'),
  };
}

export function runtimeWheelPyproject() {
  return `[project]
name = "${RUNTIME_WHEEL_DISTRIBUTION_NAME}"
version = "${RUNTIME_WHEEL_PACKAGE_VERSION}"
description = "Bundled Python runtime payload for the KTX npm package"
readme = "README.md"
requires-python = ">=3.13"
license = "Apache-2.0"
dependencies = [
    "fastapi>=0.115.0",
    "lkml>=1.3.7",
    "numpy>=2.2.6",
    "orjson>=3.11.4",
    "pandas>=2.2.3",
    "psycopg[binary]>=3.2.0",
    "pydantic>=2.9.0",
    "pyyaml>=6",
    "requests>=2.32.0",
    "sqlglot>=26",
    "uvicorn[standard]>=0.32.0",
]

[project.optional-dependencies]
local-embeddings = [
    "sentence-transformers>=5.1.1",
    "torch>=2.2.0",
]

[project.scripts]
ktx-daemon = "ktx_daemon.__main__:main"

[project.urls]
Homepage = "https://github.com/kaelio/ktx"
Repository = "https://github.com/kaelio/ktx"
Issues = "https://github.com/kaelio/ktx/issues"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["semantic_layer", "ktx_daemon"]
`;
}

export function runtimeWheelReadme() {
  return `# kaelio-ktx Python runtime

Bundled Python runtime wheel for KTX.

This wheel is built from the repository's \`semantic_layer\` and
\`ktx_daemon\` source trees for inclusion in the npm package. It is not a
separate public PyPI release artifact.
`;
}

export async function createRuntimeWheelBuildTree(layout = runtimeWheelLayout()) {
  await rm(layout.buildRoot, { recursive: true, force: true });
  await mkdir(layout.buildRoot, { recursive: true });
  await cp(layout.semanticLayerSourceDir, join(layout.buildRoot, 'semantic_layer'), {
    recursive: true,
  });
  await cp(layout.daemonSourceDir, join(layout.buildRoot, 'ktx_daemon'), {
    recursive: true,
  });
  await writeFile(join(layout.buildRoot, 'pyproject.toml'), runtimeWheelPyproject());
  await writeFile(join(layout.buildRoot, 'README.md'), runtimeWheelReadme());
}

export function runtimeWheelBuildCommand(layout = runtimeWheelLayout()) {
  return {
    command: 'uv',
    args: ['build', '--wheel', '--out-dir', layout.outputDir, layout.buildRoot],
    cwd: layout.rootDir,
  };
}

async function runCommand(command, args, options) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

export async function buildRuntimeWheel(layout = runtimeWheelLayout()) {
  await mkdir(layout.outputDir, { recursive: true });
  await createRuntimeWheelBuildTree(layout);
  const command = runtimeWheelBuildCommand(layout);
  await runCommand(command.command, command.args, { cwd: command.cwd });
  const pyproject = await readFile(join(layout.buildRoot, 'pyproject.toml'), 'utf8');
  return {
    buildRoot: layout.buildRoot,
    outputDir: layout.outputDir,
    pyproject,
  };
}

async function main() {
  await buildRuntimeWheel(runtimeWheelLayout());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
