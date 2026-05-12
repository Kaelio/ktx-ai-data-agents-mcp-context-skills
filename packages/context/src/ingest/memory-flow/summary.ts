import { sanitizeMemoryFlowError } from './live-buffer.js';
import type { MemoryFlowEvent, MemoryFlowReplayInput } from './types.js';
import { buildMemoryFlowViewModel } from './view-model.js';
import { isNotionAuthorizationExpired, notionAuthorizationFixSuggestions } from './known-errors.js';

function latest<T extends MemoryFlowEvent['type']>(
  events: MemoryFlowEvent[],
  type: T,
): Extract<MemoryFlowEvent, { type: T }> | undefined {
  return events.filter((event): event is Extract<MemoryFlowEvent, { type: T }> => event.type === type).at(-1);
}

function eventsOf<T extends MemoryFlowEvent['type']>(
  events: MemoryFlowEvent[],
  type: T,
): Array<Extract<MemoryFlowEvent, { type: T }>> {
  return events.filter((event): event is Extract<MemoryFlowEvent, { type: T }> => event.type === type);
}

function replaySourceLine(input: MemoryFlowReplayInput): string | null {
  const metadata = input.metadata;
  if (!metadata) {
    return null;
  }

  const origin =
    metadata.origin === 'synthetic-report'
      ? 'synthetic report replay'
      : metadata.origin === 'packaged'
        ? 'packaged replay'
        : 'captured replay';
  return `Replay source: ${origin} (${metadata.timing} timing)`;
}

function humanizeSummaryText(value: string): string {
  return value
    .replace(/\bWORKUNITS\b/g, 'PLAN')
    .replace(/\bWorkUnit\b/g, 'Table review')
    .replace(/\bwork units\b/gi, 'table reviews')
    .replace(/\bWUs\b/g, 'tables')
    .replace(/\braw files\b/gi, 'database files')
    .replace(/\braw file\b/gi, 'database file')
    .replace(/\bSL\b/g, 'semantic layer');
}

function fixSuggestions(input: MemoryFlowReplayInput): string[] {
  const workUnitReasons = eventsOf(input.events, 'work_unit_finished').map((event) => event.reason);
  const hasNotionAuthFailure = [...workUnitReasons, ...input.errors].some((reason) =>
    isNotionAuthorizationExpired(input, reason),
  );
  return hasNotionAuthFailure ? notionAuthorizationFixSuggestions(input.connectionId) : [];
}

export function formatMemoryFlowFinalSummary(input: MemoryFlowReplayInput): string {
  const sources = eventsOf(input.events, 'source_acquired');
  const source = sources.at(-1);
  const totalFiles = sources.reduce((sum, s) => sum + s.fileCount, 0);
  const saved = latest(input.events, 'saved');
  const provenance = latest(input.events, 'provenance_recorded');
  const report = latest(input.events, 'report_created');
  const finished = eventsOf(input.events, 'work_unit_finished');
  const failed = finished.filter((event) => event.status === 'failed');
  const view = buildMemoryFlowViewModel(input);
  const lines = [
    `Memory-flow summary: ${input.status}`,
    `Connection: ${input.connectionId}`,
    ...(sources.length > 1
      ? [`Sources: ${[...new Set(sources.map((s) => s.adapter))].join(', ')}`]
      : [`Adapter: ${input.adapter}`]),
    `Run: ${input.runId}`,
    `Sync: ${input.syncId}`,
    `Source files: ${totalFiles}`,
    `Table reviews: ${input.plannedWorkUnits.length || finished.length} total, ${finished.length - failed.length} done, ${failed.length} failed`,
    `Saved memory: ${saved?.wikiCount ?? 0} wiki, ${saved?.slCount ?? 0} semantic layer`,
    `Provenance rows: ${provenance?.rowCount ?? 0}`,
    `Report: ${report?.reportPath ?? input.reportPath ?? 'none'}`,
  ];
  const sourceLine = replaySourceLine(input);
  if (sourceLine) {
    lines.push(sourceLine);
  }
  if (input.metadata?.capturedAt) {
    lines.push(`Replay captured: ${input.metadata.capturedAt}`);
  }
  if (input.metadata?.fallbackReason) {
    lines.push(`Replay note: ${input.metadata.fallbackReason}`);
  }

  if (view.trustIssues.length > 0) {
    lines.push(`Trust issues: ${view.trustIssues.length}`);
    for (const issue of view.trustIssues.slice(0, 3)) {
      lines.push(`- ${humanizeSummaryText(issue.title)}: ${humanizeSummaryText(issue.detail)}`);
    }
  }

  const suggestions = fixSuggestions(input);
  if (suggestions.length > 0) {
    lines.push('Fix suggestions:');
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  for (const error of input.errors.slice(0, 3)) {
    lines.push(`Error: ${sanitizeMemoryFlowError(error)}`);
  }

  lines.push('');
  return lines.join('\n');
}
