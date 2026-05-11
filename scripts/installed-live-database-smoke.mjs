#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  npmSmokePackageJson,
  packageArtifactLayout,
} from './package-artifacts.mjs';

const POSTGRES_IMAGE = process.env.KTX_ARTIFACT_POSTGRES_IMAGE ?? 'postgres:16-alpine';
const POSTGRES_USER = 'ktx';
const POSTGRES_PASSWORD = 'postgres'; // pragma: allowlist secret
const POSTGRES_DB = 'warehouse';

export function smokeContainerName(pid = process.pid, now = Date.now()) {
  return `ktx-live-db-smoke-${pid}-${now}`;
}

export function buildPostgresUrl(hostPort) {
  return `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${hostPort}/${POSTGRES_DB}`; // pragma: allowlist secret
}

export function buildDockerRunArgs({ containerName, hostPort, image = POSTGRES_IMAGE }) {
  return [
    'run',
    '--rm',
    '-d',
    '--name',
    containerName,
    '-e',
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '-e',
    `POSTGRES_USER=${POSTGRES_USER}`,
    '-e',
    `POSTGRES_DB=${POSTGRES_DB}`,
    '-p',
    `127.0.0.1:${hostPort}:5432`,
    image,
  ];
}

export function buildPostgresReadyArgs(containerName) {
  return [
    'exec',
    containerName,
    'psql',
    '-U',
    POSTGRES_USER,
    '-d',
    POSTGRES_DB,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'SELECT 1;',
  ];
}

export function buildSeedSql() {
  return [
    'DROP TABLE IF EXISTS orders;',
    'DROP TABLE IF EXISTS customers;',
    'CREATE TABLE customers (',
    '  id integer PRIMARY KEY,',
    '  name text NOT NULL',
    ');',
    "COMMENT ON TABLE customers IS 'Customers captured by the artifact smoke';",
    "COMMENT ON COLUMN customers.name IS 'Customer display name';",
    'CREATE TABLE orders (',
    '  id integer PRIMARY KEY,',
    '  customer_id integer NOT NULL REFERENCES customers(id),',
    '  status text NOT NULL,',
    '  amount integer NOT NULL',
    ');',
    "COMMENT ON TABLE orders IS 'Orders captured by the artifact smoke';",
    "COMMENT ON COLUMN orders.amount IS 'Order amount in cents';",
    "INSERT INTO customers (id, name) VALUES (1, 'Acme'), (2, 'Globex');",
    "INSERT INTO orders (id, customer_id, status, amount) VALUES (10, 1, 'paid', 2000), (11, 2, 'open', 3500);",
    '',
  ].join('\n');
}

export function buildKtxYaml(postgresUrl) {
  return [
    'project: artifact-live-database',
    'connections:',
    '  warehouse:',
    '    driver: postgres',
    `    url: "${postgresUrl}"`,
    '    readonly: true',
    'storage:',
    '  state: sqlite',
    '  search: sqlite-fts5',
    'ingest:',
    '  adapters:',
    '    - live-database',
    '',
  ].join('\n');
}

export function buildLiveDatabaseIngestArgs(projectDir, databaseIntrospectionUrl) {
  return [
    'exec',
    'ktx',
    'dev',
    'ingest',
    'run',
    '--project-dir',
    projectDir,
    '--connection-id',
    'warehouse',
    '--adapter',
    'live-database',
    '--database-introspection-url',
    databaseIntrospectionUrl,
  ];
}

export function buildLiveDatabaseStatusArgs(projectDir, runId) {
  return ['exec', 'ktx', 'ingest', 'status', '--project-dir', projectDir, runId];
}

async function run(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 20,
        timeout: options.timeout ?? 60_000,
      },
      (error, stdout, stderr) => {
        if (stdout) {
          process.stdout.write(stdout);
        }
        if (stderr) {
          process.stderr.write(stderr);
        }
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr: stderr || (error instanceof Error ? error.message : ''),
        });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

