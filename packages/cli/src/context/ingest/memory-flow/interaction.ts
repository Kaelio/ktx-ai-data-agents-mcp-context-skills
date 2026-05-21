import type {
  MemoryFlowChip,
  MemoryFlowColumnView,
  MemoryFlowFilterMode,
  MemoryFlowInteractionCommand,
  MemoryFlowInteractionState,
  MemoryFlowPaneId,
  MemoryFlowSearchMatch,
  MemoryFlowViewModel,
} from './types.js';

const CYCLING_PANES: MemoryFlowPaneId[] = ['overview', 'trust', 'details', 'log', 'provenance', 'transcript'];

function attentionStatus(status: MemoryFlowChip['status']): boolean {
  return status === 'failed' || status === 'warning';
}

function trustIssueTargets(view: MemoryFlowViewModel, column: MemoryFlowColumnView): Set<string> {
  return new Set(
    view.trustIssues
      .filter((issue) => issue.columnId === column.id && issue.targetLabel)
      .map((issue) => issue.targetLabel as string),
  );
}

function columnIndex(view: MemoryFlowViewModel, columnId: MemoryFlowInteractionState['selectedColumnId']): number {
  const index = view.columns.findIndex((column) => column.id === columnId);
  return index >= 0 ? index : 0;
}

function clampChipIndex(column: MemoryFlowColumnView, state: MemoryFlowInteractionState, view?: MemoryFlowViewModel): number {
  const chips = visibleMemoryFlowChips(column, state, view);
  if (chips.length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(state.selectedChipIndex, chips.length - 1));
}

function withColumn(
  view: MemoryFlowViewModel,
  state: MemoryFlowInteractionState,
  direction: -1 | 1,
): MemoryFlowInteractionState {
  const nextIndex = Math.max(0, Math.min(columnIndex(view, state.selectedColumnId) + direction, view.columns.length - 1));
  const selectedColumnId = view.columns[nextIndex]?.id ?? state.selectedColumnId;
  const nextState = { ...state, selectedColumnId, selectedChipIndex: 0, expanded: false };
  return { ...nextState, selectedChipIndex: clampChipIndex(selectedMemoryFlowColumn(view, nextState), nextState, view) };
}

function nextPane(current: MemoryFlowPaneId): MemoryFlowPaneId {
  const currentIndex = CYCLING_PANES.indexOf(current);
  if (currentIndex === -1) {
    return 'overview';
  }
  return CYCLING_PANES[(currentIndex + 1) % CYCLING_PANES.length] ?? 'overview';
}

function toggleFilter(filter: MemoryFlowFilterMode): MemoryFlowFilterMode {
  return filter === 'all' ? 'failed_or_flagged' : 'all';
}

export function visibleMemoryFlowChips(
  column: MemoryFlowColumnView,
  state: Pick<MemoryFlowInteractionState, 'filter'>,
  view?: MemoryFlowViewModel,
): MemoryFlowChip[] {
  if (state.filter === 'all') {
    return column.chips;
  }

  const issueTargets = view ? trustIssueTargets(view, column) : new Set<string>();
  return column.chips.filter((chip) => attentionStatus(chip.status) || issueTargets.has(chip.label));
}

