import type { KtxProgressPort, KtxProgressUpdateOptions } from '@ktx/context/scan';
import type { KtxCliIo } from './index.js';
import type { KtxIngestProgressUpdate } from './ingest.js';
import { publicDatabaseIngestMessage, publicQueryHistoryMessage } from './public-ingest-copy.js';
import type {
  KtxPublicIngestArgs,
  KtxPublicIngestDeps,
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
  progressUpdatedAtMs: number | null;
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
  targetConnectionId?: string;
  all?: boolean;
  entrypoint?: 'setup' | 'ingest';
  depth?: Extract<KtxPublicIngestArgs, { command: 'run' }>['depth'];
  queryHistory?: Extract<KtxPublicIngestArgs, { command: 'run' }>['queryHistory'];
  queryHistoryWindowDays?: number;
  scanMode?: Extract<KtxPublicIngestArgs, { command: 'run' }>['scanMode'];
  detectRelationships?: boolean;
}

export interface ContextBuildResult {
  exitCode: number;
  reportIds?: string[];
  artifactPaths?: string[];
}

export interface ContextBuildSourceProgressUpdate {
  connectionId: string;
  operation: 'database-ingest' | 'source-ingest';
  status: 'queued' | 'running' | 'done' | 'failed';
  startedAtMs?: number;
  elapsedMs?: number;
  percent?: number;
  message?: string;
  updatedAtMs?: number;
  summaryText?: string;
}

