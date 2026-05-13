import type { ToolCallLogEntry } from './tool-call-logger.js';
import { isFlatWikiKey, suggestFlatWikiKey } from '../../wiki/keys.js';

export interface MutableToolTranscriptSummary {
  unitKey: string;
  path: string;
  toolCallCount: number;
  errorCount: number;
  fatalErrorCount: number;
  toolNames: Set<string>;
  hardErrorCount: number;
  recoverableFailureCounts: Map<string, number>;
}

export function createMutableToolTranscriptSummary(unitKey: string, path: string): MutableToolTranscriptSummary {
  return {
    unitKey,
    path,
    toolCallCount: 0,
    errorCount: 0,
    fatalErrorCount: 0,
    toolNames: new Set<string>(),
    hardErrorCount: 0,
    recoverableFailureCounts: new Map<string, number>(),
  };
}

export function recordToolTranscriptEntry(summary: MutableToolTranscriptSummary, entry: ToolCallLogEntry): void {
  summary.toolCallCount += 1;
  summary.toolNames.add(entry.toolName);

  if (entry.error) {
    summary.errorCount += 1;
    summary.hardErrorCount += 1;
    refreshFatalErrorCount(summary);
    return;
  }

  const recoverableFailureKey = recoverableStructuredFailureKey(entry);
  if (recoverableFailureKey) {
    summary.errorCount += 1;
    summary.recoverableFailureCounts.set(
      recoverableFailureKey,
      (summary.recoverableFailureCounts.get(recoverableFailureKey) ?? 0) + 1,
    );
    refreshFatalErrorCount(summary);
    return;
  }

  const recoveryKey = recoverableStructuredSuccessKey(entry);
  if (recoveryKey) {
    summary.recoverableFailureCounts.delete(recoveryKey);
  }
  if (entry.toolName === 'emit_unmapped_fallback') {
    const fallbackTarget = fallbackSlTargetKey(entry);
    const pendingSlKeys = [...summary.recoverableFailureCounts.keys()].filter((key) => key.startsWith('sl:'));
    for (const key of pendingSlKeys) {
      if (
        (fallbackTarget && slFailureKeyMatchesFallback(key, fallbackTarget)) ||
        (!fallbackTarget && pendingSlKeys.length === 1)
      ) {
        summary.recoverableFailureCounts.delete(key);
      }
    }
  }
  refreshFatalErrorCount(summary);
}

function refreshFatalErrorCount(summary: MutableToolTranscriptSummary): void {
  summary.fatalErrorCount =
    summary.hardErrorCount + [...summary.recoverableFailureCounts.values()].reduce((sum, count) => sum + count, 0);
}

function recoverableStructuredFailureKey(entry: ToolCallLogEntry): string | null {
  if (!isStructuredToolFailure(entry.output)) {
    return null;
  }
  if (entry.toolName === 'wiki_write' || entry.toolName === 'wiki_remove') {
    return wikiTargetKey(entry);
  }
  if (entry.toolName === 'sl_write_source') {
    return slTargetKey(entry);
  }
  return null;
}

function recoverableStructuredSuccessKey(entry: ToolCallLogEntry): string | null {
  if (!isStructuredToolSuccess(entry.output)) {
    return null;
  }
  if (entry.toolName === 'wiki_write' || entry.toolName === 'wiki_remove') {
    return wikiTargetKey(entry);
  }
  if (entry.toolName === 'sl_write_source' || entry.toolName === 'sl_edit_source') {
    return slTargetKey(entry);
  }
  return null;
}

function isStructuredToolFailure(output: unknown): boolean {
  return structuredSuccess(output) === false;
}

function isStructuredToolSuccess(output: unknown): boolean {
  return structuredSuccess(output) === true;
}

function structuredSuccess(output: unknown): boolean | null {
  const structured = recordField(output, 'structured');
  const success = structured?.success;
  return typeof success === 'boolean' ? success : null;
}

function wikiTargetKey(entry: ToolCallLogEntry): string | null {
  const key = stringField(recordField(entry.output, 'structured'), 'key') ?? stringField(entry.input, 'key');
  if (!key) {
    return null;
  }
  return `wiki:${isFlatWikiKey(key) ? key : suggestFlatWikiKey(key)}`;
}

function slTargetKey(entry: ToolCallLogEntry): string | null {
  const structured = recordField(entry.output, 'structured');
  const sourceName = stringField(structured, 'sourceName') ?? stringField(entry.input, 'sourceName');
  if (!sourceName) {
    return null;
  }
  const connectionId = stringField(entry.input, 'connectionId') ?? '';
  return `sl:${connectionId}:${sourceName}`;
}

function fallbackSlTargetKey(entry: ToolCallLogEntry): { connectionId?: string; sourceName: string } | null {
  const tableRef = stringField(entry.input, 'tableRef');
  if (!tableRef) {
    return null;
  }
  const sourceName = finalReferenceSegment(tableRef);
  if (!sourceName) {
    return null;
  }
  const connectionId = stringField(entry.input, 'connectionId');
  return {
    sourceName,
    ...(connectionId ? { connectionId } : {}),
  };
}

function slFailureKeyMatchesFallback(
  failureKey: string,
  fallback: { connectionId?: string; sourceName: string },
): boolean {
  const match = /^sl:([^:]*):(.*)$/.exec(failureKey);
  if (!match) {
    return false;
  }
  const [, connectionId, sourceName] = match;
  if (fallback.connectionId && connectionId !== fallback.connectionId) {
    return false;
  }
  return normalizeReferenceSegment(sourceName ?? '') === normalizeReferenceSegment(fallback.sourceName);
}

function finalReferenceSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/["`]/g, '')
    .replace(/[\[\]]/g, '');
  return normalized.split('.').filter(Boolean).at(-1) ?? '';
}

function normalizeReferenceSegment(value: string): string {
  return finalReferenceSegment(value).toLowerCase();
}

function recordField(value: unknown, field: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const nested = (value as Record<string, unknown>)[field];
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
