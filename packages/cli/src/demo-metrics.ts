import type { MemoryFlowEvent, MemoryFlowReplayInput } from './context/ingest/memory-flow/index.js';

const DEFAULT_INPUT_TOKENS_PER_STEP = 4500;
const DEFAULT_OUTPUT_TOKENS_PER_STEP = 700;
const DEFAULT_INPUT_PRICE_PER_MTOK_USD = 3;
const DEFAULT_OUTPUT_PRICE_PER_MTOK_USD = 15;

interface DemoMetricsTuning {
  inputTokensPerStep?: number;
  outputTokensPerStep?: number;
  inputPricePerMTokUsd?: number;
  outputPricePerMTokUsd?: number;
}

interface DemoMetricsSnapshot {
  elapsedMs: number;
  etaMs: number | null;
  agentSteps: number;
  agentStepBudget: number;
  toolCalls: number;
  workUnitsStarted: number;
  workUnitsFinished: number;
  workUnitsTotal: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  tokensPerSec: number;
  status: MemoryFlowReplayInput['status'];
  isCostEstimated: boolean;
}

function eventsOf<T extends MemoryFlowEvent['type']>(
  events: MemoryFlowEvent[],
  type: T,
): Array<Extract<MemoryFlowEvent, { type: T }>> {
  return events.filter((event): event is Extract<MemoryFlowEvent, { type: T }> => event.type === type);
}

function maxAgentStep(events: MemoryFlowEvent[]): { step: number; budget: number } {
  const steps = eventsOf(events, 'work_unit_step');
  const started = eventsOf(events, 'work_unit_started');
  const stepIndex = steps.reduce((max, event) => Math.max(max, event.stepIndex), 0);
  const stepBudget = Math.max(
    0,
    ...steps.map((event) => event.stepBudget),
    ...started.map((event) => event.stepBudget),
  );
  return { step: stepIndex, budget: stepBudget };
}

function totalToolCalls(input: MemoryFlowReplayInput): number {
  return input.details.transcripts.reduce((total, transcript) => total + transcript.toolCallCount, 0);
}

function workUnitProgress(input: MemoryFlowReplayInput): { started: number; finished: number; total: number } {
  const started = eventsOf(input.events, 'work_unit_started').length;
  const finished = eventsOf(input.events, 'work_unit_finished').length;
  const planned = input.plannedWorkUnits.length;
  const planEvent = eventsOf(input.events, 'chunks_planned').at(-1);
  const total = planned || planEvent?.workUnitCount || started || finished || 0;
  return { started, finished, total };
}

function elapsedMsFromEvents(events: MemoryFlowEvent[], nowMs: number): number {
  const stamped = events
    .map((event) => (event.emittedAt ? Date.parse(event.emittedAt) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (stamped.length === 0) return 0;
  const first = Math.min(...stamped);
  return Math.max(0, nowMs - first);
}

function estimateEtaMs(
  elapsedMs: number,
  finished: number,
  total: number,
  status: MemoryFlowReplayInput['status'],
): number | null {
  if (status !== 'running') return 0;
  if (total === 0 || finished === 0 || elapsedMs === 0) return null;
  const perUnit = elapsedMs / finished;
  const remaining = Math.max(0, total - finished);
  return Math.round(perUnit * remaining);
}

export function buildDemoMetrics(
  input: MemoryFlowReplayInput,
  options: { now?: () => number; tuning?: DemoMetricsTuning } = {},
): DemoMetricsSnapshot {
  const tuning = options.tuning ?? {};
  const inputTokensPerStep = tuning.inputTokensPerStep ?? DEFAULT_INPUT_TOKENS_PER_STEP;
  const outputTokensPerStep = tuning.outputTokensPerStep ?? DEFAULT_OUTPUT_TOKENS_PER_STEP;
  const inputPrice = tuning.inputPricePerMTokUsd ?? DEFAULT_INPUT_PRICE_PER_MTOK_USD;
  const outputPrice = tuning.outputPricePerMTokUsd ?? DEFAULT_OUTPUT_PRICE_PER_MTOK_USD;
  const nowMs = (options.now ?? Date.now)();
  const elapsedMs = elapsedMsFromEvents(input.events, nowMs);

  const { step, budget } = maxAgentStep(input.events);
  const toolCalls = totalToolCalls(input);
  const progress = workUnitProgress(input);
  const finishedCount = eventsOf(input.events, 'work_unit_finished').length;
  const stepDriver = Math.max(step, toolCalls, finishedCount * 4);

  const inputTokens = stepDriver * inputTokensPerStep;
  const outputTokens = stepDriver * outputTokensPerStep;
  const totalTokens = inputTokens + outputTokens;
  const cost = (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice;

  const elapsedSec = elapsedMs / 1000;
  const tokensPerSec = elapsedSec > 0 ? totalTokens / elapsedSec : 0;

  return {
    elapsedMs,
    etaMs: estimateEtaMs(elapsedMs, progress.finished, progress.total, input.status),
    agentSteps: step,
    agentStepBudget: budget,
    toolCalls,
    workUnitsStarted: progress.started,
    workUnitsFinished: progress.finished,
    workUnitsTotal: progress.total,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedTokens: totalTokens,
    estimatedCostUsd: cost,
    tokensPerSec,
    status: input.status,
    isCostEstimated: true,
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${sec.toString().padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${(min % 60).toString().padStart(2, '0')}m`;
}

export function formatEta(ms: number | null, status: MemoryFlowReplayInput['status']): string {
  if (status !== 'running') return 'done';
  if (ms === null) return 'estimating...';
  return formatDuration(ms);
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.000';
  if (usd < 0.001) return '<$0.001';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatTokensPerSec(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0/s';
  if (n < 1000) return `${Math.round(n)}/s`;
  return `${(n / 1000).toFixed(1)}K/s`;
}

const PROGRESS_BAR_WIDTH = 12;
export function progressBar(ratio: number, width: number = PROGRESS_BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return `${'#'.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}`;
}
