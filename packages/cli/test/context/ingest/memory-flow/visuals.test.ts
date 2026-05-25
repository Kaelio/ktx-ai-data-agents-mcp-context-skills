import { describe, expect, it } from 'vitest';
import {
  buildMemoryFlowVisualModel,
  memoryFlowStatusBadge,
  renderMemoryFlowConnectorLine,
} from '../../../../src/context/ingest/memory-flow/visuals.js';
import type { MemoryFlowViewModel } from '../../../../src/context/ingest/memory-flow/types.js';

function viewWithStatuses(statuses: Array<'waiting' | 'active' | 'complete' | 'warning' | 'failed'>): MemoryFlowViewModel {
  const titles = ['SOURCE', 'CHUNKS', 'WORKUNITS', 'ACTIONS', 'GATES', 'SAVED'];
  const ids = ['source', 'chunks', 'workUnits', 'actions', 'gates', 'saved'] as const;

  return {
    title: 'KTX memory flow  warehouse/metricflow  running',
    subtitle: 'Run run-1  Sync sync-1',
    status: 'running',
    activeLine: 'active: WorkUnit orders',
    selectedTitle: 'WORKUNITS',
    selectedDetails: ['orders: 1 raw, 0 peers, 1 deps'],
    completionLine: null,
    trustIssues: [],
    details: { actions: [], provenance: [], transcripts: [] },
    columns: statuses.map((status, index) => ({
      id: ids[index],
      title: titles[index],
      status,
      headline: `${titles[index].toLowerCase()} headline`,
      counters: [],
      chips: [],
      details: [],
    })),
  };
}

describe('memory-flow visual helpers', () => {
  it('uses ASCII badges with text meaning for every status', () => {
    expect(memoryFlowStatusBadge('waiting')).toEqual({ label: '..', text: 'waiting' });
    expect(memoryFlowStatusBadge('active')).toEqual({ label: '>>', text: 'active' });
    expect(memoryFlowStatusBadge('complete')).toEqual({ label: 'OK', text: 'complete' });
    expect(memoryFlowStatusBadge('warning')).toEqual({ label: '!!', text: 'warning' });
    expect(memoryFlowStatusBadge('failed')).toEqual({ label: 'XX', text: 'failed' });
  });

  it('renders a no-color connector line with status badges and six columns', () => {
    const view = viewWithStatuses(['complete', 'complete', 'active', 'waiting', 'waiting', 'waiting']);

    expect(renderMemoryFlowConnectorLine(view)).toBe(
      'OK SOURCE -> OK CHUNKS -> >> WORKUNITS -> .. ACTIONS -> .. GATES -> .. SAVED',
    );
  });

  it('moves the pulse to the active column, then warnings, failures, and the last completed column', () => {
    expect(
      buildMemoryFlowVisualModel(viewWithStatuses(['complete', 'complete', 'active', 'waiting', 'waiting', 'waiting']))
        .pulseColumnId,
    ).toBe('workUnits');
    expect(
      buildMemoryFlowVisualModel(viewWithStatuses(['complete', 'warning', 'complete', 'waiting', 'waiting', 'waiting']))
        .pulseColumnId,
    ).toBe('chunks');
    expect(
      buildMemoryFlowVisualModel(viewWithStatuses(['complete', 'complete', 'failed', 'waiting', 'waiting', 'waiting']))
        .pulseColumnId,
    ).toBe('workUnits');
    expect(
      buildMemoryFlowVisualModel(viewWithStatuses(['complete', 'complete', 'complete', 'complete', 'waiting', 'waiting']))
        .pulseColumnId,
    ).toBe('actions');
  });
});
