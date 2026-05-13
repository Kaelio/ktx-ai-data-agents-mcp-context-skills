import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  PUBLIC_NPM_PACKAGE_NAME,
  PUBLIC_NPM_PACKAGE_VERSION,
} from './build-public-npm-package.mjs';
import { npmSmokePnpmWorkspaceYaml } from './package-artifacts.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(SCRIPT_DIR, '..');
const PUBLIC_NPM_ARTIFACT_DIR = join('dist', 'artifacts', 'npm');
const OPT_IN_MESSAGE =
  'Set KTX_RUN_LOCAL_EMBEDDINGS_SMOKE=1 or pass --force to run the local embeddings smoke.';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function expectedPublicKtxVersionPattern() {
  return new RegExp(
    `${escapeRegExp(PUBLIC_NPM_PACKAGE_NAME)} ${escapeRegExp(PUBLIC_NPM_PACKAGE_VERSION)}`,
  );
}

export function localEmbeddingsSmokeOptIn(env = process.env, args = process.argv.slice(2)) {
  if (env.KTX_RUN_LOCAL_EMBEDDINGS_SMOKE === '1' || args.includes('--force')) {
    return { run: true };
  }
  return { run: false, message: OPT_IN_MESSAGE };
}

export function publicKtxTarballName(files) {
  const matches = files.filter((file) => /^kaelio-ktx-.+\.tgz$/.test(file)).sort();
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one @kaelio/ktx tarball in ${PUBLIC_NPM_ARTIFACT_DIR}, found ${matches.length}: ${
        matches.join(', ') || 'none'
      }. Run pnpm run artifacts:build first.`,
    );
  }
  return matches[0];
}

export async function selectPublicKtxTarball(rootDir = DEFAULT_ROOT_DIR) {
  const npmArtifactDir = join(rootDir, PUBLIC_NPM_ARTIFACT_DIR);
  const files = await readdir(npmArtifactDir);
  return join(npmArtifactDir, publicKtxTarballName(files));
}

export function buildLocalEmbeddingsSmokeEnv(root, baseEnv = process.env) {
  return {
    ...baseEnv,
    KTX_RUN_LOCAL_EMBEDDINGS_SMOKE: '1',
    KTX_RUNTIME_ROOT: join(root, 'managed-runtime'),
    HF_HOME: join(root, 'hf-home'),
    TRANSFORMERS_CACHE: join(root, 'transformers-cache'),
    SENTENCE_TRANSFORMERS_HOME: join(root, 'sentence-transformers-home'),
    TORCH_HOME: join(root, 'torch-home'),
  };
}

export function localEmbeddingsSmokeCommands(input) {
  return [
    {
      label: 'ktx public package version',
      command: 'pnpm',
      args: ['exec', 'ktx', '--version'],
      timeoutMs: 60_000,
    },
    {
      label: 'ktx dev runtime status missing',
      command: 'pnpm',
      args: ['exec', 'ktx', 'dev', 'runtime', 'status', '--json'],
      timeoutMs: 60_000,
    },
    {
      label: 'ktx dev runtime install local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'dev', 'runtime', 'install', '--feature', 'local-embeddings', '--yes'],
      timeoutMs: 1_200_000,
    },
    {
      label: 'ktx dev runtime status local embeddings ready',
      command: 'pnpm',
      args: ['exec', 'ktx', 'dev', 'runtime', 'status', '--json'],
      timeoutMs: 60_000,
    },
    {
      label: 'ktx dev runtime start local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'dev', 'runtime', 'start', '--feature', 'local-embeddings'],
      timeoutMs: 300_000,
    },
    {
      label: 'ktx setup local embeddings',
      command: 'pnpm',
      args: [
        'exec',
        'ktx',
        'setup',
        '--project-dir',
        input.projectDir,
        '--new',
        '--no-input',
        '--yes',
        '--skip-llm',
        '--embedding-backend',
        'sentence-transformers',
        '--skip-databases',
        '--skip-sources',
        '--skip-agents',
      ],
      timeoutMs: 900_000,
    },
    {
      label: 'ktx dev runtime stop local embeddings',
      command: 'pnpm',
      args: ['exec', 'ktx', 'dev', 'runtime', 'stop'],
      timeoutMs: 60_000,
    },
  ];
}

export function parseDaemonBaseUrl(stdout) {
  const match = stdout.match(/^url: (http:\/\/127\.0\.0\.1:\d+)$/m);
  if (!match) {
    throw new Error(`Daemon URL was not printed by runtime start:\n${stdout}`);
  }
  return match[1];
}

export function validateEmbeddingResponse(raw, expectedDimensions) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Embedding response must be a JSON object');
  }
  const embedding = raw.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('Embedding response must include an embedding array');
  }
  if (embedding.length !== expectedDimensions) {
    throw new Error(`Expected embedding dimension ${expectedDimensions}, got ${embedding.length}`);
  }
  for (const [index, value] of embedding.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Embedding value at index ${index} is not a finite number`);
    }
  }
}

async function run(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      timeout: options.timeoutMs ?? 120_000,
    });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : error.message;
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout,
      stderr,
    };
  }
}

function requireSuccess(label, result, options = {}) {
  if (result.code !== 0) {
    throw new Error(`${label} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (options.stderrPattern && !options.stderrPattern.test(result.stderr)) {
    throw new Error(`${label} stderr did not match ${options.stderrPattern}\nstderr:\n${result.stderr}`);
  }
}

function parseJsonStdout(label, result) {
  requireSuccess(label, result);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not write JSON stdout: ${error.message}\nstdout:\n${result.stdout}`);
  }
}

