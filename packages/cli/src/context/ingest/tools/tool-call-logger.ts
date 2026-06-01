import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KtxRuntimeToolSet } from '../../../context/llm/runtime-port.js';

export interface ToolCallLogEntry {
  ts: string;
  wuKey: string;
  toolCallId?: string;
  toolName: string;
  durationMs: number;
  input: unknown;
  output?: unknown;
  error?: { message: string; name?: string };
}

interface ToolCallLoggerOptions {
  onEntry?(entry: ToolCallLogEntry): void;
}

/**
 * Wrap every tool in `tools` so each invocation appends a JSONL record with
 * `{toolName, input, output | error, durationMs}` to `logFilePath`. Used by
 * the ingest runner to produce per-WU transcripts so a completed sync can be
 * inspected the way `parse_chat.py` inspects a chat.
 *
 * Tool shape is preserved (description, inputSchema, ...). Tools without an
 * `execute` function (provider-defined) pass through untouched.
 *
 * Log writes are best-effort and fire-and-forget; a failing write will never
 * block or error the agent. Tool execution inside a single agent loop is
 * sequential (`generateText` awaits each tool result), so per-WU files are
 * effectively single-writer and lines land in call order.
 */
export function wrapToolsWithLogger<T extends KtxRuntimeToolSet>(
  tools: T,
  logFilePath: string,
  wuKey: string,
  options: ToolCallLoggerOptions = {},
): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, original] of Object.entries(tools) as Array<[string, T[string]]>) {
    const originalExecute = original.execute;
    if (typeof originalExecute !== 'function') {
      wrapped[name] = original;
      continue;
    }
    const wrappedExecute = async (input: unknown) => {
      const start = Date.now();
      try {
        const output = await originalExecute(input);
        const entry: ToolCallLogEntry = {
          ts: new Date().toISOString(),
          wuKey,
          toolName: name,
          durationMs: Date.now() - start,
          input,
          output,
        };
        options.onEntry?.(entry);
        appendEntry(logFilePath, entry);
        return output;
      } catch (err) {
        const entry: ToolCallLogEntry = {
          ts: new Date().toISOString(),
          wuKey,
          toolName: name,
          durationMs: Date.now() - start,
          input,
          error: {
            message: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : undefined,
          },
        };
        options.onEntry?.(entry);
        appendEntry(logFilePath, entry);
        throw err;
      }
    };
    wrapped[name] = { ...original, execute: wrappedExecute };
  }
  return wrapped as T;
}

// Fire-and-forget appends are intentional (the agent hot path must never block
// or fail on logging), but readers like the ingest profiler need to know when
// the writes have settled. Track in-flight appends so a consumer can flush.
const pendingWrites = new Set<Promise<void>>();

function appendEntry(path: string, entry: ToolCallLogEntry): void {
  const write = (async () => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${safeStringify(entry)}\n`, 'utf-8');
    } catch {
      // best-effort
    }
  })();
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
}

/**
 * Await all in-flight tool-call log writes (best-effort, bounded by `timeoutMs`
 * so it can never hang a caller). Lets readers such as the ingest profiler see
 * complete transcripts despite the fire-and-forget append design.
 */
export async function flushToolCallLogs(timeoutMs = 5000): Promise<void> {
  const pending = [...pendingWrites];
  if (pending.length === 0) {
    return;
  }
  const settled = Promise.allSettled(pending).then(() => undefined);
  if (timeoutMs <= 0) {
    await settled;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([settled, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify({ error: 'serialize-failed' });
  }
}
