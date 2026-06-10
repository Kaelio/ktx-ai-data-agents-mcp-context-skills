import { describe, expect, it } from 'vitest';
import {
  createInitialMemoryFlowInteractionState,
  findMemoryFlowSearchMatches,
  reduceMemoryFlowInteractionState,
  selectMemoryFlowChip,
  selectMemoryFlowColumn,
  selectedMemoryFlowColumn,
  selectedMemoryFlowDetails,
  visibleMemoryFlowChips,
} from '../../../../src/context/ingest/memory-flow/interaction.js';
import type { MemoryFlowInteractionState, MemoryFlowViewModel } from '../../../../src/context/ingest/memory-flow/types.js';

function view(): MemoryFlowViewModel {
  return {
    title: 'ktx memory flow  warehouse/metricflow  running',
    subtitle: 'Run run-1  Sync sync-1',
    status: 'running',
    activeLine: 'active: WorkUnit orders step 2/4',
    selectedTitle: 'WORKUNITS',
    selectedDetails: ['orders: 1 raw, 0 peers, 1 deps'],
    completionLine: null,
    trustIssues: [
      {
        id: 'flagged-fallbacks',
        severity: 'warning',
        title: 'Flagged fallbacks',
        detail: '1 fallback needs review',
        columnId: 'gates',
      },
      {
        id: 'work-unit-failed:customers',
        severity: 'failed',
        title: 'WorkUnit failed',
        detail: 'customers failed: semantic-layer validation failed',
        columnId: 'workUnits',
        targetLabel: 'customers',
      },
    ],
    details: {
      actions: [
        {
          unitKey: 'orders',
          target: 'wiki',
          action: 'created',
          key: 'wiki/orders.md',
          summary: 'order facts',
          rawFiles: ['orders.yml'],
          status: 'success',
        },
      ],
      provenance: [
        {
          rawPath: 'orders.yml',
          artifactKind: 'wiki',
          artifactKey: 'wiki/orders.md',
          actionType: 'wiki_written',
        },
      ],
      transcripts: [
        {
          unitKey: 'customers',
          path: '/tmp/transcripts/customers.jsonl',
          toolCallCount: 2,
          errorCount: 1,
          toolNames: ['read_raw_span', 'sl_write_source'],
        },
      ],
    },
    columns: [
      {
        id: 'source',
        title: 'SOURCE',
        status: 'complete',
        headline: '2 raw files',
        counters: ['sync sync-1', 'scope none'],
        chips: [{ label: 'metricflow', status: 'complete' }],
        details: ['Trigger: manual_resync', 'Adapter: metricflow'],
      },
      {
        id: 'chunks',
        title: 'CHUNKS',
        status: 'complete',
        headline: '2 chunks',
        counters: ['+1 ~1 -0 =0', '0 deletions'],
        chips: [{ label: 'orders', status: 'complete' }],
        details: ['Work units planned: 2', 'Eviction candidates: 0'],
      },
      {
        id: 'workUnits',
        title: 'WORKUNITS',
        status: 'active',
        headline: '2 WUs',
        counters: ['1 done', '1 failed', '1 active'],
        chips: [
          { label: 'orders', status: 'complete', detail: '1 raw span' },
          { label: 'customers', status: 'failed', detail: 'semantic-layer validation failed' },
        ],
        details: ['orders: 1 raw, 0 peers, 1 deps', 'customers: 1 raw, 0 peers, 0 deps'],
      },
      {
        id: 'actions',
        title: 'ACTIONS',
        status: 'complete',
        headline: '2 candidates',
        counters: ['1 wiki', '1 SL'],
        chips: [{ label: 'wiki/orders.md', status: 'complete' }],
        details: ['wiki created: wiki/orders.md', 'sl updated: warehouse.orders'],
      },
      {
        id: 'gates',
        title: 'GATES',
        status: 'warning',
        headline: '0 conflict, 1 fallback',
        counters: ['1 failed', '1 flagged'],
        chips: [{ label: 'customers', status: 'failed' }],
        details: ['Failed work units: 1', 'Flagged fallbacks: 1', 'customers: semantic-layer validation failed'],
      },
      {
        id: 'saved',
        title: 'SAVED',
        status: 'complete',
        headline: '2 memories',
        counters: ['1 wiki', '1 SL', '2 provenance'],
        chips: [{ label: 'abc12345', status: 'complete' }],
        details: ['Commit: abc12345', 'Run: run-1', 'Report: report-1', 'Provenance rows: 2'],
      },
    ],
  };
}

