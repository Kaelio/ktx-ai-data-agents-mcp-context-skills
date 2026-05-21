import {
  findMemoryFlowSearchMatches,
  selectedMemoryFlowColumn,
  selectedMemoryFlowDetails,
  visibleMemoryFlowChips,
} from './interaction.js';
import type {
  MemoryFlowColumnView,
  MemoryFlowInteractionState,
  MemoryFlowRenderOptions,
  MemoryFlowViewModel,
} from './types.js';
import { renderMemoryFlowConnectorLine } from './visuals.js';

const WIDE_COLUMN_WIDTH = 18;

function cell(value: string | undefined, width = WIDE_COLUMN_WIDTH): string {
  const text = value ?? '';
  const normalized = text.length > width ? text.slice(0, width - 1) : text;
  return normalized.padEnd(width, ' ');
}

function row(values: string[]): string {
  return values.map((value) => cell(value)).join('  ').trimEnd();
}

function columnLabel(column: MemoryFlowColumnView, state: MemoryFlowInteractionState): string {
  return column.id === state.selectedColumnId ? `[${column.title}]` : column.title;
}

function counterAt(column: MemoryFlowColumnView, index: number): string {
  return column.counters[index] ?? '';
}

function chipLabel(view: MemoryFlowViewModel, column: MemoryFlowColumnView, state: MemoryFlowInteractionState): string {
  const chips = visibleMemoryFlowChips(column, state, view);
  if (chips.length === 0) {
    return '-';
  }
  const selectedIndex = column.id === state.selectedColumnId ? state.selectedChipIndex : -1;
  return chips
    .slice(0, 2)
    .map((chip, index) => `${index === selectedIndex ? '> ' : ''}${chip.label}`)
    .join(', ');
}

function selectedLine(view: MemoryFlowViewModel, state: MemoryFlowInteractionState): string {
  const column = selectedMemoryFlowColumn(view, state);
  const chip = visibleMemoryFlowChips(column, state, view)[state.selectedChipIndex];
  return `Selected: ${column.title}${chip ? ` > ${chip.label}` : ''}`;
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

function searchLine(view: MemoryFlowViewModel, state: MemoryFlowInteractionState): string | null {
  if (!state.search.editing && state.search.query.length === 0) {
    return null;
  }

  const matches = findMemoryFlowSearchMatches(view, state.search.query);
  const active = state.search.editing ? 'editing' : 'locked';
  return `Search: ${state.search.query || '/'} (${matches.length} matches, ${active})`;
}

function detailLines(view: MemoryFlowViewModel, state: MemoryFlowInteractionState): string[] {
  const currentSearchLine = searchLine(view, state);
  return [
    selectedLine(view, state),
    `Pane: ${state.pane}  Filter: ${state.filter}`,
    ...(currentSearchLine ? [currentSearchLine] : []),
    ...selectedMemoryFlowDetails(view, state).map((detail) => `- ${detail}`),
  ];
}

function renderWide(view: MemoryFlowViewModel, state: MemoryFlowInteractionState): string {
  const lines = [
    view.title,
    view.activeLine,
    view.subtitle,
    renderMemoryFlowConnectorLine(view),
    ...trustIssueLines(view),
    '',
    row(view.columns.map((column) => columnLabel(column, state))),
    row(view.columns.map((column) => column.headline)),
    row(view.columns.map((column) => counterAt(column, 0))),
    row(view.columns.map((column) => counterAt(column, 1))),
    row(view.columns.map((column) => chipLabel(view, column, state))),
    '',
    ...detailLines(view, state),
  ];

  if (view.completionLine) {
    lines.push('', view.completionLine);
  }

  lines.push('');
  return lines.join('\n');
}

function renderNarrowColumn(
  view: MemoryFlowViewModel,
  column: MemoryFlowColumnView,
  state: MemoryFlowInteractionState,
): string[] {
  return [
    columnLabel(column, state),
    `  ${column.headline}`,
    ...column.counters.slice(0, 3).map((counter) => `  ${counter}`),
    `  ${chipLabel(view, column, state)}`,
  ];
}

function renderNarrow(view: MemoryFlowViewModel, state: MemoryFlowInteractionState): string {
  const lines = [
    view.title,
    view.activeLine,
    view.subtitle,
    renderMemoryFlowConnectorLine(view),
    ...trustIssueLines(view),
    '',
    ...view.columns.flatMap((column, index) => [
      ...(index > 0 ? [''] : []),
      ...renderNarrowColumn(view, column, state),
    ]),
    '',
    ...detailLines(view, state),
  ];

  if (view.completionLine) {
    lines.push('', view.completionLine);
  }

  lines.push('');
  return lines.join('\n');
}

export function renderMemoryFlowInteractive(
  view: MemoryFlowViewModel,
  state: MemoryFlowInteractionState,
  options: MemoryFlowRenderOptions = {},
): string {
  if ((options.terminalWidth ?? 120) < 100) {
    return renderNarrow(view, state);
  }
  return renderWide(view, state);
}
