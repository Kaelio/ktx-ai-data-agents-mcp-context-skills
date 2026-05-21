import type { MemoryFlowColumnView, MemoryFlowRenderOptions, MemoryFlowViewModel } from './types.js';
import { renderMemoryFlowConnectorLine } from './visuals.js';

const WIDE_COLUMN_WIDTH = 20;

function cell(value: string | undefined, width = WIDE_COLUMN_WIDTH): string {
  const text = value ?? '';
  const normalized = text.length > width ? text.slice(0, width - 1) : text;
  return normalized.padEnd(width, ' ');
}

function row(values: string[]): string {
  return values.map((value) => cell(value)).join('  ').trimEnd();
}

function counterAt(column: MemoryFlowColumnView, index: number): string {
  return column.counters[index] ?? '';
}

function trustIssueLines(view: MemoryFlowViewModel): string[] {
  if (view.trustIssues.length === 0) {
    return [];
  }

  return [
    'Trust issues',
    ...view.trustIssues.slice(0, 4).map((issue) => {
      const label = issue.severity === 'failed' ? 'FAILED' : 'WARNING';
      return `${label} ${issue.title}: ${issue.detail}`;
    }),
    ...(view.trustIssues.length > 4 ? [`+${view.trustIssues.length - 4} more trust issues`] : []),
    '',
  ];
}

function renderWide(view: MemoryFlowViewModel): string {
  const lines = [
    view.title,
    view.activeLine,
    view.subtitle,
    renderMemoryFlowConnectorLine(view),
    ...trustIssueLines(view),
    '',
    row(view.columns.map((column) => column.title)),
    row(view.columns.map((column) => column.headline)),
    row(view.columns.map((column) => counterAt(column, 0))),
    row(view.columns.map((column) => counterAt(column, 1))),
    '',
    `Selected: ${view.selectedTitle}`,
    ...view.selectedDetails.map((detail) => `- ${detail}`),
  ];

  if (view.completionLine) {
    lines.push('', view.completionLine);
  }

  lines.push('');
  return lines.join('\n');
}

function renderNarrowColumn(column: MemoryFlowColumnView): string[] {
  return [
    column.title,
    `  ${column.headline}`,
    ...column.counters.slice(0, 3).map((counter) => `  ${counter}`),
  ];
}

function renderNarrow(view: MemoryFlowViewModel): string {
  const lines = [
    view.title,
    view.activeLine,
    view.subtitle,
    renderMemoryFlowConnectorLine(view),
    ...trustIssueLines(view),
    '',
    ...view.columns.flatMap((column, index) => [
      ...(index > 0 ? [''] : []),
      ...renderNarrowColumn(column),
    ]),
    '',
    `Selected: ${view.selectedTitle}`,
    ...view.selectedDetails.map((detail) => `- ${detail}`),
  ];

  if (view.completionLine) {
    lines.push('', view.completionLine);
  }

  lines.push('');
  return lines.join('\n');
}

export function renderMemoryFlowReplay(view: MemoryFlowViewModel, options: MemoryFlowRenderOptions = {}): string {
  if ((options.terminalWidth ?? 120) < 100) {
    return renderNarrow(view);
  }
  return renderWide(view);
}
