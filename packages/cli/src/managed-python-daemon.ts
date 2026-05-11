import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  installManagedPythonRuntime,
  managedPythonRuntimeLayout,
  runtimeFeatureSchema,
  type KtxRuntimeFeature,
  type ManagedPythonRuntimeInstallOptions,
  type ManagedPythonRuntimeInstallResult,
  type ManagedPythonRuntimeLayout,
  type ManagedPythonRuntimeLayoutOptions,
} from './managed-python-runtime.js';

export interface ManagedPythonDaemonState {
  schemaVersion: 1;
  pid: number;
  host: '127.0.0.1';
  port: number;
  version: string;
  features: KtxRuntimeFeature[];
  startedAt: string;
  stdoutLog: string;
  stderrLog: string;
}

export type ManagedPythonDaemonStatus =
  | { kind: 'stopped'; detail: string; layout: ManagedPythonRuntimeLayout }
  | { kind: 'running'; detail: string; layout: ManagedPythonRuntimeLayout; state: ManagedPythonDaemonState; baseUrl: string }
  | { kind: 'stale'; detail: string; layout: ManagedPythonRuntimeLayout; state?: ManagedPythonDaemonState };

export interface ManagedPythonDaemonStartResult {
  status: 'started' | 'reused';
  layout: ManagedPythonRuntimeLayout;
  state: ManagedPythonDaemonState;
  baseUrl: string;
}

export interface ManagedPythonDaemonStopResult {
  status: 'stopped' | 'already-stopped';
  layout: ManagedPythonRuntimeLayout;
  state?: ManagedPythonDaemonState;
}

export interface ManagedPythonDaemonChild {
  pid?: number;
  unref(): void;
}

export type ManagedPythonDaemonSpawn = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: ['ignore', number, number];
    env: NodeJS.ProcessEnv;
  },
) => ManagedPythonDaemonChild;

export type ManagedPythonDaemonFetch = (
  url: string,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ManagedPythonDaemonStartOptions extends ManagedPythonRuntimeLayoutOptions {
  features: KtxRuntimeFeature[];
  force?: boolean;
  installRuntime?: (options: ManagedPythonRuntimeInstallOptions) => Promise<ManagedPythonRuntimeInstallResult>;
  spawnDaemon?: ManagedPythonDaemonSpawn;
  fetch?: ManagedPythonDaemonFetch;
  allocatePort?: () => Promise<number>;
  processAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  now?: () => Date;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ManagedPythonDaemonStatusOptions extends ManagedPythonRuntimeLayoutOptions {
  fetch?: ManagedPythonDaemonFetch;
  processAlive?: (pid: number) => boolean;
}

export interface ManagedPythonDaemonStopOptions extends ManagedPythonRuntimeLayoutOptions {
  processAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
}

const daemonStateSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  version: z.string().min(1),
  features: z.array(runtimeFeatureSchema).min(1),
  startedAt: z.string().min(1),
  stdoutLog: z.string().min(1),
  stderrLog: z.string().min(1),
});

function normalizeFeatures(features: KtxRuntimeFeature[]): KtxRuntimeFeature[] {
  const requested = new Set<KtxRuntimeFeature>(['core', ...features]);
  return runtimeFeatureSchema.options.filter((feature) => requested.has(feature));
}

function hasFeatures(state: ManagedPythonDaemonState, features: KtxRuntimeFeature[]): boolean {
  return normalizeFeatures(features).every((feature) => state.features.includes(feature));
}

function defaultFetch(url: string): ReturnType<ManagedPythonDaemonFetch> {
  return fetch(url) as ReturnType<ManagedPythonDaemonFetch>;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 'ESRCH') {
      throw error;
    }
  }
}

function defaultSpawnDaemon(
  command: string,
  args: string[],
  options: Parameters<ManagedPythonDaemonSpawn>[2],
): ManagedPythonDaemonChild {
  return spawn(command, args, options);
}

function baseUrl(state: Pick<ManagedPythonDaemonState, 'host' | 'port'>): string {
  return `http://${state.host}:${state.port}`;
}

