import { describe, expect, it, vi } from 'vitest';
import { createMemoryFlowLiveBuffer, sanitizeMemoryFlowError } from './live-buffer.js';
import type { MemoryFlowReplayInput } from './types.js';

function initialReplay(): MemoryFlowReplayInput {
  return {
    runId: 'live-run-1',
    connectionId: 'warehouse',
    adapter: 'fake',
    status: 'running',
    sourceDir: '/tmp/source',
    syncId: 'pending',
    errors: [],
    events: [],
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
  };
}

describe('createMemoryFlowLiveBuffer', () => {
  it('emits immutable replay snapshots on every live change', () => {
    const onChange = vi.fn();
    const buffer = createMemoryFlowLiveBuffer(initialReplay(), { onChange });

    buffer.emit({ type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 2 });
    buffer.update({
      syncId: 'sync-1',
      plannedWorkUnits: [
        {
          unitKey: 'fake-orders',
          rawFiles: ['orders.json'],
          peerFileCount: 0,
          dependencyCount: 0,
        },
      ],
    });
    buffer.emit({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 });
    buffer.finish('done');

    expect(onChange).toHaveBeenCalledTimes(4);
    expect(buffer.snapshot()).toMatchObject({
      runId: 'live-run-1',
      status: 'done',
      syncId: 'sync-1',
      plannedWorkUnits: [{ unitKey: 'fake-orders' }],
    });
    expect(buffer.snapshot().events.map((event) => event.type)).toEqual(['source_acquired', 'chunks_planned']);

    const staleSnapshot = onChange.mock.calls[1][0] as MemoryFlowReplayInput;
    expect(staleSnapshot.details).toEqual({ actions: [], provenance: [], transcripts: [] });
    staleSnapshot.events.push({ type: 'report_created', runId: 'mutated' });
    expect(buffer.snapshot().events.map((event) => event.type)).toEqual(['source_acquired', 'chunks_planned']);
  });

  it('stamps live events with emittedAt without mutating caller events', () => {
    const event = { type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 2 } as const;
    const buffer = createMemoryFlowLiveBuffer(initialReplay(), {
      now: () => new Date('2026-05-01T10:00:00.000Z'),
    });

    buffer.emit(event);

    expect(event).not.toHaveProperty('emittedAt');
    expect(buffer.snapshot().events).toEqual([
      {
        type: 'source_acquired',
        adapter: 'fake',
        trigger: 'manual_resync',
        fileCount: 2,
        emittedAt: '2026-05-01T10:00:00.000Z',
      },
    ]);
  });

  it('marks failed runs with sanitized error messages', () => {
    const onChange = vi.fn();
    const buffer = createMemoryFlowLiveBuffer(initialReplay(), { onChange });

    buffer.finish('error', [
      sanitizeMemoryFlowError(
        new Error('Connection failed for postgres://user:password@localhost:5432/db?api_key=abc password=secret'), // pragma: allowlist secret
      ),
    ]);

    expect(buffer.snapshot()).toMatchObject({
      status: 'error',
      errors: ['Connection failed for postgres://[redacted] password=[redacted]'],
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
