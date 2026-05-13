import { describe, expect, it } from 'vitest';
import {
  memoryFlowReplayInputSchema,
  memoryFlowStreamEventSchema,
  parseMemoryFlowReplayInput,
} from './schema.js';
import type { MemoryFlowReplayInput } from './types.js';

function snapshot(overrides: Partial<MemoryFlowReplayInput> = {}): MemoryFlowReplayInput {
  return {
    runId: 'job-1',
    connectionId: 'connection-1',
    adapter: 'metabase',
    status: 'running',
    sourceDir: null,
    syncId: 'sync-1',
    errors: [],
    events: [
      { type: 'source_acquired', adapter: 'metabase', trigger: 'manual_resync', fileCount: 2 },
      { type: 'scope_detected', fingerprint: 'scope-1' },
      { type: 'raw_snapshot_written', syncId: 'sync-1', rawFileCount: 2 },
      { type: 'diff_computed', added: 1, modified: 1, deleted: 0, unchanged: 0 },
      { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
      { type: 'work_unit_started', unitKey: 'orders', skills: ['wiki_capture'], stepBudget: 40 },
      { type: 'work_unit_step', unitKey: 'orders', stepIndex: 1, stepBudget: 40 },
      { type: 'candidate_action', unitKey: 'orders', target: 'wiki', action: 'created', key: 'wiki/orders.md' },
      { type: 'work_unit_finished', unitKey: 'orders', status: 'success' },
      { type: 'reconciliation_finished', conflictCount: 0, fallbackCount: 0 },
      { type: 'saved', commitSha: 'abc12345', wikiCount: 1, slCount: 0 },
      { type: 'provenance_recorded', rowCount: 1 },
      { type: 'report_created', runId: 'run-1', reportPath: 'ingest-report.json' },
    ],
    plannedWorkUnits: [{ unitKey: 'orders', rawFiles: ['orders.md'], peerFileCount: 0, dependencyCount: 1 }],
    details: {
      actions: [
        {
          unitKey: 'orders',
          target: 'wiki',
          action: 'created',
          key: 'wiki/orders.md',
          summary: 'Created orders page',
          rawFiles: ['orders.md'],
          status: 'success',
        },
      ],
      provenance: [
        {
          rawPath: 'orders.md',
          artifactKind: 'wiki',
          artifactKey: 'wiki/orders.md',
          actionType: 'wiki_written',
        },
      ],
      transcripts: [
        {
          unitKey: 'orders',
          path: 'transcripts/orders.jsonl',
          toolCallCount: 2,
          errorCount: 0,
          toolNames: ['wiki_write'],
        },
      ],
    },
    ...overrides,
  };
}

describe('memory-flow schemas', () => {
  it('parses a full replay input snapshot', () => {
    expect(parseMemoryFlowReplayInput(snapshot())).toEqual(snapshot());
  });

  it('parses replay metadata and timestamped events', () => {
    const parsed = parseMemoryFlowReplayInput(
      snapshot({
        metadata: {
          schemaVersion: 1,
          mode: 'full',
          origin: 'captured',
          timing: 'captured',
          capturedAt: '2026-05-01T10:00:03.000Z',
          sourceReportId: 'report-1',
          sourceReportPath: 'reports/report-1.json',
          fallbackReason: null,
        },
        events: [
          {
            type: 'source_acquired',
            adapter: 'metabase',
            trigger: 'manual_resync',
            fileCount: 2,
            emittedAt: '2026-05-01T10:00:00.000Z',
          },
        ],
      }),
    );

    expect(parsed.metadata).toEqual({
      schemaVersion: 1,
      mode: 'full',
      origin: 'captured',
      timing: 'captured',
      capturedAt: '2026-05-01T10:00:03.000Z',
      sourceReportId: 'report-1',
      sourceReportPath: 'reports/report-1.json',
      fallbackReason: null,
    });
    expect(parsed.events).toEqual([
      {
        type: 'source_acquired',
        adapter: 'metabase',
        trigger: 'manual_resync',
        fileCount: 2,
        emittedAt: '2026-05-01T10:00:00.000Z',
      },
    ]);
  });

  it('parses skipped deterministic stages', () => {
    const parsed = parseMemoryFlowReplayInput(
      snapshot({
        status: 'done',
        events: [
          { type: 'source_acquired', adapter: 'live-database', trigger: 'demo_deterministic', fileCount: 7 },
          { type: 'scope_detected', fingerprint: 'sqlite' },
          { type: 'raw_snapshot_written', syncId: 'sync-demo', rawFileCount: 7 },
          { type: 'diff_computed', added: 7, modified: 0, deleted: 0, unchanged: 0 },
          { type: 'chunks_planned', chunkCount: 7, workUnitCount: 0, evictionCount: 0 },
          { type: 'stage_skipped', stage: 'workUnits', reason: 'deterministic mode' },
          { type: 'stage_skipped', stage: 'actions', reason: 'requires LLM' },
          { type: 'stage_skipped', stage: 'gates', reason: 'requires candidate actions' },
          { type: 'stage_skipped', stage: 'saved', reason: 'requires LLM memory synthesis' },
          { type: 'saved', commitSha: null, wikiCount: 0, slCount: 0 },
          { type: 'provenance_recorded', rowCount: 0 },
          {
            type: 'report_created',
            runId: 'scan-demo',
            reportPath: 'raw-sources/orbit_demo/live-database/sync-demo/scan-report.json',
          },
        ],
      }),
    );

    expect(parsed.events).toContainEqual({ type: 'stage_skipped', stage: 'workUnits', reason: 'deterministic mode' });
    expect(parsed.events).toContainEqual({ type: 'stage_skipped', stage: 'actions', reason: 'requires LLM' });
  });

  it('parses snapshot and closed stream events', () => {
    expect(memoryFlowStreamEventSchema.parse({ type: 'snapshot', snapshot: snapshot({ status: 'done' }) })).toEqual({
      type: 'snapshot',
      snapshot: snapshot({ status: 'done' }),
    });

    expect(memoryFlowStreamEventSchema.parse({ type: 'closed', status: 'done', errors: [] })).toEqual({
      type: 'closed',
      status: 'done',
      errors: [],
    });
  });

  it('rejects invalid replay status values', () => {
    expect(() => memoryFlowReplayInputSchema.parse({ ...snapshot(), status: 'complete' })).toThrow();
  });
});