async function readState(path: string): Promise<ManagedPythonDaemonState | undefined> {
  try {
    return daemonStateSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeState(path: string, state: ManagedPythonDaemonState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function healthOk(input: {
  state: ManagedPythonDaemonState;
  cliVersion: string;
  fetch: ManagedPythonDaemonFetch;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await input.fetch(`${baseUrl(input.state)}/health`);
    if (!response.ok) {
      return { ok: false, detail: `Health check returned HTTP ${response.status}: ${await response.text()}` };
    }
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, detail: 'Health check returned non-object JSON' };
    }
    const record = body as Record<string, unknown>;
    if (record.status !== 'healthy') {
      return { ok: false, detail: `Health check returned status ${String(record.status)}` };
    }
    if (record.version !== input.cliVersion) {
      return {
        ok: false,
        detail: `Daemon version ${String(record.version)} does not match CLI ${input.cliVersion}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function readManagedPythonDaemonStatus(
  options: ManagedPythonDaemonStatusOptions,
): Promise<ManagedPythonDaemonStatus> {
  const layout = managedPythonRuntimeLayout(options);
  let state: ManagedPythonDaemonState | undefined;
  try {
    state = await readState(layout.daemonStatePath);
  } catch (error) {
    return {
      kind: 'stale',
      detail: `Daemon state is invalid: ${error instanceof Error ? error.message : String(error)}`,
      layout,
    };
  }
  if (!state) {
    return { kind: 'stopped', detail: `No daemon state at ${layout.daemonStatePath}`, layout };
  }
  if (state.version !== options.cliVersion) {
    return {
      kind: 'stale',
      detail: `Daemon is for CLI ${state.version}, current CLI is ${options.cliVersion}`,
      layout,
      state,
    };
  }
  const processAlive = options.processAlive ?? defaultProcessAlive;
  if (!processAlive(state.pid)) {
    return { kind: 'stale', detail: `Daemon process ${state.pid} is not running`, layout, state };
  }
  const health = await healthOk({
    state,
    cliVersion: options.cliVersion,
    fetch: options.fetch ?? defaultFetch,
  });
  if (!health.ok) {
    return { kind: 'stale', detail: health.detail, layout, state };
  }
  return { kind: 'running', detail: `Daemon running at ${baseUrl(state)}`, layout, state, baseUrl: baseUrl(state) };
}

export async function allocateDaemonPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
          return;
        }
        reject(new Error('Failed to allocate a daemon port'));
      });
    });
  });
}

async function waitForHealth(input: {
  state: ManagedPythonDaemonState;
  cliVersion: string;
  fetch: ManagedPythonDaemonFetch;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastDetail = 'daemon did not answer health checks';
  while (Date.now() <= deadline) {
    const health = await healthOk({
      state: input.state,
      cliVersion: input.cliVersion,
      fetch: input.fetch,
    });
    if (health.ok) {
      return;
    }
    lastDetail = health.detail;
    await delay(input.pollIntervalMs);
  }
  const finalHealth = await healthOk({
    state: input.state,
    cliVersion: input.cliVersion,
    fetch: input.fetch,
  });
  if (finalHealth.ok) {
    return;
  }
  lastDetail = finalHealth.detail;
  throw new Error(`KTX Python daemon failed to start: ${lastDetail}. stderr: ${input.state.stderrLog}`);
}

async function removeState(layout: ManagedPythonRuntimeLayout): Promise<void> {
  await rm(layout.daemonStatePath, { force: true });
}

async function stopRecordedDaemon(input: {
  layout: ManagedPythonRuntimeLayout;
  state: ManagedPythonDaemonState;
  processAlive: (pid: number) => boolean;
  killProcess: (pid: number) => void;
}): Promise<void> {
  if (input.processAlive(input.state.pid)) {
    input.killProcess(input.state.pid);
  }
  await removeState(input.layout);
}

export async function startManagedPythonDaemon(
  options: ManagedPythonDaemonStartOptions,
): Promise<ManagedPythonDaemonStartResult> {
  const features = normalizeFeatures(options.features);
  const installRuntime = options.installRuntime ?? installManagedPythonRuntime;
  const layoutOverrides = {
    ...(options.runtimeRoot !== undefined ? { runtimeRoot: options.runtimeRoot } : {}),
    ...(options.assetDir !== undefined ? { assetDir: options.assetDir } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  };
  const layout = managedPythonRuntimeLayout({ cliVersion: options.cliVersion, ...layoutOverrides });
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const fetchImpl = options.fetch ?? defaultFetch;

  const status = await readManagedPythonDaemonStatus({
    cliVersion: options.cliVersion,
    ...layoutOverrides,
    fetch: fetchImpl,
    processAlive,
  });
  if (options.force !== true && status.kind === 'running' && hasFeatures(status.state, features)) {
    return { status: 'reused', layout, state: status.state, baseUrl: status.baseUrl };
  }
  if ('state' in status && status.state) {
    await stopRecordedDaemon({ layout, state: status.state, processAlive, killProcess });
  } else {
    await removeState(layout);
  }

  const installed = await installRuntime({
    cliVersion: options.cliVersion,
    ...layoutOverrides,
    features,
    force: false,
  });

  await mkdir(layout.versionDir, { recursive: true });
  const stdout = await open(layout.daemonStdoutPath, 'a');
  const stderr = await open(layout.daemonStderrPath, 'a');
  try {
    const port = await (options.allocatePort ?? allocateDaemonPort)();
    const spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon;
    const child = spawnDaemon(
      installed.manifest.python.daemonExecutable,
      ['serve-http', '--host', '127.0.0.1', '--port', String(port)],
      {
        detached: true,
        stdio: ['ignore', stdout.fd, stderr.fd],
        env: {
          ...process.env,
          KTX_DAEMON_VERSION: options.cliVersion,
        },
      },
    );
    child.unref();
    if (!child.pid) {
      throw new Error(`KTX Python daemon did not report a pid. stderr: ${layout.daemonStderrPath}`);
    }
    const state: ManagedPythonDaemonState = {
      schemaVersion: 1,
      pid: child.pid,
      host: '127.0.0.1',
      port,
      version: options.cliVersion,
      features: installed.manifest.features,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      stdoutLog: layout.daemonStdoutPath,
      stderrLog: layout.daemonStderrPath,
    };
    await waitForHealth({
      state,
      cliVersion: options.cliVersion,
      fetch: fetchImpl,
      timeoutMs: options.startupTimeoutMs ?? 10_000,
      pollIntervalMs: options.pollIntervalMs ?? 100,
    });
    await writeState(layout.daemonStatePath, state);
    return { status: 'started', layout, state, baseUrl: baseUrl(state) };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

export async function stopManagedPythonDaemon(
  options: ManagedPythonDaemonStopOptions,
): Promise<ManagedPythonDaemonStopResult> {
  const layout = managedPythonRuntimeLayout(options);
  const state = await readState(layout.daemonStatePath);
  if (!state) {
    return { status: 'already-stopped', layout };
  }
  await stopRecordedDaemon({
    layout,
    state,
    processAlive: options.processAlive ?? defaultProcessAlive,
    killProcess: options.killProcess ?? defaultKillProcess,
  });
  return { status: 'stopped', layout, state };
}
