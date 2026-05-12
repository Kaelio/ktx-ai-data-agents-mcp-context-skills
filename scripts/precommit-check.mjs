#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const ktxRoot = dirname(dirname(scriptPath));

const packageNameByDir = new Map(
  [
    'cli',
    'connector-bigquery',
    'connector-clickhouse',
    'connector-mysql',
    'connector-postgres',
    'connector-snowflake',
    'connector-sqlite',
    'connector-sqlserver',
    'context',
    'llm',
  ].map((packageDir) => {
    const manifestPath = join(ktxRoot, 'packages', packageDir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return [packageDir, manifest.name];
  }),
);

const packageCodePattern = /\.(?:ts|tsx|js|jsx|json)$/;
const scriptPattern = /\.(?:mjs|js|json)$/;
const pythonPackageTests = new Map([
  ['ktx-sl', 'python/ktx-sl/tests'],
  ['ktx-daemon', 'python/ktx-daemon/tests'],
]);

function normalizeFilePath(filePath) {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized.startsWith('ktx/') ? normalized.slice('ktx/'.length) : normalized;
}

function stablePush(commands, key, cmd, args) {
  if (commands.some((command) => command.key === key)) {
    return;
  }

  commands.push({ key, cmd, args });
}

function maybeScriptTest(scriptFile) {
  if (scriptFile.endsWith('.test.mjs')) {
    return scriptFile;
  }

  if (!scriptFile.endsWith('.mjs')) {
    return null;
  }

  const testFile = scriptFile.replace(/\.mjs$/, '.test.mjs');
  return existsSync(join(ktxRoot, testFile)) ? testFile : null;
}

export function planChecks(files) {
  const commands = [];
  const packageNames = new Set();
  const pythonPackages = new Set();
  let runBoundaryCheck = false;
  let runAllTypeChecks = false;
  let runAllPythonTests = false;

  for (const rawFile of files) {
    const ktxFile = normalizeFilePath(rawFile);

    if (ktxFile.startsWith('packages/')) {
      const [, packageDir, ...rest] = ktxFile.split('/');
      const packageName = packageNameByDir.get(packageDir);
      const packageFile = rest.join('/');

      if (packageName && packageCodePattern.test(packageFile)) {
        packageNames.add(packageName);
        runBoundaryCheck = true;
      }

      continue;
    }

    if (ktxFile.startsWith('scripts/') && scriptPattern.test(ktxFile)) {
      const testFile = maybeScriptTest(ktxFile);

      if (testFile) {
        stablePush(commands, `script-test:${testFile}`, 'node', ['--test', testFile]);
      }

      continue;
    }

    if (ktxFile.startsWith('python/')) {
      const [, packageDir] = ktxFile.split('/');

      if (pythonPackageTests.has(packageDir)) {
        pythonPackages.add(packageDir);
      }

      continue;
    }

    if (
      ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'release-policy.json', 'tsconfig.base.json'].includes(
        ktxFile,
      )
    ) {
      runBoundaryCheck = true;
      runAllTypeChecks = true;
      continue;
    }

    if (['pyproject.toml', 'uv.lock', 'uv.toml'].includes(ktxFile)) {
      runAllPythonTests = true;
    }
  }

  if (runBoundaryCheck) {
    stablePush(commands, 'boundary-check', 'node', ['scripts/check-boundaries.mjs']);
  }

  if (runAllTypeChecks) {
    stablePush(commands, 'type-check:all', 'pnpm', ['--filter', './packages/*', 'run', 'type-check']);
  } else {
    for (const packageName of [...packageNames].sort()) {
      stablePush(commands, `type-check:${packageName}`, 'pnpm', ['--filter', packageName, 'run', 'type-check']);
      stablePush(commands, `build:${packageName}`, 'pnpm', ['--filter', `${packageName}...`, 'run', 'build']);
      stablePush(commands, `test:${packageName}`, 'pnpm', ['--filter', packageName, 'run', 'test']);
    }
  }

  if (runAllPythonTests) {
    stablePush(commands, 'pytest:all', 'uv', ['run', 'pytest']);
  } else {
    for (const packageDir of [...pythonPackages].sort()) {
      stablePush(commands, `pytest:${packageDir}`, 'uv', [
        'run',
        '--package',
        packageDir,
        'pytest',
        pythonPackageTests.get(packageDir),
      ]);
    }
  }

  return commands;
}

function printCommand(command) {
  console.log(`\n$ ${command.cmd} ${command.args.join(' ')}`);
}

export function runChecks(files) {
  const commands = planChecks(files);

  if (commands.length === 0) {
    console.log('No KTX package checks needed for these files.');
    return 0;
  }

  for (const command of commands) {
    printCommand(command);

    const result = spawnSync(command.cmd, command.args, {
      cwd: ktxRoot,
      stdio: 'inherit',
      env: process.env,
    });

    if (result.error) {
      console.error(result.error.message);
      return 1;
    }

    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }

  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runChecks(process.argv.slice(2));
}
