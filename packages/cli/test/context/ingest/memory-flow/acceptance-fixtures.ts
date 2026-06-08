import type { MemoryFlowReplayInput } from '../../../../src/context/ingest/memory-flow/types.js';

function baseScenario(overrides: Partial<MemoryFlowReplayInput> = {}): MemoryFlowReplayInput {
  return {
    runId: 'run-success',
    connectionId: 'warehouse',
    adapter: 'metricflow',
    status: 'done',
    sourceDir: '/tmp/source',
    syncId: 'sync-success',
    reportPath: 'ingest-report.json',
    errors: [],
    events: [
      { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 4 },
      { type: 'scope_detected', fingerprint: 'metricflow:demo' },
      { type: 'raw_snapshot_written', syncId: 'sync-success', rawFileCount: 4 },
      { type: 'diff_computed', added: 2, modified: 1, deleted: 0, unchanged: 1 },
      { type: 'chunks_planned', chunkCount: 2, workUnitCount: 2, evictionCount: 0 },
      { type: 'work_unit_started', unitKey: 'orders', skills: ['wiki_capture'] },
      { type: 'candidate_action', unitKey: 'orders', target: 'wiki', action: 'created', key: 'wiki/global/orders.md' },
      { type: 'candidate_action', unitKey: 'orders', target: 'sl', action: 'updated', key: 'warehouse.orders' },
      { type: 'work_unit_finished', unitKey: 'orders', status: 'success' },
      { type: 'work_unit_started', unitKey: 'revenue', skills: ['wiki_capture'] },
      { type: 'candidate_action', unitKey: 'revenue', target: 'wiki', action: 'updated', key: 'wiki/global/revenue.md' },
      { type: 'work_unit_finished', unitKey: 'revenue', status: 'success' },
      { type: 'reconciliation_finished', conflictCount: 0, fallbackCount: 0 },
      { type: 'saved', commitSha: 'abc123456789', wikiCount: 2, slCount: 1 }, // pragma: allowlist secret
      { type: 'provenance_recorded', rowCount: 4 },
      { type: 'report_created', runId: 'run-success', reportPath: 'ingest-report.json' },
    ],
    plannedWorkUnits: [
      { unitKey: 'orders', rawFiles: ['models/orders.yml', 'models/customers.yml'], peerFileCount: 1, dependencyCount: 1 },
      { unitKey: 'revenue', rawFiles: ['docs/revenue.md'], peerFileCount: 0, dependencyCount: 0 },
    ],
    details: {
      actions: [
        {
          unitKey: 'orders',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/orders.md',
          summary: 'Captured order definitions',
          rawFiles: ['models/orders.yml'],
          status: 'success',
        },
        {
          unitKey: 'orders',
          target: 'sl',
          action: 'updated',
          key: 'warehouse.orders',
          summary: 'Updated orders source',
          rawFiles: ['models/orders.yml'],
          status: 'success',
        },
        {
          unitKey: 'revenue',
          target: 'wiki',
          action: 'updated',
          key: 'wiki/global/revenue.md',
          summary: 'Updated revenue notes',
          rawFiles: ['docs/revenue.md'],
          status: 'success',
        },
      ],
      provenance: [
        {
          rawPath: 'models/orders.yml',
          artifactKind: 'wiki',
          artifactKey: 'wiki/global/orders.md',
          actionType: 'created',
        },
        { rawPath: 'models/orders.yml', artifactKind: 'sl', artifactKey: 'warehouse.orders', actionType: 'updated' },
      ],
      transcripts: [
        {
          unitKey: 'orders',
          path: 'transcripts/orders.json',
          toolCallCount: 3,
          errorCount: 0,
          toolNames: ['wiki_write', 'sl_write_source'],
        },
      ],
    },
    ...overrides,
  };
}

export function successfulReplayScenario(): MemoryFlowReplayInput {
  return baseScenario();
}

export function deletedRawPathsScenario(): MemoryFlowReplayInput {
  return baseScenario({
    events: baseScenario().events.map((event) =>
      event.type === 'diff_computed'
        ? { ...event, deleted: 2 }
        : event.type === 'chunks_planned'
          ? { ...event, evictionCount: 2 }
          : event,
    ),
  });
}

export function validationRevertScenario(): MemoryFlowReplayInput {
  return baseScenario({
    runId: 'run-validation-failure',
    status: 'error',
    errors: ['semantic-layer validation failed for warehouse.orders'],
    events: [
      { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 1 },
      { type: 'raw_snapshot_written', syncId: 'sync-validation', rawFileCount: 1 },
      { type: 'diff_computed', added: 1, modified: 0, deleted: 0, unchanged: 0 },
      { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
      { type: 'work_unit_started', unitKey: 'orders', skills: ['wiki_capture'] },
      { type: 'candidate_action', unitKey: 'orders', target: 'sl', action: 'updated', key: 'warehouse.orders' },
      {
        type: 'work_unit_finished',
        unitKey: 'orders',
        status: 'failed',
        reason: 'semantic-layer validation failed for warehouse.orders',
      },
    ],
    plannedWorkUnits: [{ unitKey: 'orders', rawFiles: ['models/orders.yml'], peerFileCount: 0, dependencyCount: 0 }],
    details: {
      actions: [
        {
          unitKey: 'orders',
          target: 'sl',
          action: 'updated',
          key: 'warehouse.orders',
          summary: 'Invalid measure was reverted',
          rawFiles: ['models/orders.yml'],
          status: 'failed',
        },
      ],
      provenance: [],
      transcripts: [
        {
          unitKey: 'orders',
          path: 'transcripts/orders.json',
          toolCallCount: 2,
          errorCount: 1,
          toolNames: ['sl_write_source'],
        },
      ],
    },
  });
}

export function flaggedFallbackScenario(): MemoryFlowReplayInput {
  return baseScenario({
    runId: 'run-flagged-fallback',
    events: baseScenario().events.map((event) =>
      event.type === 'reconciliation_finished' ? { ...event, fallbackCount: 1 } : event,
    ),
  });
}

export function postSaveSecretFailureScenario(): MemoryFlowReplayInput {
  return baseScenario({
    runId: 'run-post-save-failure',
    status: 'error',
    errors: ['index refresh failed https://example.com/private token=abc123'],
    events: baseScenario().events.map((event) =>
      event.type === 'saved' ? { ...event, commitSha: 'def456789012' } : event, // pragma: allowlist secret
    ),
  });
}
