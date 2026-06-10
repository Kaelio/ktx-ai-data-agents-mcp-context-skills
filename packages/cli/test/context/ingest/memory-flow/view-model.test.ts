import { describe, expect, it } from 'vitest';
import type { MemoryFlowReplayInput } from '../../../../src/context/ingest/memory-flow/types.js';
import { buildMemoryFlowViewModel } from '../../../../src/context/ingest/memory-flow/view-model.js';

function replayInput(): MemoryFlowReplayInput {
  return {
    runId: 'run-1',
    connectionId: 'warehouse',
    adapter: 'metricflow',
    status: 'done',
    sourceDir: '/tmp/source',
    syncId: 'sync-1',
    errors: [],
    plannedWorkUnits: [
      { unitKey: 'orders', rawFiles: ['orders.yml'], peerFileCount: 1, dependencyCount: 1 },
      { unitKey: 'revenue', rawFiles: ['revenue.yml'], peerFileCount: 0, dependencyCount: 0 },
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
        {
          unitKey: 'orders',
          target: 'sl',
          action: 'updated',
          key: 'warehouse.orders',
          summary: 'order measures',
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
          unitKey: 'orders',
          path: '/tmp/transcripts/orders.jsonl',
          toolCallCount: 3,
          errorCount: 0,
          toolNames: ['read_raw_span', 'wiki_write', 'sl_write_source'],
        },
      ],
    },
    events: [
      { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 2 },
      { type: 'scope_detected', fingerprint: 'scope-abc' },
      { type: 'raw_snapshot_written', syncId: 'sync-1', rawFileCount: 2 },
      { type: 'diff_computed', added: 1, modified: 1, deleted: 0, unchanged: 3 },
      { type: 'chunks_planned', chunkCount: 2, workUnitCount: 2, evictionCount: 0 },
      { type: 'work_unit_started', unitKey: 'orders', skills: ['wiki_capture'] },
      { type: 'candidate_action', unitKey: 'orders', target: 'wiki', action: 'created', key: 'wiki/orders.md' },
      { type: 'candidate_action', unitKey: 'orders', target: 'sl', action: 'updated', key: 'warehouse.orders' },
      { type: 'work_unit_finished', unitKey: 'orders', status: 'success' },
      { type: 'work_unit_finished', unitKey: 'revenue', status: 'failed', reason: 'validation failed' },
      { type: 'reconciliation_finished', conflictCount: 1, fallbackCount: 1 },
      { type: 'saved', commitSha: 'abc123456789', wikiCount: 1, slCount: 1 }, // pragma: allowlist secret
      { type: 'provenance_recorded', rowCount: 3 },
      { type: 'report_created', runId: 'run-1', reportPath: 'report-1' },
    ],
  };
}

function baseReplayInput(overrides: Partial<MemoryFlowReplayInput> = {}): MemoryFlowReplayInput {
  return {
    runId: 'run-errors',
    connectionId: 'warehouse',
    adapter: 'metricflow',
    status: 'error',
    sourceDir: '/tmp/source',
    syncId: 'sync-errors',
    errors: [],
    events: [],
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
    ...overrides,
  };
}