function parseJsonStdoutWithExitCode(label, result, expectedCode) {
  if (result.code !== expectedCode) {
    throw new Error(`${label} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not write JSON stdout: ${error.message}\nstdout:\n${result.stdout}`);
  }
}

function requireOutput(label, result, pattern) {
  if (!pattern.test(result.stdout)) {
    throw new Error(`${label} stdout did not match ${pattern}\nstdout:\n${result.stdout}`);
  }
}

async function postJson(baseUrl, path, payload, timeoutMs) {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`POST ${path} returned non-JSON response: ${error.message}\n${text}`);
  }
}

async function writeSmokePackage(projectDir, tarballPath) {
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'ktx-local-embeddings-runtime-smoke',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@kaelio/ktx': `file:${tarballPath}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(projectDir, 'pnpm-workspace.yaml'), npmSmokePnpmWorkspaceYaml());
}

export async function runLocalEmbeddingsRuntimeSmoke(options = {}) {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const tarballPath = options.tarballPath ?? (await selectPublicKtxTarball(rootDir));
  const root = await mkdtemp(join(tmpdir(), 'ktx-local-embeddings-smoke-'));
  const keepTemp = options.keepTemp ?? process.env.KTX_KEEP_LOCAL_EMBEDDINGS_SMOKE === '1';
  const installDir = join(root, 'installed-package');
  const projectDir = join(root, 'project');
  const smokeEnv = buildLocalEmbeddingsSmokeEnv(root);
  const commands = localEmbeddingsSmokeCommands({ projectDir });
  let daemonStarted = false;

  try {
    await writeSmokePackage(installDir, tarballPath);
    requireSuccess(
      'pnpm install public package',
      await run('pnpm', ['install', '--ignore-scripts=false'], {
        cwd: installDir,
        env: smokeEnv,
        timeoutMs: 300_000,
      }),
    );

    const version = await run(commands[0].command, commands[0].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[0].timeoutMs,
    });
    requireSuccess(commands[0].label, version);
    requireOutput(commands[0].label, version, expectedPublicKtxVersionPattern());

    const missingStatus = parseJsonStdoutWithExitCode(
      commands[1].label,
      await run(commands[1].command, commands[1].args, {
        cwd: installDir,
        env: smokeEnv,
        timeoutMs: commands[1].timeoutMs,
      }),
      1,
    );
    if (missingStatus.kind !== 'missing') {
      throw new Error(`Expected missing runtime before install, got ${JSON.stringify(missingStatus)}`);
    }

    const install = await run(commands[2].command, commands[2].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[2].timeoutMs,
    });
    requireSuccess(commands[2].label, install);
    requireOutput(commands[2].label, install, /Installed KTX Python runtime/);
    requireOutput(commands[2].label, install, /features: core, local-embeddings/);

    const readyStatus = parseJsonStdout(
      commands[3].label,
      await run(commands[3].command, commands[3].args, {
        cwd: installDir,
        env: smokeEnv,
        timeoutMs: commands[3].timeoutMs,
      }),
    );
    if (readyStatus.kind !== 'ready') {
      throw new Error(`Expected ready runtime after install, got ${JSON.stringify(readyStatus)}`);
    }
    if (!readyStatus.manifest?.features?.includes('local-embeddings')) {
      throw new Error(`Runtime manifest did not include local-embeddings: ${JSON.stringify(readyStatus.manifest)}`);
    }

    const start = await run(commands[4].command, commands[4].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[4].timeoutMs,
    });
    requireSuccess(commands[4].label, start);
    daemonStarted = true;
    const baseUrl = parseDaemonBaseUrl(start.stdout);

    const embeddingResponse = await postJson(
      baseUrl,
      '/embeddings/compute',
      { text: 'KTX local embeddings release smoke' },
      900_000,
    );
    validateEmbeddingResponse(embeddingResponse, 384);
    process.stdout.write('KTX local embeddings daemon computed a 384-dimensional embedding\n');

    const setup = await run(commands[5].command, commands[5].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[5].timeoutMs,
    });
    requireSuccess(commands[5].label, setup);
    requireOutput(commands[5].label, setup, /Embeddings ready: yes \(all-MiniLM-L6-v2\)/);

    const config = await readFile(join(projectDir, 'ktx.yaml'), 'utf8');
    if (!config.includes('base_url: managed:local-embeddings')) {
      throw new Error(`ktx.yaml did not contain managed local embeddings marker:\n${config}`);
    }
    process.stdout.write('KTX setup persisted managed local embeddings marker\n');

    const stop = await run(commands[6].command, commands[6].args, {
      cwd: installDir,
      env: smokeEnv,
      timeoutMs: commands[6].timeoutMs,
    });
    requireSuccess(commands[6].label, stop);
    daemonStarted = false;
    requireOutput(commands[6].label, stop, /Stopped KTX Python daemon/);

    process.stdout.write('KTX local embeddings runtime smoke verified\n');
  } finally {
    if (daemonStarted) {
      await run('pnpm', ['exec', 'ktx', 'dev', 'runtime', 'stop'], {
        cwd: installDir,
        env: smokeEnv,
        timeoutMs: 60_000,
      });
    }
    if (!keepTemp) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stdout.write(`Kept local embeddings smoke root: ${root}\n`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const optIn = localEmbeddingsSmokeOptIn(process.env, args);
  if (!optIn.run) {
    process.stdout.write(`Skipping KTX local embeddings runtime smoke. ${optIn.message}\n`);
    if (args.includes('--require-opt-in')) {
      process.exitCode = 1;
    }
    return;
  }

  await runLocalEmbeddingsRuntimeSmoke();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
