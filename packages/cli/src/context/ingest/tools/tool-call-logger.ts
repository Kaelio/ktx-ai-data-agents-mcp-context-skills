import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KtxRuntimeToolSet } from '../../llm/index.js';

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

function appendEntry(path: string, entry: ToolCallLogEntry): void {
  void (async () => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${safeStringify(entry)}\n`, 'utf-8');
    } catch {
      // best-effort
    }
  })();
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify({ error: 'serialize-failed' });
  }
}