function includesQuery(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function pushMatch(
  matches: MemoryFlowSearchMatch[],
  query: string,
  match: MemoryFlowSearchMatch,
  values: string[],
): void {
  if (values.some((value) => includesQuery(value, query))) {
    matches.push(match);
  }
}

export function findMemoryFlowSearchMatches(view: MemoryFlowViewModel, query: string): MemoryFlowSearchMatch[] {
  const normalized = query.trim();
  if (!normalized) {
    return [];
  }

  const matches: MemoryFlowSearchMatch[] = [];
  for (const column of view.columns) {
    const chipMatches = column.chips
      .map((chip, chipIndex) => ({ chip, chipIndex }))
      .filter(({ chip }) => includesQuery(chip.label, normalized) || includesQuery(chip.detail ?? '', normalized));

    for (const { chip, chipIndex } of chipMatches) {
      if (column.id === 'workUnits' || column.id === 'actions') {
        matches.push({
          columnId: column.id,
          chipIndex,
          label: `${column.title} > ${chip.label}`,
          detail: chip.detail ?? column.headline,
        });
      }
    }

    if (chipMatches.length === 0 || column.id !== 'workUnits') {
      pushMatch(matches, normalized, { columnId: column.id, label: column.title, detail: column.headline }, [
        column.title,
        column.headline,
        ...column.counters,
        ...column.details,
      ]);
    }
  }

  for (const issue of view.trustIssues) {
    pushMatch(
      matches,
      normalized,
      { columnId: issue.columnId, label: `Trust > ${issue.title}`, detail: issue.detail },
      [issue.title, issue.detail, issue.targetLabel ?? ''],
    );
  }

  for (const row of view.details.provenance) {
    pushMatch(
      matches,
      normalized,
      {
        columnId: 'saved',
        label: `Provenance > ${row.rawPath}`,
        detail: `${row.rawPath} ${row.artifactKind ?? 'none'} ${row.artifactKey ?? 'none'} ${row.actionType}`,
      },
      [row.rawPath, row.artifactKind ?? '', row.artifactKey ?? '', row.actionType],
    );
  }

  for (const transcript of view.details.transcripts) {
    pushMatch(
      matches,
      normalized,
      {
        columnId: 'workUnits',
        label: `Transcript > ${transcript.unitKey}`,
        detail: `${transcript.path} ${transcript.toolNames.join(' ')}`,
      },
      [transcript.unitKey, transcript.path, ...transcript.toolNames],
    );
  }

  return matches;
}

function selectSearchMatch(
  view: MemoryFlowViewModel,
  state: MemoryFlowInteractionState,
  query: string,
  matchIndex: number,
): MemoryFlowInteractionState {
  const matches = findMemoryFlowSearchMatches(view, query);
  if (matches.length === 0) {
    return {
      ...state,
      search: { editing: state.search.editing, query, matchIndex: 0 },
      shouldQuit: false,
    };
  }

  const index = Math.max(0, Math.min(matchIndex, matches.length - 1));
  const match = matches[index]!;
  const nextState = {
    ...state,
    selectedColumnId: match.columnId,
    selectedChipIndex: match.chipIndex ?? 0,
    expanded: true,
    search: { editing: state.search.editing, query, matchIndex: index },
    shouldQuit: false,
  };
  return {
    ...nextState,
    selectedChipIndex: clampChipIndex(selectedMemoryFlowColumn(view, nextState), nextState, view),
  };
}

function moveSearchMatch(
  view: MemoryFlowViewModel,
  state: MemoryFlowInteractionState,
  direction: -1 | 1,
): MemoryFlowInteractionState {
  const query = state.search.query.trim();
  if (!query) {
    return { ...state, search: { ...state.search, matchIndex: 0 }, shouldQuit: false };
  }

  const matches = findMemoryFlowSearchMatches(view, query);
  if (matches.length === 0) {
    return { ...state, search: { ...state.search, matchIndex: 0 }, shouldQuit: false };
  }

  const nextIndex = (state.search.matchIndex + direction + matches.length) % matches.length;
  return selectSearchMatch(view, state, state.search.query, nextIndex);
}

export function selectedMemoryFlowColumn(
  view: MemoryFlowViewModel,
  state: Pick<MemoryFlowInteractionState, 'selectedColumnId'>,
): MemoryFlowColumnView {
  return view.columns.find((column) => column.id === state.selectedColumnId) ?? view.columns[0]!;
}

export function createInitialMemoryFlowInteractionState(view: MemoryFlowViewModel): MemoryFlowInteractionState {
  const column =
    view.columns.find((candidate) => candidate.status === 'active') ??
    view.columns.find((candidate) => candidate.status === 'failed' || candidate.status === 'warning') ??
    view.columns.find((candidate) => candidate.details.length > 0) ??
    view.columns[0]!;

  return {
    selectedColumnId: column.id,
    selectedChipIndex: 0,
    expanded: false,
    pane: 'overview',
    filter: 'all',
    search: { editing: false, query: '', matchIndex: 0 },
    shouldQuit: false,
  };
}

/** @internal */
export function selectMemoryFlowColumn(
  view: MemoryFlowViewModel,
  state: MemoryFlowInteractionState,
  columnId: MemoryFlowInteractionState['selectedColumnId'],
): MemoryFlowInteractionState {
  const column = view.columns.find((candidate) => candidate.id === columnId);
  if (!column) {
    return { ...state, shouldQuit: false };
  }

  const nextState = {
    ...state,
    selectedColumnId: column.id,
    selectedChipIndex: 0,
    expanded: true,
    shouldQuit: false,
  };
  return { ...nextState, selectedChipIndex: clampChipIndex(column, nextState, view) };
}

/** @internal */
export function selectMemoryFlowChip(
  view: MemoryFlowViewModel,
  state: MemoryFlowInteractionState,
  columnId: MemoryFlowInteractionState['selectedColumnId'],
  chipIndex: number,
): MemoryFlowInteractionState {
  const column = view.columns.find((candidate) => candidate.id === columnId);
  if (!column) {
    return { ...state, shouldQuit: false };
  }

  const nextState = {
    ...state,
    selectedColumnId: column.id,
    selectedChipIndex: Math.max(0, chipIndex),
    expanded: true,
    shouldQuit: false,
  };
  return { ...nextState, selectedChipIndex: clampChipIndex(column, nextState, view) };
}

export function reduceMemoryFlowInteractionState(
  state: MemoryFlowInteractionState,
  command: MemoryFlowInteractionCommand,
  view: MemoryFlowViewModel,
): MemoryFlowInteractionState {
  if (command === 'search-start') {
    return { ...state, pane: 'details', search: { ...state.search, editing: true }, shouldQuit: false };
  }

  if (command === 'search-submit') {
    return { ...state, search: { ...state.search, editing: false }, shouldQuit: false };
  }

  if (command === 'search-clear') {
    return { ...state, search: { editing: false, query: '', matchIndex: 0 }, shouldQuit: false };
  }

  if (command === 'search-backspace') {
    return selectSearchMatch(view, state, state.search.query.slice(0, -1), 0);
  }

  if (command === 'search-next') {
    return moveSearchMatch(view, state, 1);
  }

  if (command === 'search-previous') {
    return moveSearchMatch(view, state, -1);
  }

  if (typeof command === 'object' && command.type === 'search-input') {
    return selectSearchMatch(view, state, `${state.search.query}${command.value}`, 0);
  }

  if (command === 'quit') {
    return { ...state, shouldQuit: true };
  }

  if (command === 'left') {
    return withColumn(view, { ...state, shouldQuit: false }, -1);
  }

  if (command === 'right') {
    return withColumn(view, { ...state, shouldQuit: false }, 1);
  }

  if (command === 'up' || command === 'down') {
    const column = selectedMemoryFlowColumn(view, state);
    const visibleChips = visibleMemoryFlowChips(column, state, view);
    const delta = command === 'up' ? -1 : 1;
    return {
      ...state,
      selectedChipIndex:
        visibleChips.length === 0
          ? 0
          : Math.max(0, Math.min(state.selectedChipIndex + delta, visibleChips.length - 1)),
      shouldQuit: false,
    };
  }

  if (command === 'enter') {
    return { ...state, expanded: !state.expanded, shouldQuit: false };
  }

  if (command === 'tab') {
    return { ...state, pane: nextPane(state.pane), shouldQuit: false };
  }

  if (command === 'filter') {
    const nextState = { ...state, filter: toggleFilter(state.filter), selectedChipIndex: 0, shouldQuit: false };
    return {
      ...nextState,
      selectedChipIndex: clampChipIndex(selectedMemoryFlowColumn(view, nextState), nextState, view),
    };
  }

  if (command === 'provenance') {
    return { ...state, pane: 'provenance', expanded: true, shouldQuit: false };
  }

  if (command === 'transcript') {
    return { ...state, pane: 'transcript', expanded: true, shouldQuit: false };
  }

  return { ...state, shouldQuit: false };
}

function trustIssueDetailLines(view: MemoryFlowViewModel): string[] {
  if (view.trustIssues.length === 0) {
    return ['No trust issues detected.'];
  }

  return view.trustIssues
    .slice()
    .sort((left, right) => {
      if (left.severity === right.severity) return 0;
      return left.severity === 'failed' ? -1 : 1;
    })
    .map((issue) => {
      const label = issue.severity === 'failed' ? 'FAILED' : 'WARNING';
      return `${label} ${issue.title}: ${issue.detail}`;
    });
}

function provenanceDetailLines(view: MemoryFlowViewModel): string[] {
  if (view.details.provenance.length === 0) {
    const savedColumn = view.columns.find((candidate) => candidate.id === 'saved');
    return savedColumn?.details.length ? savedColumn.details : ['Provenance rows: 0'];
  }

  return view.details.provenance.map((row) => {
    const artifact = row.artifactKind && row.artifactKey ? `${row.artifactKind}:${row.artifactKey}` : 'no saved artifact';
    return `${row.rawPath} -> ${artifact} (${row.actionType})`;
  });
}

function transcriptDetailLines(view: MemoryFlowViewModel, selectedChip: MemoryFlowChip | undefined): string[] {
  const selectedUnit = selectedChip?.label;
  const transcripts =
    selectedUnit && view.details.transcripts.some((summary) => summary.unitKey === selectedUnit)
      ? view.details.transcripts.filter((summary) => summary.unitKey === selectedUnit)
      : view.details.transcripts;

  if (transcripts.length === 0) {
    const workUnitsColumn = view.columns.find((candidate) => candidate.id === 'workUnits');
    return workUnitsColumn?.details.length ? workUnitsColumn.details : ['No work-unit transcript summary available.'];
  }

  return transcripts.map(
    (summary) =>
      `${summary.unitKey}: ${summary.toolCallCount} tool calls, ${summary.errorCount} errors, tools ${
        summary.toolNames.join(', ') || 'none'
      }`,
  );
}

export function selectedMemoryFlowDetails(view: MemoryFlowViewModel, state: MemoryFlowInteractionState): string[] {
  const column = selectedMemoryFlowColumn(view, state);
  const chips = visibleMemoryFlowChips(column, state, view);
  const selectedChip = chips[state.selectedChipIndex];

  if (state.pane === 'log') {
    return [
      view.activeLine,
      ...view.columns.map((candidate) => `${candidate.title} ${candidate.status}: ${candidate.headline}`),
      ...(view.completionLine ? [view.completionLine] : []),
    ];
  }

  if (state.pane === 'trust') {
    return trustIssueDetailLines(view);
  }

  if (state.pane === 'provenance') {
    return provenanceDetailLines(view);
  }

  if (state.pane === 'transcript') {
    return transcriptDetailLines(view, selectedChip);
  }

  const baseDetails = column.details.length ? column.details : [`${column.title}: ${column.headline}`];
  if (state.pane === 'overview' && !state.expanded) {
    return [
      column.headline,
      ...column.counters,
      ...(selectedChip ? [`Selected chip: ${selectedChip.label}${selectedChip.detail ? ` (${selectedChip.detail})` : ''}`] : []),
    ];
  }

  return [
    ...baseDetails,
    ...(selectedChip ? [`Selected chip: ${selectedChip.label}${selectedChip.detail ? ` (${selectedChip.detail})` : ''}`] : []),
  ];
}
