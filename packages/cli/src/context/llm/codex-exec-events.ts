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
  let completedToolStepCount = 0;
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

    if (eventType === 'item.completed' && itemType === 'mcp_tool_call') {
      completedToolStepCount += 1;
      stepBoundariesMs.push(now() - startedAt);
      if (item?.error !== undefined || item?.status === 'failed') {
        const name = text(item.name) ?? text(item.tool) ?? text(item.tool_name) ?? 'unknown';
        toolFailures.push(`${name}: ${errorMessageFrom(item.error)}`);
      }
      continue;
    }

    if (eventType === 'item.completed' && itemType === 'agent_message') {
      finalText = text(item?.text) ?? finalText;
      continue;
    }

    if (eventType === 'turn.completed') {
      usage = usageFrom(eventRecord.usage);
      if (completedToolStepCount === 0) {
        stepBoundariesMs.push(now() - startedAt);
      }
      stopReason = stopReasonFrom(eventRecord.reason ?? eventRecord.stop_reason ?? eventRecord.terminal_reason);
      continue;
    }

    if (eventType === 'turn.failed' || eventType === 'error') {
      stopReason = 'error';
      error = new Error(errorMessageFrom(eventRecord.error ?? eventRecord.message));
      continue;
    }
  }

  return {
    finalText,
    stopReason,
    usage,
    stepCount: completedToolStepCount > 0 ? completedToolStepCount : turnCount,
    stepBoundariesMs,
    toolCallCount,
    toolFailures,
    ...(error ? { error } : {}),
  };
}
