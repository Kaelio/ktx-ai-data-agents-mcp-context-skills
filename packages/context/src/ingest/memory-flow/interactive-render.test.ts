import { describe, expect, it } from 'vitest';
import { createInitialMemoryFlowInteractionState, reduceMemoryFlowInteractionState } from './interaction.js';
import { renderMemoryFlowInteractive } from './interactive-render.js';
import type { MemoryFlowViewModel } from './types.js';

function view(): MemoryFlowViewModel {
  return {
    title: 'KTX memory flow  warehouse/metricflow  done',
    subtitle: 'Run run-1  Sync sync-1',
    status: 'done',
    activeLine: 'active: complete',
    selectedTitle: 'WORKUNITS',
    selectedDetails: ['orders: 1 raw, 0 peers, 1 deps'],
    completionLine:
      'Saved 2 memories from 2 raw files: 1 wiki pages, 1 SL updates. Commit: abc12345  Run: run-1  Report: report-1',
    trustIssues: [
      {
        id: 'work-unit-failed:customers',
        severity: 'failed',
        title: 'WorkUnit failed',
        detail: 'customers failed: validation reset',
        columnId: 'workUnits',
        targetLabel: 'customers',
      },
      {
        id: 'flagged-fallbacks',
        severity: 'warning',
        title: 'Flagged fallbacks',
        detail: '1 fallback needs review',
        columnId: 'gates',
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
        status: 'warning',
        headline: '2 WUs',
        counters: ['1 done', '1 failed', '0 active'],
        chips: [
          { label: 'orders', status: 'complete', detail: '1 raw span' },
          { label: 'customers', status: 'failed', detail: 'validation reset' },
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
        details: ['Failed work units: 1', 'Flagged fallbacks: 1'],
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

describe('renderMemoryFlowInteractive', () => {
  it('marks the selected column and selected chip in a wide layout', () => {
    const state = createInitialMemoryFlowInteractionState(view());

    const output = renderMemoryFlowInteractive(view(), state, { terminalWidth: 140 });

    expect(output).toContain('KTX memory flow  warehouse/metricflow  done');
    expect(output).toContain('OK SOURCE -> OK CHUNKS -> !! WORKUNITS -> OK ACTIONS -> !! GATES -> OK SAVED');
    expect(output).toContain('[WORKUNITS]');
    expect(output).toContain('> orders');
    expect(output).toContain('Selected: WORKUNITS > orders');
    expect(output).toContain('Pane: overview  Filter: all');
    expect(output).toContain('- Selected chip: orders (1 raw span)');
    expect(output).toContain(
      'Saved 2 memories from 2 raw files: 1 wiki pages, 1 SL updates. Commit: abc12345  Run: run-1  Report: report-1',
    );
  });

  it('renders attention-filtered details in a narrow layout', () => {
    let state = createInitialMemoryFlowInteractionState(view());
    state = reduceMemoryFlowInteractionState(state, 'filter', view());
    state = reduceMemoryFlowInteractionState(state, 'enter', view());

    const output = renderMemoryFlowInteractive(view(), state, { terminalWidth: 72 });

    expect(output).toContain('OK SOURCE -> OK CHUNKS -> !! WORKUNITS -> OK ACTIONS -> !! GATES -> OK SAVED');
    expect(output).toContain('[WORKUNITS]');
    expect(output).toContain('Filter: failed_or_flagged');
    expect(output).toContain('> customers');
    expect(output).toContain('- customers: 1 raw, 0 peers, 0 deps');
  });

  it('renders report-backed transcript detail pane rows', () => {
    let state = createInitialMemoryFlowInteractionState(view());
    state = reduceMemoryFlowInteractionState(state, 'down', view());
    state = reduceMemoryFlowInteractionState(state, 'transcript', view());

    const output = renderMemoryFlowInteractive(view(), state, { terminalWidth: 100 });

    expect(output).toContain('Pane: transcript  Filter: all');
    expect(output).toContain('- customers: 2 tool calls, 1 errors, tools read_raw_span, sl_write_source');
  });

  it('keeps trust issues visible in the interactive renderer', () => {
    const state = createInitialMemoryFlowInteractionState(view());

    const output = renderMemoryFlowInteractive(view(), state, { terminalWidth: 140 });

    expect(output).toContain('Trust issues');
    expect(output).toContain('FAILED WorkUnit failed: customers failed: validation reset');
    expect(output).toContain('WARNING Flagged fallbacks: 1 fallback needs review');
  });
});