function requireSuccess(label, result) {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function requireOutput(label, result, pattern) {
  if (!pattern.test(result.stdout)) {
    throw new Error(`${label} output did not match ${pattern}\nstdout:\n${result.stdout}`);
  }
}

function getRunId(stdout) {
  const match = stdout.match(/^Run: (.+)$/m);
  if (!match) {
    throw new Error(`ingest run output did not include a run id\nstdout:\n${stdout}`);
  }
  return match[1];
}

async function requireDocker() {
  const result = await run('docker', ['info'], { timeout: 20_000 });
  if (result.code !== 0) {
    throw new Error(
      'Docker is required for the installed live-database artifact smoke. Start Docker and rerun `pnpm run artifacts:live-db-smoke`.',
    );
  }
}

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('expected TCP server address');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startPostgresContainer(containerName, hostPort) {
  await requireDocker();
  const result = await run('docker', buildDockerRunArgs({ containerName, hostPort }), { timeout: 120_000 });
  requireSuccess('docker run postgres', result);
}

async function stopPostgresContainer(containerName) {
  await run('docker', ['rm', '-f', containerName], { timeout: 30_000 });
}

async function waitForPostgres(containerName) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await run('docker', buildPostgresReadyArgs(containerName), { timeout: 10_000 });
    if (result.code === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Postgres container ${containerName}`);
}

async function seedPostgres(containerName) {
  const result = await run(
    'docker',
    ['exec', '-i', containerName, 'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-v', 'ON_ERROR_STOP=1'],
    { input: buildSeedSql(), timeout: 30_000 },
  );
  requireSuccess('seed postgres catalog', result);
}

function managedRuntimeEnv(cleanInstallDir) {
  return {
    ...process.env,
    KTX_RUNTIME_ROOT: join(cleanInstallDir, 'managed-runtime'),
  };
}

function parseDaemonBaseUrl(stdout) {
  const match = stdout.match(/^url: (http:\/\/127\.0\.0\.1:\d+)$/m);
  if (!match) {
    throw new Error(`Daemon URL was not printed by runtime start:\n${stdout}`);
  }
  return match[1];
}

async function startDaemon(cleanInstallDir) {
  const result = await run('pnpm', ['exec', 'ktx', 'runtime', 'start'], {
    cwd: cleanInstallDir,
    env: managedRuntimeEnv(cleanInstallDir),
    timeout: 120_000,
  });
  requireSuccess('ktx runtime start', result);
  return parseDaemonBaseUrl(result.stdout);
}

async function stopDaemon(cleanInstallDir) {
  await run('pnpm', ['exec', 'ktx', 'runtime', 'stop'], {
    cwd: cleanInstallDir,
    env: managedRuntimeEnv(cleanInstallDir),
    timeout: 30_000,
  });
}

async function assertPathExists(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

async function prepareCleanInstall(layout, cleanInstallDir) {
  await assertPathExists(layout.contextTarball, '@ktx/context tarball');
  await assertPathExists(layout.cliTarball, '@ktx/cli tarball');
  await mkdir(cleanInstallDir, { recursive: true });
  await writeFile(join(cleanInstallDir, 'package.json'), `${JSON.stringify(npmSmokePackageJson(layout), null, 2)}\n`);
  await run('pnpm', ['install'], { cwd: cleanInstallDir, timeout: 120_000 }).then((result) =>
    requireSuccess('pnpm install clean artifact project', result),
  );
  await run('pnpm', ['exec', 'ktx', 'runtime', 'install', '--yes'], {
    cwd: cleanInstallDir,
    env: managedRuntimeEnv(cleanInstallDir),
    timeout: 120_000,
  }).then((result) => requireSuccess('install managed runtime', result));
}

async function main() {
  const layout = packageArtifactLayout();
  const root = await mkdtemp(join(tmpdir(), 'ktx-live-db-artifact-smoke-'));
  const containerName = smokeContainerName();
  let cleanInstallDir;
  let daemonStarted = false;
  try {
    const postgresPort = await getAvailablePort();
    const postgresUrl = buildPostgresUrl(postgresPort);
    cleanInstallDir = join(root, 'npm-clean-install');
    const projectDir = join(root, 'project');

    await startPostgresContainer(containerName, postgresPort);
    await waitForPostgres(containerName);
    await seedPostgres(containerName);
    await prepareCleanInstall(layout, cleanInstallDir);

    await mkdir(projectDir, { recursive: true });
    const init = await run('pnpm', ['exec', 'ktx', 'init', projectDir, '--name', 'artifact-live-database'], {
      cwd: cleanInstallDir,
      timeout: 30_000,
    });
    requireSuccess('ktx init', init);
    await writeFile(join(projectDir, 'ktx.yaml'), buildKtxYaml(postgresUrl), 'utf8');

    const databaseIntrospectionUrl = await startDaemon(cleanInstallDir);
    daemonStarted = true;

    const ingestRun = await run('pnpm', buildLiveDatabaseIngestArgs(projectDir, databaseIntrospectionUrl), {
      cwd: cleanInstallDir,
      env: managedRuntimeEnv(cleanInstallDir),
      timeout: 120_000,
    });
    requireSuccess('ktx dev ingest run live-database', ingestRun);
    requireOutput('ktx dev ingest run live-database', ingestRun, /Status: done/);
    requireOutput('ktx dev ingest run live-database', ingestRun, /Adapter: live-database/);
    requireOutput('ktx dev ingest run live-database', ingestRun, /Diff: \+4\/~0\/-0\/=0/);
    requireOutput('ktx dev ingest run live-database', ingestRun, /Raw files: 4/);
    requireOutput('ktx dev ingest run live-database', ingestRun, /Work units: 2/);

    const runId = getRunId(ingestRun.stdout);
    const ingestStatus = await run('pnpm', buildLiveDatabaseStatusArgs(projectDir, runId), {
      cwd: cleanInstallDir,
      env: managedRuntimeEnv(cleanInstallDir),
      timeout: 30_000,
    });
    requireSuccess('ktx ingest status live-database', ingestStatus);
    requireOutput('ktx ingest status live-database', ingestStatus, new RegExp(`Run: ${runId}`));
    requireOutput('ktx ingest status live-database', ingestStatus, /Status: done/);
    requireOutput('ktx ingest status live-database', ingestStatus, /Raw files: 4/);
    requireOutput('ktx ingest status live-database', ingestStatus, /Work units: 2/);
    await assertPathExists(join(projectDir, '.ktx', 'db.sqlite'), 'SQLite local ingest state');
    process.stdout.write(`Installed live-database artifact smoke passed: ${runId}\n`);
  } finally {
    if (daemonStarted && cleanInstallDir) {
      await stopDaemon(cleanInstallDir);
    }
    await stopPostgresContainer(containerName);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
