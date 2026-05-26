import { describe, expect, it } from 'vitest';
import type { MemoryFlowViewModel } from '../../../../src/context/ingest/memory-flow/types.js';
import { renderMemoryFlowReplay } from '../../../../src/context/ingest/memory-flow/render.js';

function view(): MemoryFlowViewModel {
  return {
    title: 'KTX memory flow  warehouse/metricflow  done',
    subtitle: 'Run run-1  Sync sync-1',
    status: 'done',
    activeLine: 'active: complete',
    selectedTitle: 'SOURCE',
    selectedDetails: ['Trigger: manual_resync', 'Adapter: metricflow'],
    completionLine:
      'Saved 2 memories from 2 raw files: 1 wiki pages, 1 SL updates. Commit: abc12345  Run: run-1  Report: report-1',
    trustIssues: [],
    details: { actions: [], provenance: [], transcripts: [] },
    columns: [
      {
        id: 'source',
        title: 'SOURCE',
        status: 'complete',
        headline: '2 raw files',
        counters: ['sync sync-1', 'scope none'],
        chips: [{ label: 'metricflow', status: 'complete' }],
        details: ['Trigger: manual_resync'],
      },
      {
        id: 'chunks',
        title: 'CHUNKS',
        status: 'complete',
        headline: '2 chunks',
        counters: ['+1 ~1 -0 =3', '0 deletions'],
        chips: [{ label: 'orders', status: 'complete' }],
        details: ['Work units planned: 2'],
      },
      {
        id: 'workUnits',
        title: 'WORKUNITS',
        status: 'warning',
        headline: '2 WUs',
        counters: ['1 done', '1 failed', '0 active'],
        chips: [{ label: 'orders', status: 'complete' }],
        details: ['orders: 1 raw, 1 peers, 1 deps'],
      },
      {
        id: 'actions',
        title: 'ACTIONS',
        status: 'complete',
        headline: '2 candidates',
        counters: ['1 wiki', '1 SL'],
        chips: [{ label: 'wiki/orders.md', status: 'complete' }],
        details: ['wiki created: wiki/orders.md'],
      },
      {
        id: 'gates',
        title: 'GATES',
        status: 'warning',
        headline: '1 conflict, 1 fallback',
        counters: ['1 failed', '1 flagged'],
        chips: [{ label: 'customers', status: 'failed' }],
        details: ['Failed work units: 1'],
      },
      {
        id: 'saved',
        title: 'SAVED',
        status: 'complete',
        headline: '2 memories',
        counters: ['1 wiki', '1 SL', '3 provenance'],
        chips: [{ label: 'abc12345', status: 'complete' }],
        details: ['Commit: abc12345'],
      },
    ],
  };
}

describe('renderMemoryFlowReplay', () => {
  it('renders a six-column wide terminal snapshot', () => {
    expect(renderMemoryFlowReplay(view(), { terminalWidth: 140 })).toContain(
      'OK SOURCE -> OK CHUNKS -> !! WORKUNITS -> OK ACTIONS -> !! GATES -> OK SAVED',
    );
    expect(renderMemoryFlowReplay(view(), { terminalWidth: 140 })).toMatchInlineSnapshot(`
      "KTX memory flow  warehouse/metricflow  done
      active: complete
      Run run-1  Sync sync-1
      OK SOURCE -> OK CHUNKS -> !! WORKUNITS -> OK ACTIONS -> !! GATES -> OK SAVED

      SOURCE                CHUNKS                WORKUNITS             ACTIONS               GATES                 SAVED
      2 raw files           2 chunks              2 WUs                 2 candidates          1 conflict, 1 fallb   2 memories
      sync sync-1           +1 ~1 -0 =3           1 done                1 wiki                1 failed              1 wiki
      scope none            0 deletions           1 failed              1 SL                  1 flagged             1 SL

      Selected: SOURCE
      - Trigger: manual_resync
      - Adapter: metricflow

      Saved 2 memories from 2 raw files: 1 wiki pages, 1 SL updates. Commit: abc12345  Run: run-1  Report: report-1
      "
    `);
  });

  it('renders a stacked narrow terminal snapshot', () => {
    expect(renderMemoryFlowReplay(view(), { terminalWidth: 72 })).toContain(
      'OK SOURCE -> OK CHUNKS -> !! WORKUNITS -> OK ACTIONS -> !! GATES -> OK SAVED',
    );
    expect(renderMemoryFlowReplay(view(), { terminalWidth: 72 })).toContain(`SOURCE
  2 raw files
  sync sync-1
  scope none`);
    expect(renderMemoryFlowReplay(view(), { terminalWidth: 72 })).toContain(`GATES
  1 conflict, 1 fallback
  1 failed
  1 flagged`);
  });
});
