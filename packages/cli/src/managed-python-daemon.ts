import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { describeError } from './error-message.js';
import {
  installManagedPythonRuntime,
  managedPythonDaemonLayout,
  runtimeFeatureSchema,
  type KtxRuntimeFeature,
  type ManagedPythonDaemonLayout,
  type ManagedPythonDaemonLayoutOptions,
  type ManagedPythonRuntimeInstallOptions,
  type ManagedPythonRuntimeInstallResult,
} from './managed-python-runtime.js';
import { sanitizeChildProxyEnv } from './proxy-env.js';

export class ManagedPythonDaemonStartError extends Error {
  readonly detail: string;
  readonly stderrLog: string;
  constructor(detail: string, stderrLog: string) {
    super(`ktx daemon failed to start: ${detail}. stderr: ${stderrLog}`);
    this.name = 'ManagedPythonDaemonStartError';
    this.detail = detail;
    this.stderrLog = stderrLog;
  }
}

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
  | { kind: 'stopped'; detail: string; layout: ManagedPythonDaemonLayout }
  | { kind: 'running'; detail: string; layout: ManagedPythonDaemonLayout; state: ManagedPythonDaemonState; baseUrl: string }
  | { kind: 'stale'; detail: string; layout: ManagedPythonDaemonLayout; state?: ManagedPythonDaemonState };

export interface ManagedPythonDaemonStartResult {
  status: 'started' | 'reused';
  layout: ManagedPythonDaemonLayout;
  state: ManagedPythonDaemonState;
  baseUrl: string;
}

export interface ManagedPythonDaemonStopResult {
  status: 'stopped' | 'already-stopped';
  layout: ManagedPythonDaemonLayout;
  state?: ManagedPythonDaemonState;
}

export interface ManagedPythonDaemonProcessInfo {
  pid: number;
  command: string;
}

type ManagedPythonDaemonStopAllSource = 'state' | 'process';

export interface ManagedPythonDaemonStopAllEntry {
  pid: number;
  source: ManagedPythonDaemonStopAllSource;
  url?: string;
  health?: 'healthy' | 'unreachable';
  version?: string;
  command?: string;
  statePaths: string[];
}

export interface ManagedPythonDaemonStopAllFailure extends ManagedPythonDaemonStopAllEntry {
  detail: string;
}

export interface ManagedPythonDaemonStopAllResult {
  stopped: ManagedPythonDaemonStopAllEntry[];
  stale: ManagedPythonDaemonStopAllEntry[];
  failed: ManagedPythonDaemonStopAllFailure[];
  scanErrors: string[];
}

/** @internal */
export interface ManagedPythonDaemonChild {
  pid?: number;
  unref(): void;
}

/** @internal */
export type ManagedPythonDaemonSpawn = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: ['ignore', number, number];
    env: NodeJS.ProcessEnv;
  },
) => ManagedPythonDaemonChild;

/** @internal */
export type ManagedPythonDaemonFetch = (
  url: string,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

type ManagedPythonDaemonKillProcess = (pid: number, signal?: NodeJS.Signals) => void;

export interface ManagedPythonDaemonStartOptions extends ManagedPythonDaemonLayoutOptions {
  features: KtxRuntimeFeature[];
  force?: boolean;
  installRuntime?: (options: ManagedPythonRuntimeInstallOptions) => Promise<ManagedPythonRuntimeInstallResult>;
  spawnDaemon?: ManagedPythonDaemonSpawn;
  fetch?: ManagedPythonDaemonFetch;
  allocatePort?: () => Promise<number>;
  processAlive?: (pid: number) => boolean;
  killProcess?: ManagedPythonDaemonKillProcess;
  now?: () => Date;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ManagedPythonDaemonStatusOptions extends ManagedPythonDaemonLayoutOptions {
  fetch?: ManagedPythonDaemonFetch;
  processAlive?: (pid: number) => boolean;
}

export interface ManagedPythonDaemonStopOptions extends ManagedPythonDaemonLayoutOptions {
  processAlive?: (pid: number) => boolean;
  killProcess?: ManagedPythonDaemonKillProcess;
}

export interface ManagedPythonDaemonStopAllOptions extends ManagedPythonDaemonLayoutOptions {
  listProcesses?: () => Promise<ManagedPythonDaemonProcessInfo[]>;
  processAlive?: (pid: number) => boolean;
  killProcess?: ManagedPythonDaemonKillProcess;
  stopGraceMs?: number;
  pollIntervalMs?: number;
  healthProbeMs?: number;
}

const execFileAsync = promisify(execFile);

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

function defaultKillProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    process.kill(pid, signal);
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
    return { ok: false, detail: describeError(error) };
  }
}

