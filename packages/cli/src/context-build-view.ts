import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KtxCliIo } from './index.js';
import type {
  KtxPublicIngestArgs,
  KtxPublicIngestPlanTarget,
  KtxPublicIngestProject,
  KtxPublicIngestTargetResult,
} from './public-ingest.js';
import { buildPublicIngestPlan, executePublicIngestTarget } from './public-ingest.js';
import { formatDuration } from './demo-metrics.js';
import { profileMark } from './startup-profile.js';

profileMark('module:context-build-view');

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const ESC = String.fromCharCode(0x1b);

export interface ContextBuildTargetState {
  target: KtxPublicIngestPlanTarget;
  status: 'queued' | 'running' | 'done' | 'failed';
  detailLine: string | null;
  summaryText: string | null;
  failureText: string | null;
  startedAt: number | null;
  elapsedMs: number;
}

export interface ContextBuildViewState {
  primarySources: ContextBuildTargetState[];
  contextSources: ContextBuildTargetState[];
  frame: number;
  startedAt: number | null;
  totalElapsedMs: number;
}

export interface ContextBuildArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  scanMode?: 'structural' | 'enriched';
  detectRelationships?: boolean;
}

export interface ContextBuildResult {
  exitCode: number;
  detached: boolean;
  reportIds?: string[];
  artifactPaths?: string[];
}

export interface ContextBuildSourceProgressUpdate {
  connectionId: string;
  operation: 'scan' | 'source-ingest';
  status: 'queued' | 'running' | 'done' | 'failed';
  startedAtMs?: number;
  elapsedMs?: number;
  summaryText?: string;
}

export interface ContextBuildDeps {
  executeTarget?: typeof executePublicIngestTarget;
  now?: () => number;
  setupKeystroke?: (onDetach: () => void, onCtrlC: () => void) => (() => void) | null;
  onDetach?: () => void;
  onSourceProgress?: (sources: ContextBuildSourceProgressUpdate[]) => void;
}

// --- Rendering ---

function green(text: string): string {
  return `${ESC}[32m${text}${ESC}[39m`;
}

function red(text: string): string {
  return `${ESC}[31m${text}${ESC}[39m`;
}

function cyan(text: string): string {
  return `${ESC}[36m${text}${ESC}[39m`;
}

function dim(text: string): string {
  return `${ESC}[2m${text}${ESC}[22m`;
}

function statusIcon(status: ContextBuildTargetState['status'], frame: number, styled: boolean): string {
  if (!styled) {
    switch (status) {
      case 'done':
        return '✓';
      case 'failed':
        return '✗';
      case 'running':
        return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '⠋';
      default:
        return '○';
    }
  }
  switch (status) {
    case 'done':
      return green('✓');
    case 'failed':
      return red('✗');
    case 'running':
      return cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '⠋');
    default:
      return dim('○');
  }
}

function extractPercent(detailLine: string | null): number | null {
  if (!detailLine) return null;
  const match = detailLine.match(/^\[(\d+)%\]/);
  return match ? Number(match[1]) : null;
}

const BAR_WIDTH = 12;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