describe('memory-flow interaction reducer', () => {
  it('selects the active work-unit column by default', () => {
    const state = createInitialMemoryFlowInteractionState(view());

    expect(state).toEqual({
      selectedColumnId: 'workUnits',
      selectedChipIndex: 0,
      expanded: false,
      pane: 'overview',
      filter: 'all',
      search: { editing: false, query: '', matchIndex: 0 },
      shouldQuit: false,
    });
    expect(selectedMemoryFlowColumn(view(), state).title).toBe('WORKUNITS');
  });

  it('moves between columns and clamps chip selection', () => {
    let state = createInitialMemoryFlowInteractionState(view());

    state = reduceMemoryFlowInteractionState(state, 'down', view());
    state = reduceMemoryFlowInteractionState(state, 'down', view());
    expect(state.selectedChipIndex).toBe(1);

    state = reduceMemoryFlowInteractionState(state, 'right', view());
    expect(state.selectedColumnId).toBe('actions');
    expect(state.selectedChipIndex).toBe(0);

    state = reduceMemoryFlowInteractionState(state, 'left', view());
    expect(state.selectedColumnId).toBe('workUnits');
    expect(state.selectedChipIndex).toBe(0);
  });

  it('selects a column directly for mouse-driven renderers', () => {
    const initial = createInitialMemoryFlowInteractionState(view());

    const selected = selectMemoryFlowColumn(view(), initial, 'actions');

    expect(selected).toMatchObject({
      selectedColumnId: 'actions',
      selectedChipIndex: 0,
      expanded: true,
      shouldQuit: false,
    });
    expect(selectedMemoryFlowColumn(view(), selected).title).toBe('ACTIONS');
    expect(selectedMemoryFlowDetails(view(), selected)).toContain('wiki created: wiki/orders.md');
  });

  it('selects and clamps a chip directly for mouse-driven renderers', () => {
    const initial = createInitialMemoryFlowInteractionState(view());

    const selected = selectMemoryFlowChip(view(), initial, 'workUnits', 99);

    expect(selected).toMatchObject({
      selectedColumnId: 'workUnits',
      selectedChipIndex: 1,
      expanded: true,
      shouldQuit: false,
    });
    expect(selectedMemoryFlowDetails(view(), selected)).toContain(
      'Selected chip: customers (semantic-layer validation failed)',
    );
  });

  it('ignores direct selection of an unknown column', () => {
    const initial = createInitialMemoryFlowInteractionState(view());

    const selected = selectMemoryFlowColumn(view(), initial, 'missing' as never);

    expect(selected).toEqual({ ...initial, shouldQuit: false });
  });

  it('toggles expansion, attention filtering, all panes, and quit', () => {
    let state: MemoryFlowInteractionState = createInitialMemoryFlowInteractionState(view());

    state = reduceMemoryFlowInteractionState(state, 'enter', view());
    expect(state.expanded).toBe(true);
    expect(selectedMemoryFlowDetails(view(), state)).toContain('orders: 1 raw, 0 peers, 1 deps');

    state = reduceMemoryFlowInteractionState(state, 'filter', view());
    expect(state.filter).toBe('failed_or_flagged');
    expect(visibleMemoryFlowChips(selectedMemoryFlowColumn(view(), state), state)).toEqual([
      { label: 'customers', status: 'failed', detail: 'semantic-layer validation failed' },
    ]);

    state = reduceMemoryFlowInteractionState(state, 'tab', view());
    expect(state.pane).toBe('trust');

    state = reduceMemoryFlowInteractionState(state, 'tab', view());
    expect(state.pane).toBe('details');

    state = reduceMemoryFlowInteractionState(state, 'tab', view());
    expect(state.pane).toBe('log');
    expect(selectedMemoryFlowDetails(view(), state)).toContain('WORKUNITS active: 2 WUs');

    state = reduceMemoryFlowInteractionState(state, 'tab', view());
    expect(state.pane).toBe('provenance');
    expect(selectedMemoryFlowDetails(view(), state)).toContain(
      'orders.yml -> wiki:wiki/orders.md (wiki_written)',
    );

    state = reduceMemoryFlowInteractionState(state, 'tab', view());
    expect(state.pane).toBe('transcript');
    expect(selectedMemoryFlowDetails(view(), state)).toContain(
      'customers: 2 tool calls, 1 errors, tools read_raw_span, sl_write_source',
    );

    state = reduceMemoryFlowInteractionState(state, 'tab', view());
    expect(state.pane).toBe('overview');

    state = reduceMemoryFlowInteractionState(state, 'provenance', view());
    expect(state.pane).toBe('provenance');
    expect(selectedMemoryFlowDetails(view(), state)).toContain(
      'orders.yml -> wiki:wiki/orders.md (wiki_written)',
    );

    state = reduceMemoryFlowInteractionState(state, 'transcript', view());
    expect(state.pane).toBe('transcript');
    expect(selectedMemoryFlowDetails(view(), state)).toContain(
      'customers: 2 tool calls, 1 errors, tools read_raw_span, sl_write_source',
    );

    state = reduceMemoryFlowInteractionState(state, 'quit', view());
    expect(state.shouldQuit).toBe(true);
  });

  it('shows trust issue details and filters chips using issue targets', () => {
    let state: MemoryFlowInteractionState = createInitialMemoryFlowInteractionState(view());

    state = reduceMemoryFlowInteractionState(state, 'tab', view());
    expect(state.pane).toBe('trust');
    expect(selectedMemoryFlowDetails(view(), state)).toEqual([
      'FAILED WorkUnit failed: customers failed: semantic-layer validation failed',
      'WARNING Flagged fallbacks: 1 fallback needs review',
    ]);

    state = reduceMemoryFlowInteractionState(state, 'filter', view());
    expect(visibleMemoryFlowChips(selectedMemoryFlowColumn(view(), state), state, view())).toEqual([
      { label: 'customers', status: 'failed', detail: 'semantic-layer validation failed' },
    ]);
  });

  it('searches across columns, trust issues, actions, provenance, and transcripts', () => {
    const matches = findMemoryFlowSearchMatches(view(), 'customers');

    expect(matches.map((match) => match.label)).toEqual([
      'WORKUNITS > customers',
      'GATES',
      'Trust > WorkUnit failed',
      'Transcript > customers',
    ]);

    let state = createInitialMemoryFlowInteractionState(view());
    state = reduceMemoryFlowInteractionState(state, 'search-start', view());
    state = reduceMemoryFlowInteractionState(state, { type: 'search-input', value: 'customers' }, view());

    expect(state.search).toEqual({
      editing: true,
      query: 'customers',
      matchIndex: 0,
    });
    expect(state.selectedColumnId).toBe('workUnits');
    expect(state.selectedChipIndex).toBe(1);

    state = reduceMemoryFlowInteractionState(state, 'search-submit', view());
    expect(state.search.editing).toBe(false);
  });

  it('cycles search matches forward and backward with wraparound', () => {
    let state = createInitialMemoryFlowInteractionState(view());
    state = reduceMemoryFlowInteractionState(state, 'search-start', view());
    state = reduceMemoryFlowInteractionState(state, { type: 'search-input', value: 'customers' }, view());

    expect(state.search).toEqual({ editing: true, query: 'customers', matchIndex: 0 });
    expect(state.selectedColumnId).toBe('workUnits');
    expect(state.selectedChipIndex).toBe(1);

    state = reduceMemoryFlowInteractionState(state, 'search-next', view());
    expect(state.search).toEqual({ editing: true, query: 'customers', matchIndex: 1 });
    expect(state.selectedColumnId).toBe('gates');
    expect(state.selectedChipIndex).toBe(0);

    state = reduceMemoryFlowInteractionState(state, 'search-next', view());
    expect(state.search).toEqual({ editing: true, query: 'customers', matchIndex: 2 });
    expect(state.selectedColumnId).toBe('workUnits');

    state = reduceMemoryFlowInteractionState(state, 'search-previous', view());
    expect(state.search).toEqual({ editing: true, query: 'customers', matchIndex: 1 });
    expect(state.selectedColumnId).toBe('gates');

    state = reduceMemoryFlowInteractionState(state, 'search-previous', view());
    state = reduceMemoryFlowInteractionState(state, 'search-previous', view());
    expect(state.search).toEqual({ editing: true, query: 'customers', matchIndex: 3 });
    expect(state.selectedColumnId).toBe('workUnits');
  });
});