describe('buildMemoryFlowViewModel', () => {
  it('builds six readable columns from replay events', () => {
    const view = buildMemoryFlowViewModel(replayInput());

    expect(view.title).toBe('ktx memory flow  warehouse/metricflow  done');
    expect(view.activeLine).toBe('active: complete');
    expect(view.columns.map((column) => column.id)).toEqual([
      'source',
      'chunks',
      'workUnits',
      'actions',
      'gates',
      'saved',
    ]);
    expect(view.columns.map((column) => column.headline)).toEqual([
      '2 raw files',
      '2 chunks',
      '2 WUs',
      '2 candidates',
      '1 conflict, 1 fallback',
      '2 memories',
    ]);
    expect(view.columns.find((column) => column.id === 'workUnits')?.counters).toEqual([
      '1 done',
      '1 failed',
      '0 active',
    ]);
    expect(view.columns.find((column) => column.id === 'actions')?.counters).toEqual(['1 wiki', '1 SL']);
    expect(view.details.actions).toHaveLength(2);
    expect(view.details.provenance).toEqual([
      {
        rawPath: 'orders.yml',
        artifactKind: 'wiki',
        artifactKey: 'wiki/orders.md',
        actionType: 'wiki_written',
      },
    ]);
    expect(view.details.transcripts).toEqual([
      {
        unitKey: 'orders',
        path: '/tmp/transcripts/orders.jsonl',
        toolCallCount: 3,
        errorCount: 0,
        toolNames: ['read_raw_span', 'wiki_write', 'sl_write_source'],
      },
    ]);
    expect(view.columns.find((column) => column.id === 'actions')?.details).toContain(
      'orders wiki created wiki/orders.md: order facts',
    );
    expect(view.columns.find((column) => column.id === 'saved')?.details).toContain('Commit: abc12345');
    expect(view.completionLine).toBe(
      'Saved 2 memories from 2 raw files: 1 wiki pages, 1 SL updates. Commit: abc12345  Run: run-1  Report: report-1',
    );
  });

  it('shows all seeded demo source families and sums raw files in the completion line', () => {
    const view = buildMemoryFlowViewModel({
      runId: 'demo-seeded-orbit',
      connectionId: 'orbit_demo',
      adapter: 'live-database',
      status: 'done',
      sourceDir: null,
      syncId: 'demo-seeded-sync',
      errors: [],
      events: [
        { type: 'source_acquired', adapter: 'live-database', trigger: 'demo_seeded', fileCount: 8 },
        { type: 'source_acquired', adapter: 'dbt_descriptions', trigger: 'demo_seeded', fileCount: 6 },
        { type: 'source_acquired', adapter: 'looker', trigger: 'demo_seeded', fileCount: 7 },
        { type: 'source_acquired', adapter: 'notion', trigger: 'demo_seeded', fileCount: 8 },
        { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
        { type: 'work_unit_started', unitKey: 'revenue-and-contracts', skills: ['wiki_capture'] },
        {
          type: 'candidate_action',
          unitKey: 'revenue-and-contracts',
          target: 'wiki',
          action: 'created',
          key: 'wiki/global/arr-contract-first.md',
        },
        { type: 'work_unit_finished', unitKey: 'revenue-and-contracts', status: 'success' },
        { type: 'reconciliation_finished', conflictCount: 0, fallbackCount: 0 },
        { type: 'saved', commitSha: 'demo-seeded', wikiCount: 10, slCount: 6 },
        { type: 'provenance_recorded', rowCount: 23 },
        { type: 'report_created', runId: 'demo-seeded-orbit', reportPath: 'reports/seeded-demo-report.json' },
      ],
      plannedWorkUnits: [
        { unitKey: 'revenue-and-contracts', rawFiles: ['contracts'], peerFileCount: 1, dependencyCount: 1 },
      ],
      details: { actions: [], provenance: [], transcripts: [] },
    });

    expect(view.title).toBe('ktx memory flow  Warehouse + dbt + BI + Docs  done');
    expect(view.columns.find((column) => column.id === 'source')?.counters[0]).toBe('Warehouse, dbt, BI, Docs');
    expect(view.completionLine).toContain('Saved 16 memories from 29 raw files');
  });

  it('derives sticky trust issues from failed work units, gates, and provenance mismatch', () => {
    const input = replayInput();
    const view = buildMemoryFlowViewModel({
      ...input,
      events: [
        ...input.events.filter((event) => event.type !== 'provenance_recorded'),
        { type: 'provenance_recorded', rowCount: 1 },
      ],
    });

    expect(view.trustIssues).toEqual([
      {
        id: 'work-unit-failed:revenue',
        severity: 'failed',
        title: 'WorkUnit failed',
        detail: 'revenue failed: validation failed',
        columnId: 'workUnits',
        targetLabel: 'revenue',
      },
      {
        id: 'sl-validation-reverted:revenue',
        severity: 'warning',
        title: 'SL validation revert',
        detail: 'revenue reverted after semantic-layer validation failure',
        columnId: 'gates',
        targetLabel: 'revenue',
      },
      {
        id: 'reconciliation-conflicts',
        severity: 'warning',
        title: 'Reconciliation conflicts',
        detail: '1 conflict resolved during reconciliation',
        columnId: 'gates',
      },
      {
        id: 'flagged-fallbacks',
        severity: 'warning',
        title: 'Flagged fallbacks',
        detail: '1 fallback needs review',
        columnId: 'gates',
      },
      {
        id: 'provenance-mismatch',
        severity: 'warning',
        title: 'Provenance mismatch',
        detail: '2 saved memories but 1 provenance rows recorded',
        columnId: 'saved',
      },
    ]);
    expect(view.columns.find((column) => column.id === 'workUnits')?.chips).toContainEqual({
      label: 'revenue',
      status: 'failed',
      detail: 'validation failed',
    });
  });

  it('accepts multiple provenance rows per saved memory', () => {
    const input = replayInput();
    const view = buildMemoryFlowViewModel({
      ...input,
      events: [
        ...input.events.filter((event) => event.type !== 'provenance_recorded'),
        { type: 'provenance_recorded', rowCount: 23 },
      ],
    });

    expect(view.trustIssues.find((issue) => issue.id === 'provenance-mismatch')).toBeUndefined();
  });

  it('derives deterministic mode as a degraded trust issue', () => {
    const view = buildMemoryFlowViewModel({
      runId: 'demo-deterministic-scan',
      connectionId: 'orbit_demo',
      adapter: 'live-database',
      status: 'done',
      sourceDir: 'raw-sources/orbit_demo/live-database/sync-demo',
      syncId: 'sync-demo',
      reportPath: 'raw-sources/orbit_demo/live-database/sync-demo/scan-report.json',
      errors: [],
      plannedWorkUnits: [],
      details: { actions: [], provenance: [], transcripts: [] },
      events: [
        { type: 'source_acquired', adapter: 'live-database', trigger: 'demo_deterministic', fileCount: 7 },
        { type: 'chunks_planned', chunkCount: 7, workUnitCount: 0, evictionCount: 0 },
        { type: 'stage_skipped', stage: 'workUnits', reason: 'deterministic mode' },
        { type: 'stage_skipped', stage: 'actions', reason: 'requires LLM' },
        { type: 'stage_skipped', stage: 'gates', reason: 'requires candidate actions' },
        { type: 'stage_skipped', stage: 'saved', reason: 'requires LLM memory synthesis' },
      ],
    });

    expect(view.trustIssues).toEqual([
      {
        id: 'degraded-mode:workUnits',
        severity: 'warning',
        title: 'Degraded mode',
        detail: 'WORKUNITS skipped: deterministic mode',
        columnId: 'workUnits',
        targetLabel: 'skipped',
      },
      {
        id: 'degraded-mode:actions',
        severity: 'warning',
        title: 'Degraded mode',
        detail: 'ACTIONS skipped: requires LLM',
        columnId: 'actions',
        targetLabel: 'skipped',
      },
      {
        id: 'degraded-mode:gates',
        severity: 'warning',
        title: 'Degraded mode',
        detail: 'GATES skipped: requires candidate actions',
        columnId: 'gates',
        targetLabel: 'skipped',
      },
      {
        id: 'degraded-mode:saved',
        severity: 'warning',
        title: 'Degraded mode',
        detail: 'SAVED skipped: requires LLM memory synthesis',
        columnId: 'saved',
        targetLabel: 'skipped',
      },
    ]);
  });

  it('keeps local planning-only runs honest about unsaved memory', () => {
    const view = buildMemoryFlowViewModel({
      runId: 'local-run-1',
      connectionId: 'warehouse',
      adapter: 'fake',
      status: 'done',
      sourceDir: '/tmp/source',
      syncId: 'sync-local',
      errors: [],
      plannedWorkUnits: [{ unitKey: 'orders', rawFiles: ['orders.json'], peerFileCount: 0, dependencyCount: 0 }],
      details: { actions: [], provenance: [], transcripts: [] },
      events: [
        { type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 1 },
        { type: 'scope_detected', fingerprint: null },
        { type: 'raw_snapshot_written', syncId: 'sync-local', rawFileCount: 1 },
        { type: 'diff_computed', added: 1, modified: 0, deleted: 0, unchanged: 0 },
        { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
        { type: 'report_created', runId: 'local-run-1' },
      ],
    });

    expect(view.columns.find((column) => column.id === 'actions')?.headline).toBe('0 candidates');
    expect(view.columns.find((column) => column.id === 'gates')?.headline).toBe('not run');
    expect(view.columns.find((column) => column.id === 'saved')?.headline).toBe('not saved');
    expect(view.completionLine).toBe(null);
  });

  it('surfaces a sanitized source acquisition error when no source event exists', () => {
    const view = buildMemoryFlowViewModel(
      baseReplayInput({
        errors: ['failed to read https://example.com/source?token=abc123 password=hunter2'],
      }),
    );

    expect(view.activeLine).toBe('active: source failed - failed to read https://[redacted] password=[redacted]');
    expect(view.selectedTitle).toBe('SOURCE');
    expect(view.selectedDetails).toContain('Source acquisition failed: failed to read https://[redacted] password=[redacted]');
  });

  it('surfaces a sanitized planning error after source acquisition but before chunks', () => {
    const view = buildMemoryFlowViewModel(
      baseReplayInput({
        errors: ['adapter detection failed api_key=abc123'],
        events: [
          { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 3 },
          { type: 'raw_snapshot_written', syncId: 'sync-errors', rawFileCount: 3 },
        ],
      }),
    );

    expect(view.activeLine).toBe('active: planning failed - adapter detection failed api_key=[redacted]');
    const source = view.columns.find((column) => column.id === 'source');
    expect(source?.details).toContain('Error: adapter detection failed api_key=[redacted]');
  });

  it('labels failed semantic-layer WorkUnits as reverted in gates details', () => {
    const view = buildMemoryFlowViewModel(
      baseReplayInput({
        status: 'error',
        errors: ['semantic-layer validation failed for warehouse.orders'],
        events: [
          { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 2 },
          { type: 'raw_snapshot_written', syncId: 'sync-errors', rawFileCount: 2 },
          { type: 'diff_computed', added: 2, modified: 0, deleted: 0, unchanged: 0 },
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
        plannedWorkUnits: [{ unitKey: 'orders', rawFiles: ['orders.yml'], peerFileCount: 0, dependencyCount: 0 }],
      }),
    );

    const gates = view.columns.find((column) => column.id === 'gates');
    expect(gates?.details).toContain('orders reverted: semantic-layer validation failed for warehouse.orders');
    expect(gates?.details).toContain('Invalid semantic-layer writes were not saved.');
  });

  it('keeps non-validation WorkUnit failures actionable', () => {
    const view = buildMemoryFlowViewModel(
      baseReplayInput({
        status: 'error',
        errors: ['agent step budget exhausted'],
        events: [
          { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 1 },
          { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
          { type: 'work_unit_started', unitKey: 'docs', skills: ['wiki_capture'] },
          { type: 'work_unit_finished', unitKey: 'docs', status: 'failed', reason: 'agent step budget exhausted' },
        ],
        plannedWorkUnits: [{ unitKey: 'docs', rawFiles: ['docs.md'], peerFileCount: 0, dependencyCount: 0 }],
      }),
    );

    const gates = view.columns.find((column) => column.id === 'gates');
    expect(gates?.details).toContain('docs failed: agent step budget exhausted');
  });

  it('shows whether durable memory landed before a post-save failure', () => {
    const view = buildMemoryFlowViewModel(
      baseReplayInput({
        status: 'error',
        errors: ['index refresh failed token=abc123'],
        events: [
          { type: 'source_acquired', adapter: 'metricflow', trigger: 'manual_resync', fileCount: 2 },
          { type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 },
          { type: 'work_unit_finished', unitKey: 'orders', status: 'success' },
          { type: 'reconciliation_finished', conflictCount: 0, fallbackCount: 0 },
          { type: 'saved', commitSha: 'abc123456789', wikiCount: 1, slCount: 1 }, // pragma: allowlist secret
        ],
      }),
    );

    const saved = view.columns.find((column) => column.id === 'saved');
    expect(saved?.details).toContain('Durable memory landed before failure.');
    expect(saved?.details).toContain('Post-save error: index refresh failed token=[redacted]');
    expect(view.activeLine).toBe('active: save failed - index refresh failed token=[redacted]');
  });
});