function renderProgressBar(percent: number, styled: boolean): string {
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(empty)}`;
  return styled ? cyan(bar) : bar;
}

function targetDetail(target: ContextBuildTargetState, styled: boolean): string {
  if (target.status === 'done') {
    const parts: string[] = [];
    if (target.summaryText) parts.push(target.summaryText);
    parts.push(formatDuration(target.elapsedMs));
    return parts.join(' · ');
  }
  if (target.status === 'failed') {
    const failureText = target.failureText ?? 'failed';
    return styled ? red(failureText) : failureText;
  }
  if (target.status === 'running') {
    const percent = extractPercent(target.detailLine);
    const progressText = target.detailLine?.replace(/^\[\d+%\]\s*/, '')
      ?? (target.target.operation === 'scan' ? 'scanning...' : 'ingesting...');
    const elapsed = target.elapsedMs > 0 ? `(${formatDuration(target.elapsedMs)})` : null;
    const parts: string[] = [];
    if (percent !== null) {
      parts.push(`${renderProgressBar(percent, styled)} ${percent}%`);
    }
    parts.push(progressText);
    if (elapsed) parts.push(styled ? dim(elapsed) : elapsed);
    return parts.join('  ');
  }
  return styled ? dim('queued') : 'queued';
}

function columnWidth(state: ContextBuildViewState): number {
  const all = [...state.primarySources, ...state.contextSources];
  return Math.max(12, ...all.map((t) => t.target.connectionId.length)) + 2;
}

function renderTargetLine(target: ContextBuildTargetState, frame: number, styled: boolean, width: number): string {
  return `    ${statusIcon(target.status, frame, styled)} ${target.target.connectionId.padEnd(width)} ${targetDetail(target, styled)}`;
}

function renderTargetGroup(
  label: string,
  targets: ContextBuildTargetState[],
  frame: number,
  styled: boolean,
  width: number,
): string[] {
  if (targets.length === 0) return [];
  return ['', `  ${label}:`, ...targets.map((t) => renderTargetLine(t, frame, styled, width))];
}

function resumeCommand(projectDir?: string): string {
  return projectDir ? `ktx setup --project-dir ${projectDir}` : 'ktx setup';
}

export function renderContextBuildView(
  state: ContextBuildViewState,
  options: { styled?: boolean; showHint?: boolean; hintText?: string; projectDir?: string } = {},
): string {
  const styled = options.styled ?? true;
  const width = columnWidth(state);
  const allTargets = [...state.primarySources, ...state.contextSources];
  const doneCount = allTargets.filter((t) => t.status === 'done' || t.status === 'failed').length;
  const totalCount = allTargets.length;
  const hasActive = allTargets.some((t) => t.status === 'running' || t.status === 'queued');
  const allDone = totalCount > 0 && !hasActive;

  const headerParts = ['Building KTX context'];
  if (totalCount > 0) {
    const progressParts: string[] = [`${doneCount}/${totalCount}`];
    if (state.totalElapsedMs > 0) progressParts.push(formatDuration(state.totalElapsedMs));
    const progress = `(${progressParts.join(' · ')})`;
    headerParts.push(styled ? dim(progress) : progress);
  }
  const header = headerParts.join('  ');
  const headerPlainLength = header.replace(/\x1b\[[0-9;]*m/g, '').length;
  const separator = '─'.repeat(Math.max(21, headerPlainLength));

  const lines: string[] = [
    '',
    header,
    separator,
    ...renderTargetGroup('Primary sources', state.primarySources, state.frame, styled, width),
    ...renderTargetGroup('Context sources', state.contextSources, state.frame, styled, width),
    '',
  ];

  if (allDone && state.totalElapsedMs > 0) {
    const sourcesLabel = totalCount === 1 ? '1 source' : `${totalCount} sources`;
    const summary = `  Done in ${formatDuration(state.totalElapsedMs)} · ${sourcesLabel} processed`;
    lines.push(styled ? green(summary) : summary);
    lines.push('');
  }

  if (options.showHint && hasActive) {
    const hintContent = options.hintText ?? `d to detach · ${resumeCommand(options.projectDir)} to resume`;
    const hint = `  ${hintContent}`;
    lines.push(styled ? dim(hint) : hint);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// --- IO Capture ---

const ESC_K_RE = new RegExp(`${ESC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[K`, 'g');
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function extractProgressMessage(chunk: string): string | null {
  const cleaned = chunk.replace(/^\r/, '').replace(ESC_K_RE, '').replace(/\n$/, '').trim();
  const match = cleaned.match(/^\[(\d+)%\]\s*(.+)$/);
  return match ? `[${match[1]}%] ${match[2]}` : null;
}

export function parseScanSummary(output: string): string | null {
  const match = output.match(/(\d+) changes? across (\d+) tables?/);
  return match ? `${match[2]} tables` : null;
}

export function parseIngestSummary(output: string): string | null {
  const savedMemory = output.match(/Saved memory: (.+)/);
  if (savedMemory) return savedMemory[1];
  const workUnits = output.match(/Work units: (\d+)/);
  if (workUnits) return `${workUnits[1]} work units`;
  return null;
}

function collectOutputMetadata(
  output: string,
  operation: KtxPublicIngestPlanTarget['operation'],
): { reportIds: string[]; artifactPaths: string[] } {
  const reportIds = new Set<string>();
  const artifactPaths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const reportLine = trimmed.match(/^Report:\s*(.+)$/);
    if (reportLine) {
      const value = reportLine[1].trim();
      if (value && value !== 'none') {
        if (operation === 'scan') artifactPaths.add(value);
        else reportIds.add(value);
      }
    }
    const rawSourcesLine = trimmed.match(/^Raw sources:\s*(.+)$/);
    if (rawSourcesLine) {
      const value = rawSourcesLine[1].trim();
      if (value && value !== 'none') artifactPaths.add(value);
    }
    if (operation === 'source-ingest') {
      for (const match of trimmed.matchAll(/\breport=([^\s]+)/g)) {
        reportIds.add(match[1]);
      }
    }
  }
  return { reportIds: [...reportIds], artifactPaths: [...artifactPaths] };
}

interface CapturedIo {
  io: KtxCliIo;
  captured(): string;
}

function createCaptureIo(onProgress: (message: string) => void, isTTY: boolean): CapturedIo {
  let buffer = '';
  return {
    io: {
      stdout: {
        isTTY,
        write(chunk: string) {
          buffer += chunk;
          const progress = extractProgressMessage(chunk);
          if (progress) onProgress(progress);
        },
      },
      stderr: {
        write(chunk: string) {
          buffer += chunk;
        },
      },
    },
    captured: () => buffer,
  };
}

// --- Source progress helpers ---

function collectSourceProgress(targets: ContextBuildTargetState[]): ContextBuildSourceProgressUpdate[] {
  return targets.map((t) => ({
    connectionId: t.target.connectionId,
    operation: t.target.operation,
    status: t.status,
    ...(t.startedAt !== null ? { startedAtMs: t.startedAt } : {}),
    ...(t.elapsedMs > 0 ? { elapsedMs: t.elapsedMs } : {}),
    ...(t.summaryText ? { summaryText: t.summaryText } : {}),
  }));
}

export function viewStateFromSourceProgress(
  sources: ContextBuildSourceProgressUpdate[],
  now: number,
  startedAtMs?: number,
): ContextBuildViewState {
  const makeTarget = (s: ContextBuildSourceProgressUpdate): ContextBuildTargetState => ({
    target: { connectionId: s.connectionId, driver: '', operation: s.operation, debugCommand: '', steps: [] },
    status: s.status,
    detailLine: null,
    summaryText: s.summaryText ?? null,
    failureText: null,
    startedAt: s.startedAtMs ?? null,
    elapsedMs: s.status === 'running' && s.startedAtMs ? now - s.startedAtMs : (s.elapsedMs ?? 0),
  });

  return {
    primarySources: sources.filter((s) => s.operation === 'scan').map(makeTarget),
    contextSources: sources.filter((s) => s.operation === 'source-ingest').map(makeTarget),
    frame: 0,
    startedAt: startedAtMs ?? null,
    totalElapsedMs: startedAtMs ? now - startedAtMs : 0,
  };
}

// --- Repaint ---

export function createRepainter(io: KtxCliIo) {
  let hasPainted = false;
  let lastCursorUpRows = 0;

  const terminalColumns = () => {
    for (const columns of [io.stdout.columns, process.stdout.columns]) {
      if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) return columns;
    }
    return 80;
  };

  const visualRows = (line: string, columns: number) => {
    const plainLength = line.replace(ANSI_RE, '').length;
    return Math.max(1, Math.ceil(plainLength / columns));
  };

  const cursorUpRowsAfterWrite = (content: string) => {
    const columns = terminalColumns();
    const endsWithNewline = content.endsWith('\n');
    const lines = content.split('\n');
    return lines.reduce((sum, line, index) => {
      if (index === lines.length - 1) {
        return endsWithNewline ? sum : sum + Math.max(0, visualRows(line, columns) - 1);
      }
      return sum + visualRows(line, columns);
    }, 0);
  };

  return {
    paint(content: string) {
      if (hasPainted) {
        if (lastCursorUpRows > 0) {
          io.stdout.write(`${ESC}[${lastCursorUpRows}A`);
        }
        io.stdout.write('\r');
      }
      io.stdout.write(`${ESC}[2K`);
      io.stdout.write(content.replaceAll('\n', `\n${ESC}[2K`));
      io.stdout.write(`${ESC}[J`);
      hasPainted = true;
      lastCursorUpRows = cursorUpRowsAfterWrite(content);
    },
  };
}

// --- Background build ---

function resolveKtxEntryScript(): string | null {
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith('.js') || argv1.endsWith('.ts') || argv1.endsWith('.mjs'))) {
    return argv1;
  }
  return null;
}

function spawnBackgroundBuild(projectDir: string): { logPath: string } | null {
  const entryScript = resolveKtxEntryScript();
  if (!entryScript) return null;

  const resolvedDir = resolve(projectDir);
  const logDir = join(resolvedDir, '.ktx', 'setup');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'context-build.log');
  const logFd = openSync(logPath, 'w');

  const child = spawn(
    process.execPath,
    [entryScript, 'setup', 'context', 'build', '--project-dir', resolvedDir, '--no-input'],
    { detached: true, stdio: ['ignore', logFd, logFd] },
  );
  child.unref();
  return { logPath };
}

// --- Keystroke handling ---

export function defaultSetupKeystroke(onDetach: () => void, onCtrlC: () => void): (() => void) | null {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return null;
  }
  stdin.setRawMode(true);
  stdin.resume();
  const onData = (data: Buffer) => {
    const char = data.toString();
    if (char === 'd' || char === 'D') onDetach();
    else if (char === '\x03') onCtrlC();
  };
  stdin.on('data', onData);
  return () => {
    stdin.off('data', onData);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    stdin.pause();
  };
}

// --- Orchestration ---

function makeTargetState(target: KtxPublicIngestPlanTarget): ContextBuildTargetState {
  return {
    target,
    status: 'queued',
    detailLine: null,
    summaryText: null,
    failureText: null,
    startedAt: null,
    elapsedMs: 0,
  };
}

const NETWORK_ERROR_REASONS: Record<string, string> = {
  EADDRNOTAVAIL: 'network address unavailable',
  ECONNRESET: 'connection reset',
  ECONNREFUSED: 'connection refused',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'host not found',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'host unreachable',
};

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function networkErrorCodeFromText(text: string): string | null {
  for (const code of Object.keys(NETWORK_ERROR_REASONS)) {
    if (new RegExp(`\\b${code}\\b`).test(text)) {
      return code;
    }
  }
  return null;
}

function networkErrorCode(error: unknown, capturedOutput = ''): string | null {
  const directCode = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : null;
  if (directCode && NETWORK_ERROR_REASONS[directCode]) {
    return directCode;
  }
  return networkErrorCodeFromText(`${unknownErrorMessage(error)}\n${capturedOutput}`);
}

function friendlyDriverName(driver: string): string {
  const normalized = driver.toLowerCase();
  if (normalized === 'postgres' || normalized === 'postgresql') return 'PostgreSQL';
  if (normalized === 'mysql') return 'MySQL';
  if (normalized === 'sqlserver') return 'SQL Server';
  if (normalized === 'bigquery') return 'BigQuery';
  if (normalized === 'snowflake') return 'Snowflake';
  if (normalized === 'clickhouse') return 'ClickHouse';
  if (normalized === 'sqlite') return 'SQLite';
  return driver || 'the source';
}

function failedStepDetail(result: KtxPublicIngestTargetResult): string | null {
  return result.steps.find((step) => step.status === 'failed')?.detail ?? null;
}

function failureTextForTarget(input: {
  target: KtxPublicIngestPlanTarget;
  projectDir: string;
  capturedOutput?: string;
  error?: unknown;
  fallback?: string | null;
}): string {
  const code = networkErrorCode(input.error, input.capturedOutput);
  if (code) {
    const operation = input.target.operation === 'scan' ? 'scanning' : 'ingesting';
    return [
      `KTX lost its connection to ${friendlyDriverName(input.target.driver)} while ${operation} ${input.target.connectionId}.`,
      `Reason: ${NETWORK_ERROR_REASONS[code]} (${code}).`,
      `Retry: ${resumeCommand(input.projectDir)}`,
    ].join(' ');
  }
  return input.fallback ?? `${input.target.connectionId} failed.`;
}

export function initViewState(targets: KtxPublicIngestPlanTarget[]): ContextBuildViewState {
  return {
    primarySources: targets.filter((t) => t.operation === 'scan').map(makeTargetState),
    contextSources: targets.filter((t) => t.operation === 'source-ingest').map(makeTargetState),
    frame: 0,
    startedAt: null,
    totalElapsedMs: 0,
  };
}

export async function runContextBuild(
  project: KtxPublicIngestProject,
  args: ContextBuildArgs,
  io: KtxCliIo,
  deps: ContextBuildDeps = {},
): Promise<ContextBuildResult> {
  const plan = buildPublicIngestPlan(project, { projectDir: args.projectDir, all: true });
  const state = initViewState(plan.targets);
  const isTTY = io.stdout.isTTY === true;
  const nowFn = deps.now ?? (() => Date.now());

  state.startedAt = nowFn();

  const repainter = isTTY ? createRepainter(io) : null;
  const viewOpts = { styled: true, projectDir: args.projectDir };
  const paint = (hint: boolean) => repainter?.paint(renderContextBuildView(state, { ...viewOpts, showHint: hint }));
  paint(true);

  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  if (repainter) {
    spinnerInterval = setInterval(() => {
      state.frame++;
      if (state.startedAt !== null) {
        state.totalElapsedMs = nowFn() - state.startedAt;
      }
      for (const t of [...state.primarySources, ...state.contextSources]) {
        if (t.status === 'running' && t.startedAt !== null) {
          t.elapsedMs = nowFn() - t.startedAt;
        }
      }
      paint(true);
    }, 140);
  }

  const orderedTargets = [...state.primarySources, ...state.contextSources];
  const execTarget = deps.executeTarget ?? executePublicIngestTarget;
  const reportIds = new Set<string>();
  const artifactPaths = new Set<string>();

  let detached = false;
  let exiting = false;
  let cleanupKeystroke: (() => void) | null = null;

  if (isTTY || deps.setupKeystroke) {
    const cleanup = () => {
      if (spinnerInterval) clearInterval(spinnerInterval);
      cleanupKeystroke?.();
    };
    cleanupKeystroke = (deps.setupKeystroke ?? defaultSetupKeystroke)(
      () => {
        detached = true;
        cleanup();
        deps.onDetach?.();
        const bg = spawnBackgroundBuild(args.projectDir);
        io.stdout.write('\n\nContext build continuing in the background.\n');
        if (bg) io.stdout.write(`Log: ${bg.logPath}\n`);
        io.stdout.write(`Resume: ${resumeCommand(args.projectDir)}\n`);
        io.stdout.write(`Status: ktx setup context status --project-dir ${resolve(args.projectDir)}\n`);
        exiting = true;
        process.exit(0);
      },
      () => {
        cleanup();
        io.stdout.write('\n\nContext build stopped. Nothing is running in the background.\n');
        io.stdout.write(`Resume: ${resumeCommand(args.projectDir)}\n`);
        exiting = true;
        process.exit(130);
      },
    );
  }
  const runArgs: Extract<KtxPublicIngestArgs, { command: 'run' }> = {
    command: 'run',
    projectDir: args.projectDir,
    all: true,
    json: false,
    inputMode: args.inputMode,
    scanMode: args.scanMode,
    detectRelationships: args.detectRelationships,
  };

  let hasFailure = false;

  try {
    for (const targetState of orderedTargets) {
      if (detached) break;

      targetState.status = 'running';
      targetState.startedAt = nowFn();
      paint(true);
      deps.onSourceProgress?.(collectSourceProgress(orderedTargets));

      const capture = createCaptureIo(
        (message) => {
          targetState.detailLine = message;
          paint(true);
        },
        false,
      );

      let result: KtxPublicIngestTargetResult | null = null;
      let thrownError: unknown = null;
      try {
        result = await execTarget(targetState.target, runArgs, capture.io, {});
      } catch (error) {
        if (exiting) {
          throw error;
        }
        thrownError = error;
      }

      targetState.elapsedMs = nowFn() - (targetState.startedAt ?? nowFn());
      const failed = thrownError !== null || result?.steps.some((s) => s.status === 'failed') === true;
      targetState.status = failed ? 'failed' : 'done';
      targetState.detailLine = null;
      const capturedOutput = capture.captured();
      const metadata = collectOutputMetadata(capturedOutput, targetState.target.operation);
      for (const reportId of metadata.reportIds) reportIds.add(reportId);
      for (const artifactPath of metadata.artifactPaths) artifactPaths.add(artifactPath);
      if (!failed) {
        targetState.summaryText =
          targetState.target.operation === 'scan'
            ? parseScanSummary(capturedOutput)
            : parseIngestSummary(capturedOutput);
      } else {
        targetState.failureText = failureTextForTarget({
          target: targetState.target,
          projectDir: args.projectDir,
          capturedOutput,
          error: thrownError,
          fallback: result ? failedStepDetail(result) : null,
        });
      }
      if (failed) hasFailure = true;

      paint(true);
      deps.onSourceProgress?.(collectSourceProgress(orderedTargets));
    }
  } finally {
    if (spinnerInterval) clearInterval(spinnerInterval);
    cleanupKeystroke?.();
  }

  if (state.startedAt !== null) {
    state.totalElapsedMs = nowFn() - state.startedAt;
  }

  if (detached) {
    return { exitCode: 0, detached: true };
  }

  if (!repainter) {
    io.stdout.write(renderContextBuildView(state, { styled: false }));
  } else {
    paint(false);
  }

  return {
    exitCode: hasFailure ? 1 : 0,
    detached: false,
    ...(reportIds.size > 0 ? { reportIds: [...reportIds] } : {}),
    ...(artifactPaths.size > 0 ? { artifactPaths: [...artifactPaths] } : {}),
  };
}