export async function readManagedPythonDaemonStatus(
  options: ManagedPythonDaemonStatusOptions,
): Promise<ManagedPythonDaemonStatus> {
  const layout = managedPythonDaemonLayout(options);
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
  throw new ManagedPythonDaemonStartError(lastDetail, input.state.stderrLog);
}

async function removeState(layout: ManagedPythonDaemonLayout): Promise<void> {
  await rm(layout.daemonStatePath, { force: true });
}

async function stopRecordedDaemon(input: {
  layout: ManagedPythonDaemonLayout;
  state: ManagedPythonDaemonState;
  processAlive: (pid: number) => boolean;
  killProcess: ManagedPythonDaemonKillProcess;
}): Promise<void> {
  if (input.processAlive(input.state.pid)) {
    input.killProcess(input.state.pid);
  }
  await removeState(input.layout);
}

async function removeStatePaths(paths: string[]): Promise<void> {
  await Promise.all([...new Set(paths)].map((path) => rm(path, { force: true })));
}

interface ManagedPythonDaemonStopCandidate {
  pid: number;
  source: ManagedPythonDaemonStopAllSource;
  host?: string;
  port?: number;
  version?: string;
  command?: string;
  statePaths: string[];
}

function candidateUrl(candidate: ManagedPythonDaemonStopCandidate): string | undefined {
  if (!candidate.host || !candidate.port) {
    return undefined;
  }
  return `http://${candidate.host}:${candidate.port}`;
}

function candidateEntry(candidate: ManagedPythonDaemonStopCandidate): ManagedPythonDaemonStopAllEntry {
  return {
    pid: candidate.pid,
    source: candidate.source,
    ...(candidateUrl(candidate) ? { url: candidateUrl(candidate) } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
    ...(candidate.command ? { command: candidate.command } : {}),
    statePaths: [...candidate.statePaths],
  };
}

async function probeCandidateHealth(
  candidate: ManagedPythonDaemonStopCandidate,
  timeoutMs: number,
): Promise<'healthy' | 'unreachable' | undefined> {
  const url = candidateUrl(candidate);
  if (!url) {
    return undefined;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (!response.ok) {
      return 'unreachable';
    }
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return 'unreachable';
    }
    return (body as Record<string, unknown>).status === 'healthy' ? 'healthy' : 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timeout);
  }
}

async function readStateCandidates(statePath: string): Promise<ManagedPythonDaemonStopCandidate[]> {
  let state: ManagedPythonDaemonState | undefined;
  try {
    state = await readState(statePath);
  } catch {
    return [];
  }
  if (!state) {
    return [];
  }
  return [
    {
      pid: state.pid,
      source: 'state',
      host: state.host,
      port: state.port,
      version: state.version,
      statePaths: [statePath],
    },
  ];
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function executableName(token: string): string {
  return token.split(/[\\/]/).at(-1) ?? token;
}

function isKtxDaemonExecutable(token: string): boolean {
  return executableName(token) === 'ktx-daemon' || executableName(token) === 'ktx-daemon.exe';
}

function normalizedExecutableName(token: string): string {
  return executableName(token).replace(/\.exe$/i, '').toLowerCase();
}

function hasUvRunPrefix(tokens: string[], daemonIndex: number): boolean {
  return normalizedExecutableName(tokens[0] ?? '') === 'uv' && tokens.slice(1, daemonIndex).includes('run');
}

function isPythonExecutable(token: string): boolean {
  const name = normalizedExecutableName(token);
  return name === 'python' || name === 'python3';
}

function hasPythonModulePrefix(tokens: string[], moduleFlagIndex: number): boolean {
  if (moduleFlagIndex === 1 && isPythonExecutable(tokens[0] ?? '')) {
    return true;
  }
  return (
    normalizedExecutableName(tokens[0] ?? '') === 'uv' &&
    tokens.slice(1, moduleFlagIndex).includes('run') &&
    tokens.some((token, index) => index < moduleFlagIndex && isPythonExecutable(token))
  );
}

function isKtxDaemonServeHttp(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      isKtxDaemonExecutable(tokens[index] ?? '') &&
      tokens[index + 1] === 'serve-http' &&
      (index === 0 || hasUvRunPrefix(tokens, index))
    ) {
      return true;
    }
    if (
      tokens[index] === '-m' &&
      tokens[index + 1] === 'ktx_daemon' &&
      tokens[index + 2] === 'serve-http' &&
      hasPythonModulePrefix(tokens, index)
    ) {
      return true;
    }
  }
  return false;
}