export interface ContextBuildDeps {
  executeTarget?: typeof executePublicIngestTarget;
  now?: () => number;
  onSourceProgress?: (sources: ContextBuildSourceProgressUpdate[]) => void;
  sourceProgressThrottleMs?: number;
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
const STALE_PROGRESS_UPDATE_MS = 30_000;

function renderProgressBar(percent: number, styled: boolean): string {
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(empty)}`;
  return styled ? cyan(bar) : bar;
}

function staleProgressText(target: ContextBuildTargetState, styled: boolean): string | null {
  if (target.startedAt === null || target.progressUpdatedAtMs === null || target.elapsedMs <= 0) {
    return null;
  }
  const currentTimeMs = target.startedAt + target.elapsedMs;
  const staleMs = currentTimeMs - target.progressUpdatedAtMs;
  if (staleMs < STALE_PROGRESS_UPDATE_MS) {
    return null;
  }
  const text = `last update ${formatDuration(staleMs)} ago`;
  return styled ? dim(text) : text;
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
    const progressText =
      target.detailLine?.replace(/^\[\d+%\]\s*/, '') ??
      (target.target.operation === 'database-ingest' ? 'reading schema' : 'ingesting...');
    const elapsed = target.elapsedMs > 0 ? `(${formatDuration(target.elapsedMs)})` : null;
    const parts: string[] = [];
    if (percent !== null) {
      parts.push(`${renderProgressBar(percent, styled)} ${percent}%`);
    }
    parts.push(progressText);
    const stale = staleProgressText(target, styled);
    if (stale) parts.push(stale);
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

function renderMessageGroup(label: string, messages: string[], styled: boolean): string[] {
  if (messages.length === 0) return [];
  const renderedMessages = messages.map((message) => `    - ${message}`);
  return ['', `  ${label}:`, ...renderedMessages.map((line) => (styled ? dim(line) : line))];
}

function retryCommand(input: {
  projectDir?: string;
  entrypoint?: 'setup' | 'ingest';
  connectionId?: string;
  depth?: 'fast' | 'deep';
}): string {
  const projectPart = input.projectDir ? ` --project-dir ${input.projectDir}` : '';
  if (input.entrypoint === 'ingest' && input.connectionId) {
    const depthPart = input.depth ? ` --${input.depth}` : '';
    return `ktx ingest ${input.connectionId}${projectPart}${depthPart}`;
  }
  return input.projectDir ? `ktx setup --project-dir ${input.projectDir}` : 'ktx setup';
}

export function renderContextBuildView(
  state: ContextBuildViewState,
  options: {
    styled?: boolean;
    showHint?: boolean;
    hintText?: string;
    projectDir?: string;
    notices?: string[];
    warnings?: string[];
  } = {},
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
    ...(options.projectDir ? [`  Project: ${options.projectDir}`] : []),
    ...renderTargetGroup('Databases', state.primarySources, state.frame, styled, width),
    ...renderTargetGroup('Context sources', state.contextSources, state.frame, styled, width),
    ...renderMessageGroup('Notices', options.notices ?? [], styled),
    ...renderMessageGroup('Warnings', options.warnings ?? [], styled),
    '',
  ];

  if (allDone && state.totalElapsedMs > 0) {
    const sourcesLabel = totalCount === 1 ? '1 source' : `${totalCount} sources`;
    const summary = `  Done in ${formatDuration(state.totalElapsedMs)} · ${sourcesLabel} processed`;
    lines.push(styled ? green(summary) : summary);
    lines.push('');
  }

  if (options.showHint && hasActive) {
    const hintContent = options.hintText ?? 'Ctrl+C to stop';
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
        if (operation === 'database-ingest') artifactPaths.add(value);
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

function progressFieldsFromDetailLine(
  detailLine: string | null,
  updatedAtMs: number | null,
): Pick<ContextBuildSourceProgressUpdate, 'percent' | 'message' | 'updatedAtMs'> {
  if (!detailLine) return {};
  const percent = extractPercent(detailLine);
  const message = detailLine.replace(/^\[\d+%\]\s*/, '');
  return {
    ...(percent !== null ? { percent } : {}),
    ...(message ? { message } : {}),
    ...(updatedAtMs !== null ? { updatedAtMs } : {}),
  };
}

function detailLineFromProgressSource(source: ContextBuildSourceProgressUpdate): string | null {
  if (!source.message) return null;
  if (typeof source.percent === 'number' && Number.isFinite(source.percent)) {
    const percent = Math.max(0, Math.min(100, Math.round(source.percent)));
    return `[${percent}%] ${source.message}`;
  }
  return source.message;
}

function collectSourceProgress(targets: ContextBuildTargetState[]): ContextBuildSourceProgressUpdate[] {
  return targets.map((t) => {
    const progressFields = progressFieldsFromDetailLine(t.detailLine, t.progressUpdatedAtMs);
    return {
      connectionId: t.target.connectionId,
      operation: t.target.operation,
      status: t.status,
      ...(t.startedAt !== null ? { startedAtMs: t.startedAt } : {}),
      ...(t.elapsedMs > 0 ? { elapsedMs: t.elapsedMs } : {}),
      ...progressFields,
      ...(t.summaryText ? { summaryText: t.summaryText } : {}),
    };
  });
}

export function viewStateFromSourceProgress(
  sources: ContextBuildSourceProgressUpdate[],
  now: number,
  startedAtMs?: number,
): ContextBuildViewState {
  const makeTarget = (s: ContextBuildSourceProgressUpdate): ContextBuildTargetState => ({
    target: { connectionId: s.connectionId, driver: '', operation: s.operation, debugCommand: '', steps: [] },
    status: s.status,
    detailLine: detailLineFromProgressSource(s),
    summaryText: s.summaryText ?? null,
    failureText: null,
    startedAt: s.startedAtMs ?? null,
    elapsedMs: s.status === 'running' && s.startedAtMs ? now - s.startedAtMs : (s.elapsedMs ?? 0),
    progressUpdatedAtMs: s.updatedAtMs ?? null,
  });

  return {
    primarySources: sources.filter((s) => s.operation === 'database-ingest').map(makeTarget),
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
    progressUpdatedAtMs: null,
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
  entrypoint?: 'setup' | 'ingest';
  capturedOutput?: string;
  error?: unknown;
  fallback?: string | null;
}): string {
  const code = networkErrorCode(input.error, input.capturedOutput);
  if (code) {
    const operation = input.target.operation === 'database-ingest' ? 'reading schema for' : 'ingesting';
    return [
      `KTX lost its connection to ${friendlyDriverName(input.target.driver)} while ${operation} ${input.target.connectionId}.`,
      `Reason: ${NETWORK_ERROR_REASONS[code]} (${code}).`,
      `Retry: ${retryCommand({
        projectDir: input.projectDir,
        entrypoint: input.entrypoint,
        connectionId: input.target.connectionId,
        depth: input.target.databaseDepth,
      })}`,
    ].join(' ');
  }
  const fallback = input.fallback ?? `${input.target.connectionId} failed.`;
  if (input.entrypoint === 'ingest') {
    return `${fallback} Retry: ${retryCommand({
      projectDir: input.projectDir,
      entrypoint: input.entrypoint,
      connectionId: input.target.connectionId,
      depth: input.target.databaseDepth,
    })}`;
  }
  return fallback;
}

export function initViewState(targets: KtxPublicIngestPlanTarget[]): ContextBuildViewState {
  return {
    primarySources: targets.filter((t) => t.operation === 'database-ingest').map(makeTargetState),
    contextSources: targets.filter((t) => t.operation === 'source-ingest').map(makeTargetState),
    frame: 0,
    startedAt: null,
    totalElapsedMs: 0,
  };
}

function publicProgressMessage(message: string, target: KtxPublicIngestPlanTarget): string {
  let current = message;
  if (target.operation === 'database-ingest') {
    current = publicDatabaseIngestMessage(current);
  }
  if (target.steps.includes('query-history')) {
    current = publicQueryHistoryMessage(current, target.connectionId);
  }
  return current;
}

function formatProgressDetail(
  update: Pick<KtxIngestProgressUpdate, 'percent' | 'message'>,
  target: KtxPublicIngestPlanTarget,
): string {
  const percent = Math.max(0, Math.min(100, Math.round(update.percent)));
  return `[${percent}%] ${publicProgressMessage(update.message, target)}`;
}

function createContextBuildProgressPort(
  onProgress: (update: KtxIngestProgressUpdate) => void,
  state: { progress: number } = { progress: 0 },
  start = 0,
  weight = 1,
): KtxProgressPort {
  return {
    async update(value: number, message?: string, options?: KtxProgressUpdateOptions): Promise<void> {
      const absoluteValue = start + Math.max(0, Math.min(1, value)) * weight;
      state.progress = Math.max(state.progress, Math.min(1, absoluteValue));
      if (!message) return;
      onProgress({
        percent: Math.max(0, Math.min(100, Math.round(state.progress * 100))),
        message,
        ...(options?.transient !== undefined ? { transient: options.transient } : {}),
      });
    },
    startPhase(phaseWeight: number): KtxProgressPort {
      return createContextBuildProgressPort(onProgress, state, state.progress, weight * phaseWeight);
    },
  };
}

export async function runContextBuild(
  project: KtxPublicIngestProject,
  args: ContextBuildArgs,
  io: KtxCliIo,
  deps: ContextBuildDeps = {},
): Promise<ContextBuildResult> {
  const plan = buildPublicIngestPlan(project, {
    projectDir: args.projectDir,
    ...(args.targetConnectionId ? { targetConnectionId: args.targetConnectionId } : {}),
    all: args.all ?? true,
    ...(args.depth ? { depth: args.depth } : {}),
    ...(args.queryHistory ? { queryHistory: args.queryHistory } : {}),
    ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
    ...(args.scanMode ? { scanMode: args.scanMode } : {}),
  });
  const state = initViewState(plan.targets);
  const isTTY = io.stdout.isTTY === true;
  const nowFn = deps.now ?? (() => Date.now());

  state.startedAt = nowFn();

  const repainter = isTTY ? createRepainter(io) : null;
  const viewOpts = {
    styled: true,
    projectDir: args.projectDir,
    notices: plan.notices ?? [],
    warnings: plan.warnings,
  };
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
  const sourceProgressThrottleMs = deps.sourceProgressThrottleMs ?? 750;
  let lastSourceProgressPublishedAt = Number.NEGATIVE_INFINITY;

  const publishSourceProgress = (force = false): boolean => {
    if (!deps.onSourceProgress) return false;
    const now = nowFn();
    if (!force && now - lastSourceProgressPublishedAt < sourceProgressThrottleMs) {
      return false;
    }
    lastSourceProgressPublishedAt = now;
    deps.onSourceProgress(collectSourceProgress(orderedTargets));
    return true;
  };

  const runArgs: Extract<KtxPublicIngestArgs, { command: 'run' }> = {
    command: 'run',
    projectDir: args.projectDir,
    ...(args.targetConnectionId ? { targetConnectionId: args.targetConnectionId } : {}),
    all: args.all ?? true,
    json: false,
    inputMode: args.inputMode,
    ...(args.depth ? { depth: args.depth } : {}),
    ...(args.queryHistory ? { queryHistory: args.queryHistory } : {}),
    ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
    ...(args.scanMode ? { scanMode: args.scanMode } : {}),
    ...(args.detectRelationships !== undefined ? { detectRelationships: args.detectRelationships } : {}),
  };

  let hasFailure = false;

  try {
    for (const targetState of orderedTargets) {
      targetState.status = 'running';
      targetState.startedAt = nowFn();
      paint(true);
      publishSourceProgress(true);
      let hasPendingProgressPublish = false;

      const updateTargetProgress = (update: KtxIngestProgressUpdate) => {
        targetState.detailLine = formatProgressDetail(update, targetState.target);
        targetState.progressUpdatedAtMs = nowFn();
        if (!repainter) {
          io.stdout.write(`${targetState.detailLine}\n`);
        }
        paint(true);
        hasPendingProgressPublish = !publishSourceProgress(false);
      };

      const capture = createCaptureIo(
        (message) => {
          targetState.detailLine = publicProgressMessage(message, targetState.target);
          targetState.progressUpdatedAtMs = nowFn();
          if (!repainter) {
            io.stdout.write(`${targetState.detailLine}\n`);
          }
          paint(true);
          hasPendingProgressPublish = !publishSourceProgress(false);
        },
        false,
      );
      const progressDeps: KtxPublicIngestDeps = {
        scanProgress: createContextBuildProgressPort(updateTargetProgress),
        ingestProgress: updateTargetProgress,
      };

      let result: KtxPublicIngestTargetResult | null = null;
      let thrownError: unknown = null;
      try {
        result = await execTarget(targetState.target, runArgs, capture.io, progressDeps);
      } catch (error) {
        thrownError = error;
      }

      if (hasPendingProgressPublish) {
        publishSourceProgress(true);
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
          targetState.target.operation === 'database-ingest'
            ? parseScanSummary(capturedOutput)
            : parseIngestSummary(capturedOutput);
      } else {
        targetState.failureText = failureTextForTarget({
          target: targetState.target,
          projectDir: args.projectDir,
          entrypoint: args.entrypoint,
          capturedOutput,
          error: thrownError,
          fallback: result ? failedStepDetail(result) : null,
        });
      }
      if (failed) hasFailure = true;

      paint(true);
      publishSourceProgress(true);
    }
  } finally {
    if (spinnerInterval) clearInterval(spinnerInterval);
  }

  if (state.startedAt !== null) {
    state.totalElapsedMs = nowFn() - state.startedAt;
  }

  if (!repainter) {
    io.stdout.write(renderContextBuildView(state, { ...viewOpts, styled: false }));
  } else {
    paint(false);
  }

  return {
    exitCode: hasFailure ? 1 : 0,
    ...(reportIds.size > 0 ? { reportIds: [...reportIds] } : {}),
    ...(artifactPaths.size > 0 ? { artifactPaths: [...artifactPaths] } : {}),
  };
}
