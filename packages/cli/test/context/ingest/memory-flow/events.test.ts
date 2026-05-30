import { describe, expect, it } from 'vitest';
import type { LocalIngestRunRecord } from '../../../../src/context/ingest/local-stage-ingest.js';
import type { IngestReportSnapshot } from '../../../../src/context/ingest/reports.js';
import { ingestReportToMemoryFlowReplay, localIngestRunToMemoryFlowReplay } from '../../../../src/context/ingest/memory-flow/events.js';

function localRecord(): LocalIngestRunRecord {
  return {
    runId: 'local-run-1',
    jobId: 'local-run-1',
    status: 'done',
    adapter: 'metricflow',
    connectionId: 'warehouse',
    sourceDir: '/tmp/source',
    syncId: 'sync-1',
    startedAt: '2026-04-30T10:00:00.000Z',
    completedAt: '2026-04-30T10:00:01.000Z',
    progress: 1,
    done: true,
    previousRunId: null,
    diffSummary: { added: 2, modified: 1, deleted: 1, unchanged: 4 },
    diffPaths: {
      added: ['models/orders.yml', 'models/revenue.yml'],
      modified: ['models/customers.yml'],
      deleted: ['models/old.yml'],
      unchanged: ['models/a.yml', 'models/b.yml', 'models/c.yml', 'models/d.yml'],
    },
    workUnitCount: 2,
    rawFileCount: 7,
    workUnits: [
      {
        unitKey: 'orders',
        rawFiles: ['models/orders.yml'],
        peerFileIndex: ['models/customers.yml'],
        dependencyPaths: ['models/base.yml'],
      },
      {
        unitKey: 'revenue',
        rawFiles: ['models/revenue.yml'],
        peerFileIndex: [],
        dependencyPaths: [],
      },
    ],
    evictionDeletedRawPaths: ['raw-sources/warehouse/metricflow/sync-1/models/old.yml'],
    errors: [],
  };
}

function reportSnapshot(): IngestReportSnapshot {
  return {
    id: 'report-1',
    runId: 'run-1',
    jobId: 'job-1',
    connectionId: 'warehouse',
    sourceKey: 'lookml',
    createdAt: '2026-04-30T10:00:02.000Z',
    body: {
      syncId: 'sync-2',
      diffSummary: { added: 1, modified: 1, deleted: 0, unchanged: 3 },
      commitSha: 'abc123456789', // pragma: allowlist secret
      failedWorkUnits: ['customers'],
      reconciliationSkipped: false,
      conflictsResolved: [
        {
          kind: 'near_duplicate',
          artifactKey: 'warehouse.orders',
          detail: 'kept candidate definition',
          flaggedForHuman: false,
        },
      ],
      evictionsApplied: [],
      unmappedFallbacks: [{ rawPath: 'cards/42.json', reason: 'no_connection_mapping', fallback: 'flagged' }],
      evictionInputs: [],
      unresolvedCards: [],
      supersededBy: null,
      overrideOf: null,
      provenanceRows: [
        {
          rawPath: 'views/orders.view.lkml',
          artifactKind: 'wiki',
          artifactKey: 'wiki/global/orders.md',
          actionType: 'wiki_written',
        },
        {
          rawPath: 'views/orders.view.lkml',
          artifactKind: 'sl',
          artifactKey: 'warehouse.orders',
          actionType: 'measure_added',
        },
        {
          rawPath: 'views/customers.view.lkml',
          artifactKind: null,
          artifactKey: null,
          actionType: 'skipped',
        },
      ],
      toolTranscripts: [
        {
          unitKey: 'orders',
          path: '/tmp/ktx/run/wu-transcripts/job-1/orders.jsonl',
          toolCallCount: 3,
          errorCount: 0,
          toolNames: ['read_raw_span', 'wiki_write', 'sl_write_source'],
        },
        {
          unitKey: 'customers',
          path: '/tmp/ktx/run/wu-transcripts/job-1/customers.jsonl',
          toolCallCount: 2,
          errorCount: 1,
          toolNames: ['read_raw_span', 'sl_write_source'],
        },
      ],
      workUnits: [
        {
          unitKey: 'orders',
          rawFiles: ['views/orders.view.lkml'],
          status: 'success',
          actions: [
            { target: 'wiki', type: 'created', key: 'wiki/global/orders.md', detail: 'order facts' },
            { target: 'sl', type: 'updated', key: 'warehouse.orders', detail: 'order measures' },
          ],
          touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'warehouse.orders' }],
        },
        {
          unitKey: 'customers',
          rawFiles: ['views/customers.view.lkml'],
          status: 'failed',
          reason: 'semantic-layer validation failed',
          actions: [{ target: 'sl', type: 'created', key: 'warehouse.customers', detail: 'invalid source' }],
          touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'warehouse.customers' }],
        },
      ],
    },
  };
}

