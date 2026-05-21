import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { sanitizeChildProxyEnv } from './proxy-env.js';

export interface KtxMcpDaemonState {
  schemaVersion: 1;
  pid: number;
  host: string;
  port: number;
  tokenAuth: boolean;
  projectDir: string;
  startedAt: string;
  logPath: string;
}

/** @internal */
export interface KtxMcpDaemonChild {
  pid?: number;
  unref(): void;
}

export type KtxMcpDaemonStatus =
  | { kind: 'stopped'; detail: string }
  | { kind: 'running'; detail: string; state: KtxMcpDaemonState; url: string }
  | { kind: 'stale'; detail: string; state?: KtxMcpDaemonState };

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tokenAuth: z.boolean(),
  projectDir: z.string().min(1),
  startedAt: z.string().min(1),
  logPath: z.string().min(1),
});

export function mcpDaemonLayout(projectDir: string): { statePath: string; logPath: string } {
  return {
    statePath: join(projectDir, '.ktx/mcp.json'),
    logPath: join(projectDir, '.ktx/logs/mcp.log'),
  };
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function readState(projectDir: string): Promise<KtxMcpDaemonState | undefined> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(mcpDaemonLayout(projectDir).statePath, 'utf8')) as unknown);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeState(projectDir: string, state: KtxMcpDaemonState): Promise<void> {
  const { statePath } = mcpDaemonLayout(projectDir);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function defaultPortAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function defaultSpawnDaemon(
  command: string,
  args: string[],
  options: { detached: boolean; stdio: ['ignore', number, number]; env: NodeJS.ProcessEnv },
): KtxMcpDaemonChild {
  return spawn(command, args, options);
}

async function defaultFetchHealth(state: KtxMcpDaemonState): Promise<{ ok: boolean; body: unknown; detail?: string }> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/health`, {
      headers: { host: `${state.host}:${state.port}` },
    });
    const body = await response.json();
    return { ok: response.ok, body, detail: response.ok ? undefined : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, body: null, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function startKtxMcpDaemon(options: {
  projectDir: string;
  cliVersion: string;
  host: string;
  port: number;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  binPath: string;
  processAlive?: (pid: number) => boolean;
  portAvailable?: (host: string, port: number) => Promise<boolean>;
  spawnDaemon?: typeof defaultSpawnDaemon;
  now?: () => Date;
}): Promise<{ status: 'started' | 'already-running'; state: KtxMcpDaemonState; url: string }> {
  const existing = await readState(options.projectDir).catch(() => undefined);
  const processAlive = options.processAlive ?? defaultProcessAlive;
  if (existing && processAlive(existing.pid)) {
    const sameConfig =
      existing.host === options.host &&
      existing.port === options.port &&
      existing.tokenAuth === Boolean(options.token);
    if (sameConfig) {
      return {
        status: 'already-running',
        state: existing,
        url: `http://${existing.host}:${existing.port}/mcp`,
      };
    }
    throw new Error(
      `KTX MCP daemon is already running at http://${existing.host}:${existing.port}/mcp ` +
        'with a different configuration. Run `ktx mcp stop` first, then start again.',
    );
  }
  const portAvailable = options.portAvailable ?? defaultPortAvailable;
  if (!(await portAvailable(options.host, options.port))) {
    throw new Error(`Port ${options.port} is already in use. Choose another port with --port <n>.`);
  }

  const { logPath } = mcpDaemonLayout(options.projectDir);
  await mkdir(dirname(logPath), { recursive: true });
  const log = await open(logPath, 'a');
  try {
    const args = [
      options.binPath,
      '--project-dir',
      options.projectDir,
      'mcp',
      'serve-internal',
      '--host',
      options.host,
      '--port',
      String(options.port),
      ...options.allowedHosts.flatMap((host) => ['--allowed-host', host]),
      ...options.allowedOrigins.flatMap((origin) => ['--allowed-origin', origin]),
    ];
    const child = (options.spawnDaemon ?? defaultSpawnDaemon)(process.execPath, args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: sanitizeChildProxyEnv({
        ...process.env,
        KTX_CLI_VERSION: options.cliVersion,
        ...(options.token ? { KTX_MCP_TOKEN: options.token } : {}),
      }),
    });
    if (!child.pid) {
      throw new Error('Failed to start KTX MCP daemon: child process pid was not available.');
    }
    child.unref();
    const state: KtxMcpDaemonState = {
      schemaVersion: 1,
      pid: child.pid,
      host: options.host,
      port: options.port,
      tokenAuth: Boolean(options.token),
      projectDir: options.projectDir,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      logPath,
    };
    await writeState(options.projectDir, state);
    return { status: 'started', state, url: `http://${state.host}:${state.port}/mcp` };
  } finally {
    await log.close();
  }
}

export async function readKtxMcpDaemonStatus(options: {
  projectDir: string;
  processAlive?: (pid: number) => boolean;
  fetchHealth?: (state: KtxMcpDaemonState) => Promise<{ ok: boolean; body: unknown; detail?: string }>;
}): Promise<KtxMcpDaemonStatus> {
  let state: KtxMcpDaemonState | undefined;
  try {
    state = await readState(options.projectDir);
  } catch (error) {
    return { kind: 'stale', detail: `MCP daemon state is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!state) {
    return { kind: 'stopped', detail: `No MCP daemon state at ${mcpDaemonLayout(options.projectDir).statePath}` };
  }
  const processAlive = options.processAlive ?? defaultProcessAlive;
  if (!processAlive(state.pid)) {
    return { kind: 'stale', detail: `MCP daemon process ${state.pid} is not running`, state };
  }
  const health = await (options.fetchHealth ?? defaultFetchHealth)(state);
  if (!health.ok) {
    return { kind: 'stale', detail: health.detail ?? 'MCP daemon health check failed', state };
  }
  return {
    kind: 'running',
    detail: `KTX MCP daemon running at http://${state.host}:${state.port}/mcp`,
    state,
    url: `http://${state.host}:${state.port}/mcp`,
  };
}

export async function stopKtxMcpDaemon(options: {
  projectDir: string;
  processAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  pollIntervalMs?: number;
}): Promise<{ status: 'stopped' | 'already-stopped' }> {
  const state = await readState(options.projectDir);
  const { statePath } = mcpDaemonLayout(options.projectDir);
  if (!state) {
    return { status: 'already-stopped' };
  }
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const killProcess = options.killProcess ?? defaultKillProcess;
  if (processAlive(state.pid)) {
    killProcess(state.pid, 'SIGTERM');
    const deadline = Date.now() + (options.stopGraceMs ?? 10_000);
    while (Date.now() <= deadline && processAlive(state.pid)) {
      await delay(options.pollIntervalMs ?? 100);
    }
    if (processAlive(state.pid)) {
      killProcess(state.pid, 'SIGKILL');
    }
  }
  await rm(statePath, { force: true });
  return { status: 'stopped' };
}