function parseCommandOption(tokens: string[], option: string): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === option) {
      return tokens[index + 1];
    }
    if (token?.startsWith(`${option}=`)) {
      return token.slice(option.length + 1);
    }
  }
  return undefined;
}

function processCandidate(processInfo: ManagedPythonDaemonProcessInfo): ManagedPythonDaemonStopCandidate | undefined {
  const tokens = tokenizeCommand(processInfo.command);
  if (!isKtxDaemonServeHttp(tokens)) {
    return undefined;
  }
  const host = parseCommandOption(tokens, '--host') ?? '127.0.0.1';
  const rawPort = parseCommandOption(tokens, '--port');
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : 8765;
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 8765;
  return {
    pid: processInfo.pid,
    source: 'process',
    host,
    port,
    command: processInfo.command,
    statePaths: [],
  };
}

function mergeCandidates(candidates: ManagedPythonDaemonStopCandidate[]): ManagedPythonDaemonStopCandidate[] {
  const byPid = new Map<number, ManagedPythonDaemonStopCandidate>();
  for (const candidate of candidates) {
    const existing = byPid.get(candidate.pid);
    if (!existing) {
      byPid.set(candidate.pid, { ...candidate, statePaths: [...candidate.statePaths] });
      continue;
    }
    existing.statePaths.push(...candidate.statePaths);
    if (existing.source === 'process' && candidate.source === 'state') {
      byPid.set(candidate.pid, {
        ...candidate,
        statePaths: [...new Set([...existing.statePaths, ...candidate.statePaths])],
      });
    } else {
      existing.statePaths = [...new Set(existing.statePaths)];
    }
  }
  return [...byPid.values()].sort((left, right) => left.pid - right.pid);
}

function parsePosixProcessList(output: string): ManagedPythonDaemonProcessInfo[] {
  const processes: ManagedPythonDaemonProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    processes.push({ pid: Number.parseInt(match[1], 10), command: match[2] });
  }
  return processes;
}

function parseWindowsProcessList(output: string): ManagedPythonDaemonProcessInfo[] {
  if (!output.trim()) {
    return [];
  }
  const parsed = JSON.parse(output) as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const processes: ManagedPythonDaemonProcessInfo[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    const value = record as Record<string, unknown>;
    const pid = value.ProcessId;
    const command = value.CommandLine;
    if (typeof pid === 'number' && typeof command === 'string' && command.length > 0) {
      processes.push({ pid, command });
    }
  }
  return processes;
}

