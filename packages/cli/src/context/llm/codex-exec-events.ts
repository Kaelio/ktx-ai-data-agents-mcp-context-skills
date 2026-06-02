import type { LlmTokenUsage, RunLoopStopReason } from './runtime-port.js';

export interface CodexExecEventSummary {
  finalText: string;
  stopReason: RunLoopStopReason;
  usage: LlmTokenUsage;
  stepCount: number;
  stepBoundariesMs: number[];
  toolCallCount: number;
  toolFailures: string[];
  error?: Error;
}

interface CodexEventParseOptions {
  startedAt?: number;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/**
 * Codex thread items that represent a discrete agent action consuming one loop
 * step. The step budget caps the total number of these regardless of which
 * capability the agent reaches for, so built-in `command_execution` (and any
 * file/web action the public Codex surface still exposes) count alongside our
 * own `mcp_tool_call` items rather than only the MCP ones.
 */
const AGENT_STEP_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search']);

export function isCompletedAgentStep(event: unknown): boolean {
  const eventRecord = record(event);
  if (eventRecord?.type !== 'item.completed') {
    return false;
  }
  const itemType = record(eventRecord.item)?.type;
  return typeof itemType === 'string' && AGENT_STEP_ITEM_TYPES.has(itemType);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usageFrom(value: unknown): LlmTokenUsage {
  const usage = record(value);
  if (!usage) {
    return {};
  }
  const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens);
  const explicitTotalTokens = numberValue(usage.total_tokens ?? usage.totalTokens);
  const totalTokens =
    explicitTotalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function stopReasonFrom(value: unknown): RunLoopStopReason {
  const reason = text(value)?.toLowerCase();
  if (reason && /(budget|max_turn|max-turn|limit)/.test(reason)) {
    return 'budget';
  }
  return 'natural';
}

function errorMessageFrom(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  const asRecord = record(value);
  const message = text(asRecord?.message);
  return message ?? text(value) ?? 'Codex turn failed';
}

/**
 * Codex serializes API failures as a JSON envelope inside the event message
 * (e.g. `{"type":"error","status":400,"error":{"message":"…"}}`). Surface the
 * human-readable inner message so callers don't leak raw JSON; pass plain
 * strings through unchanged.
 */
function unwrapCodexApiErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    return raw;
  }
  try {
    const parsed = record(JSON.parse(trimmed));
    return text(record(parsed?.error)?.message) ?? text(parsed?.message) ?? raw;
  } catch {
    return raw;
  }
}

/** @internal */
export function parseCodexExecEventLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Codex JSONL event stream was malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function summarizeCodexExecEvents(
  events: Iterable<unknown>,
  options: CodexEventParseOptions = {},
): CodexExecEventSummary {
  const startedAt = options.startedAt ?? Date.now();
  const now = options.now ?? Date.now;
  let finalText = '';
  let stopReason: RunLoopStopReason = 'natural';
  let usage: LlmTokenUsage = {};
  let turnCount = 0;
  let completedStepCount = 0;
  const stepBoundariesMs: number[] = [];
  let toolCallCount = 0;
  const toolFailures: string[] = [];
  let error: Error | undefined;

  for (const event of events) {
    const eventRecord = record(event);
    const eventType = text(eventRecord?.type);
    if (!eventRecord || !eventType) {
      continue;
    }

    if (eventType === 'turn.started') {
      turnCount += 1;
      continue;
    }

    const item = record(eventRecord.item);
    const itemType = text(item?.type);

    if (eventType === 'item.started' && itemType === 'mcp_tool_call') {
      toolCallCount += 1;
      continue;
    }

    if (isCompletedAgentStep(event)) {
      completedStepCount += 1;
      stepBoundariesMs.push(now() - startedAt);
      // Only MCP tool calls fail the loop: a non-zero `command_execution` exit
      // is normal agent exploration, not a runtime error. `status` is the
      // authoritative signal (the SDK always sets it); the SDK also serializes
      // `error: null` on successful calls, so an explicit-null `error` must NOT
      // be read as a failure — only a populated error object counts.
      if (itemType === 'mcp_tool_call' && (item?.status === 'failed' || (item?.error !== undefined && item?.error !== null))) {
        const name = text(item?.name) ?? text(item?.tool) ?? text(item?.tool_name) ?? 'unknown';
        toolFailures.push(`${name}: ${errorMessageFrom(item?.error)}`);
      }
      continue;
    }

    if (eventType === 'item.completed' && itemType === 'agent_message') {
      finalText = text(item?.text) ?? finalText;
      continue;
    }

    if (eventType === 'turn.completed') {
      usage = usageFrom(eventRecord.usage);
      if (completedStepCount === 0) {
        stepBoundariesMs.push(now() - startedAt);
      }
      stopReason = stopReasonFrom(eventRecord.reason ?? eventRecord.stop_reason ?? eventRecord.terminal_reason);
      continue;
    }

    if (eventType === 'turn.failed' || eventType === 'error') {
      stopReason = 'error';
      error = new Error(unwrapCodexApiErrorMessage(errorMessageFrom(eventRecord.error ?? eventRecord.message)));
      continue;
    }
  }

  return {
    finalText,
    stopReason,
    usage,
    stepCount: completedStepCount > 0 ? completedStepCount : turnCount,
    stepBoundariesMs,
    toolCallCount,
    toolFailures,
    ...(error ? { error } : {}),
  };
}
