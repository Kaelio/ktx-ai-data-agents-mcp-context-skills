import { describe, expect, it } from 'vitest';
import type { MemoryFlowReplayInput } from '../../../../src/context/ingest/memory-flow/types.js';
import { formatMemoryFlowFinalSummary } from '../../../../src/context/ingest/memory-flow/summary.js';

function input(overrides: Partial<MemoryFlowReplayInput> = {}): MemoryFlowReplayInput {
  return {
    runId: 'run-1',
    connectionId: 'warehouse',
    adapter: 'metricflow',
    status: 'done',
    sourceDir: '/tmp/source',
    syncId: 'sync-1',
    errors: [],
    plannedWorkUnits: [{ unitKey: 'orders', rawFiles: ['orders.yml'], peerFileCount: 0, dependencyCount: 0 }],
    details: { actions: [], provenance: [], transcripts: [] },
    events: [
      { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 2 },
      { type: 'chunks_planned', chunkCount: 2, workUnitCount: 1, evictionCount: 0 },
      { type: 'work_unit_finished', unitKey: 'orders', status: 'success' },
      { type: 'saved', commitSha: 'abc12345', wikiCount: 1, slCount: 1 },
      { type: 'provenance_recorded', rowCount: 2 },
      { type: 'report_created', runId: 'run-1', reportPath: 'report-1' },
    ],
    ...overrides,
  };
}

describe('formatMemoryFlowFinalSummary', () => {
  it('summarizes a successful full memory-flow run', () => {
    expect(formatMemoryFlowFinalSummary(input())).toBe(
      [
        'Memory-flow summary: done',
        'Connection: warehouse',
        'Adapter: metricflow',
        'Run: run-1',
        'Sync: sync-1',
        'Source files: 2',
        'Table reviews: 1 total, 1 done, 0 failed',
        'Saved memory: 1 wiki, 1 semantic layer',
        'Provenance rows: 2',
        'Report: report-1',
        '',
      ].join('\n'),
    );
  });

  it('includes trust issues and sanitized errors for failed runs', () => {
    expect(
      formatMemoryFlowFinalSummary(
        input({
          status: 'error',
          errors: ['failed token=secret'],
          events: [
            { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 2 },
            { type: 'chunks_planned', chunkCount: 2, workUnitCount: 1, evictionCount: 0 },
            { type: 'work_unit_finished', unitKey: 'orders', status: 'failed', reason: 'validation failed token=secret' },
          ],
        }),
      ),
    ).toContain('Trust issues: 3');
  });

  it('explains expired Notion authorization with fix suggestions', () => {
    const rawReason =
      'notion-cluster-1 failed: {"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)","error_uri":"https://accounts.example/reauth"}';
    const summary = formatMemoryFlowFinalSummary(
      input({
        connectionId: 'notion-main',
        adapter: 'notion',
        status: 'error',
        events: [
          { type: 'source_acquired', adapter: 'notion', trigger: 'manual_resync', fileCount: 37 },
          { type: 'chunks_planned', chunkCount: 2, workUnitCount: 2, evictionCount: 0 },
          { type: 'work_unit_finished', unitKey: 'notion-cluster-1', status: 'failed', reason: rawReason },
        ],
      }),
    );

    expect(summary).toContain('Memory-flow summary: error');
    expect(summary).toContain(
      'Notion authorization expired: notion-cluster-1 could not read Notion because the saved OAuth grant expired or requires reauthentication (invalid_grant / invalid_rapt).',
    );
    expect(summary).toContain('Fix suggestions:');
    expect(summary).toContain(
      '- Refresh the Notion token referenced by auth_token_ref for notion-main. If it uses env:NAME, export a fresh token in that variable; if it uses file:/path, replace that file.',
    );
    expect(summary).toContain(
      '- Run ktx setup and reconfigure the Notion source to confirm page access, then rerun ktx ingest notion-main.',
    );
    expect(summary).not.toContain('error_uri');
  });

  it('labels replay source metadata in final summaries', () => {
    const summary = formatMemoryFlowFinalSummary({
      metadata: {
        schemaVersion: 1,
        mode: 'replay',
        origin: 'packaged',
        timing: 'captured',
        capturedAt: '2026-05-01T10:00:03.000Z',
        sourceReportId: 'demo-replay-report',
        sourceReportPath: 'replays/replay.memory-flow.v1.json',
        fallbackReason: null,
      },
      runId: 'demo-replay-orbit',
      connectionId: 'orbit_demo',
      adapter: 'live-database',
      status: 'done',
      sourceDir: null,
      syncId: 'demo-replay-sync',
      reportPath: 'replays/replay.memory-flow.v1.json',
      errors: [],
      events: [
        { type: 'source_acquired', adapter: 'live-database', trigger: 'demo_replay', fileCount: 7 },
        { type: 'saved', commitSha: null, wikiCount: 3, slCount: 2 },
        { type: 'provenance_recorded', rowCount: 5 },
        { type: 'report_created', runId: 'demo-replay-orbit', reportPath: 'replays/replay.memory-flow.v1.json' },
      ],
      plannedWorkUnits: [],
      details: { actions: [], provenance: [], transcripts: [] },
    });

    expect(summary).toContain('Replay source: packaged replay (captured timing)');
    expect(summary).toContain('Replay captured: 2026-05-01T10:00:03.000Z');
  });

  it('labels synthetic report replays with the reconstruction reason', () => {
    const summary = formatMemoryFlowFinalSummary({
      metadata: {
        schemaVersion: 1,
        mode: 'full',
        origin: 'synthetic-report',
        timing: 'synthetic',
        capturedAt: '2026-05-01T10:00:03.000Z',
        sourceReportId: 'report-1',
        sourceReportPath: 'report-1',
        fallbackReason: 'report did not include captured memory-flow events',
      },
      runId: 'run-1',
      connectionId: 'warehouse',
      adapter: 'lookml',
      status: 'done',
      sourceDir: null,
      syncId: 'sync-1',
      reportPath: 'report-1',
      errors: [],
      events: [{ type: 'report_created', runId: 'run-1', reportPath: 'report-1' }],
      plannedWorkUnits: [],
      details: { actions: [], provenance: [], transcripts: [] },
    });

    expect(summary).toContain('Replay source: synthetic report replay (synthetic timing)');
    expect(summary).toContain('Replay note: report did not include captured memory-flow events');
  });
});