describe('memory-flow event mapping', () => {
  it('maps a local ingest run to source, snapshot, diff, chunk, and report events', () => {
    const replay = localIngestRunToMemoryFlowReplay(localRecord());

    expect(replay).toMatchObject({
      runId: 'local-run-1',
      connectionId: 'warehouse',
      adapter: 'metricflow',
      status: 'done',
      sourceDir: '/tmp/source',
      syncId: 'sync-1',
      plannedWorkUnits: [
        { unitKey: 'orders', rawFiles: ['models/orders.yml'], peerFileCount: 1, dependencyCount: 1 },
        { unitKey: 'revenue', rawFiles: ['models/revenue.yml'], peerFileCount: 0, dependencyCount: 0 },
      ],
    });
    expect(replay.events).toEqual([
      { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 7 },
      { type: 'scope_detected', fingerprint: null },
      { type: 'raw_snapshot_written', syncId: 'sync-1', rawFileCount: 7 },
      { type: 'diff_computed', added: 2, modified: 1, deleted: 1, unchanged: 4 },
      { type: 'chunks_planned', chunkCount: 2, workUnitCount: 2, evictionCount: 1 },
      { type: 'report_created', runId: 'local-run-1' },
    ]);
  });

  it('maps an ingest report snapshot to work-unit, candidate, gate, saved, provenance, and report events', () => {
    const replay = ingestReportToMemoryFlowReplay(reportSnapshot(), { provenanceRowCount: 5 });

    expect(replay).toMatchObject({
      runId: 'run-1',
      connectionId: 'warehouse',
      adapter: 'lookml',
      status: 'done',
      sourceDir: null,
      syncId: 'sync-2',
      reportId: 'report-1',
      plannedWorkUnits: [
        { unitKey: 'orders', rawFiles: ['views/orders.view.lkml'], peerFileCount: 0, dependencyCount: 0 },
        { unitKey: 'customers', rawFiles: ['views/customers.view.lkml'], peerFileCount: 0, dependencyCount: 0 },
      ],
    });
    expect(replay.events).toContainEqual({
      type: 'candidate_action',
      unitKey: 'orders',
      target: 'wiki',
      action: 'created',
      key: 'wiki/global/orders.md',
    });
    expect(replay.events).toContainEqual({
      type: 'work_unit_finished',
      unitKey: 'customers',
      status: 'failed',
      reason: 'semantic-layer validation failed',
    });
    expect(replay.events).toContainEqual({ type: 'reconciliation_finished', conflictCount: 1, fallbackCount: 1 });
    expect(replay.events).toContainEqual({ type: 'saved', commitSha: 'abc123456789', wikiCount: 1, slCount: 2 }); // pragma: allowlist secret
    expect(replay.events).toContainEqual({ type: 'provenance_recorded', rowCount: 5 });
    expect(replay.events).toContainEqual({ type: 'report_created', runId: 'run-1', reportPath: 'report-1' });
    expect(replay.details.actions).toEqual([
      {
        unitKey: 'orders',
        target: 'wiki',
        action: 'created',
        key: 'wiki/global/orders.md',
        summary: 'order facts',
        rawFiles: ['views/orders.view.lkml'],
        status: 'success',
      },
      {
        unitKey: 'orders',
        target: 'sl',
        action: 'updated',
        key: 'warehouse.orders',
        summary: 'order measures',
        rawFiles: ['views/orders.view.lkml'],
        status: 'success',
      },
      {
        unitKey: 'customers',
        target: 'sl',
        action: 'created',
        key: 'warehouse.customers',
        summary: 'invalid source',
        rawFiles: ['views/customers.view.lkml'],
        status: 'failed',
      },
    ]);
    expect(replay.details.provenance).toEqual([
      {
        rawPath: 'views/orders.view.lkml',
        artifactKind: 'wiki',
        artifactKey: 'wiki/global/orders.md',
        actionType: 'wiki_written',
      },
      {
        rawPath: 'views/orders.view.lkml',
        artifactKind: 'sl',
        artifactKey: 'warehouse.orders',
        actionType: 'measure_added',
      },
      {
        rawPath: 'views/customers.view.lkml',
        artifactKind: null,
        artifactKey: null,
        actionType: 'skipped',
      },
    ]);
    expect(replay.details.transcripts).toEqual([
      {
        unitKey: 'orders',
        path: '/tmp/ktx/run/wu-transcripts/job-1/orders.jsonl',
        toolCallCount: 3,
        errorCount: 0,
        toolNames: ['read_raw_span', 'wiki_write', 'sl_write_source'],
      },
      {
        unitKey: 'customers',
        path: '/tmp/ktx/run/wu-transcripts/job-1/customers.jsonl',
        toolCallCount: 2,
        errorCount: 1,
        toolNames: ['read_raw_span', 'sl_write_source'],
      },
    ]);
  });

  it('prefers captured memory-flow snapshots from report bodies', () => {
    const report = reportSnapshot();
    Object.assign(report.body, {
      memoryFlow: {
        metadata: {
          schemaVersion: 1,
          mode: 'full',
          origin: 'captured',
          timing: 'captured',
          capturedAt: '2026-05-01T10:00:03.000Z',
          sourceReportId: null,
          sourceReportPath: null,
          fallbackReason: null,
        },
        runId: 'run-1',
        connectionId: 'warehouse',
        adapter: 'lookml',
        status: 'running',
        sourceDir: null,
        syncId: 'sync-2',
        errors: [],
        plannedWorkUnits: [
          { unitKey: 'orders', rawFiles: ['views/orders.view.lkml'], peerFileCount: 1, dependencyCount: 2 },
        ],
        details: { actions: [], provenance: [], transcripts: [] },
        events: [
          {
            type: 'source_acquired',
            adapter: 'lookml',
            trigger: 'manual_resync',
            fileCount: 1,
            emittedAt: '2026-05-01T10:00:00.000Z',
          },
        ],
      },
    });

    const replay = ingestReportToMemoryFlowReplay(report);

    expect(replay.metadata).toEqual({
      schemaVersion: 1,
      mode: 'full',
      origin: 'captured',
      timing: 'captured',
      capturedAt: '2026-05-01T10:00:03.000Z',
      sourceReportId: 'report-1',
      sourceReportPath: 'report-1',
      fallbackReason: null,
    });
    expect(replay.status).toBe('done');
    expect(replay.reportId).toBe('report-1');
    expect(replay.reportPath).toBe('report-1');
    expect(replay.events[0]).toMatchObject({ type: 'source_acquired', emittedAt: '2026-05-01T10:00:00.000Z' });
    expect(replay.events).toContainEqual({ type: 'report_created', runId: 'run-1', reportPath: 'report-1' });
  });

  it('labels reconstructed report replays as synthetic when no captured snapshot exists', () => {
    const replay = ingestReportToMemoryFlowReplay(reportSnapshot(), { provenanceRowCount: 5 });

    expect(replay.metadata).toEqual({
      schemaVersion: 1,
      mode: 'full',
      origin: 'synthetic-report',
      timing: 'synthetic',
      capturedAt: '2026-04-30T10:00:02.000Z',
      sourceReportId: 'report-1',
      sourceReportPath: 'report-1',
      fallbackReason: 'report did not include captured memory-flow events',
    });
  });
});