async function defaultListProcesses(platform: NodeJS.Platform = process.platform): Promise<ManagedPythonDaemonProcessInfo[]> {
  if (platform === 'win32') {
    const command = [
      'Get-CimInstance Win32_Process',
      '| Where-Object { $_.CommandLine -ne $null }',
      '| Select-Object ProcessId,CommandLine',
      '| ConvertTo-Json -Compress',
    ].join(' ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseWindowsProcessList(stdout);
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return parsePosixProcessList(stdout);
}

async function waitUntilStopped(input: {
  pid: number;
  processAlive: (pid: number) => boolean;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  do {
    if (!input.processAlive(input.pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(input.pollIntervalMs);
  } while (Date.now() <= deadline);
  return !input.processAlive(input.pid);
}

async function discoverStopAllCandidates(
  options: ManagedPythonDaemonStopAllOptions,
): Promise<{
  layout: ManagedPythonDaemonLayout;
  candidates: ManagedPythonDaemonStopCandidate[];
  scanErrors: string[];
}> {
  const layout = managedPythonDaemonLayout(options);
  const stateCandidates = await readStateCandidates(layout.daemonStatePath);
  const scanErrors: string[] = [];
  let processCandidates: ManagedPythonDaemonStopCandidate[] = [];
  try {
    const processes = await (options.listProcesses ?? defaultListProcesses)();
    processCandidates = processes.flatMap((processInfo) => {
      const candidate = processCandidate(processInfo);
      return candidate ? [candidate] : [];
    });
  } catch (error) {
    scanErrors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    layout,
    candidates: mergeCandidates([...stateCandidates, ...processCandidates]),
    scanErrors,
  };
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
  const layout = managedPythonDaemonLayout({
    cliVersion: options.cliVersion,
    projectDir: options.projectDir,
    ...layoutOverrides,
  });
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const fetchImpl = options.fetch ?? defaultFetch;

  const status = await readManagedPythonDaemonStatus({
    cliVersion: options.cliVersion,
    projectDir: options.projectDir,
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

  await mkdir(layout.daemonStateDir, { recursive: true });
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
        env: sanitizeChildProxyEnv({
          ...process.env,
          KTX_DAEMON_VERSION: options.cliVersion,
        }),
      },
    );
    child.unref();
    if (!child.pid) {
      throw new Error(`ktx daemon did not report a pid. stderr: ${layout.daemonStderrPath}`);
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
    try {
      await waitForHealth({
        state,
        cliVersion: options.cliVersion,
        fetch: fetchImpl,
        timeoutMs: options.startupTimeoutMs ?? 30_000,
        pollIntervalMs: options.pollIntervalMs ?? 100,
      });
    } catch (error) {
      if (processAlive(state.pid)) {
        killProcess(state.pid);
      }
      await removeState(layout);
      throw error;
    }
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
  const layout = managedPythonDaemonLayout(options);
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

export async function stopAllManagedPythonDaemons(
  options: ManagedPythonDaemonStopAllOptions,
): Promise<ManagedPythonDaemonStopAllResult> {
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const stopGraceMs = options.stopGraceMs ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const healthProbeMs = options.healthProbeMs ?? 100;
  const discovery = await discoverStopAllCandidates(options);
  const stopped: ManagedPythonDaemonStopAllEntry[] = [];
  const stale: ManagedPythonDaemonStopAllEntry[] = [];
  const failed: ManagedPythonDaemonStopAllFailure[] = [];

  for (const candidate of discovery.candidates) {
    const health = await probeCandidateHealth(candidate, healthProbeMs);
    const entry = { ...candidateEntry(candidate), ...(health ? { health } : {}) };
    if (!processAlive(candidate.pid)) {
      await removeStatePaths(candidate.statePaths);
      stale.push(entry);
      continue;
    }
    try {
      killProcess(candidate.pid, 'SIGTERM');
      if (
        !(await waitUntilStopped({
          pid: candidate.pid,
          processAlive,
          timeoutMs: stopGraceMs,
          pollIntervalMs,
        }))
      ) {
        killProcess(candidate.pid, 'SIGKILL');
        if (
          !(await waitUntilStopped({
            pid: candidate.pid,
            processAlive,
            timeoutMs: stopGraceMs,
            pollIntervalMs,
          }))
        ) {
          failed.push({ ...entry, detail: 'Process still running after SIGKILL' });
          continue;
        }
      }
      await removeStatePaths(candidate.statePaths);
      stopped.push(entry);
    } catch (error) {
      failed.push({ ...entry, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    stopped,
    stale,
    failed,
    scanErrors: discovery.scanErrors,
  };
}
