import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffSetService } from './diff-set.service.js';
import type { IngestDiffSummary, IngestReportBody, IngestTrigger } from './index.js';
import { SqliteBundleIngestStore } from './sqlite-bundle-ingest-store.js';

function idFactory(ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `generated-${index}`;
}

function runArgs(input: {
  jobId: string;
  syncId: string;
  connectionId?: string;
  sourceKey?: string;
  trigger?: IngestTrigger;
}) {
  return {
    jobId: input.jobId,
    connectionId: input.connectionId ?? 'docs',
    sourceKey: input.sourceKey ?? 'notion',
    syncId: input.syncId,
    trigger: input.trigger ?? 'manual_resync',
    scopeFingerprint: `scope-${input.syncId}`,
  };
}

function diffSummary(overrides: Partial<IngestDiffSummary> = {}): IngestDiffSummary {
  return {
    added: 1,
    modified: 0,
    deleted: 0,
    unchanged: 0,
    ...overrides,
  };
}

function reportBody(syncId: string, supersededBy: string | null = null): IngestReportBody {
  return {
    syncId,
    diffSummary: diffSummary(),
    commitSha: null,
    workUnits: [
      {
        unitKey: 'revenue-policy',
        rawFiles: ['pages/revenue.md'],
        status: 'success',
        actions: [],
        touchedSlSources: [],
      },
    ],
    failedWorkUnits: [],
    reconciliationSkipped: false,
    conflictsResolved: [],
    evictionsApplied: [],
    unmappedFallbacks: [],
    evictionInputs: [],
    unresolvedCards: [],
    supersededBy,
    overrideOf: null,
    provenanceRows: [],
    toolTranscripts: [],
  };
}

function emptyReportBody(syncId: string, overrides: Partial<IngestReportBody> = {}): IngestReportBody {
  return {
    syncId,
    diffSummary: diffSummary({ added: 0, modified: 0, deleted: 0, unchanged: 1 }),
    commitSha: null,
    workUnits: [],
    failedWorkUnits: [],
    reconciliationSkipped: true,
    conflictsResolved: [],
    evictionsApplied: [],
    unmappedFallbacks: [],
    evictionInputs: [],
    unresolvedCards: [],
    supersededBy: null,
    overrideOf: null,
    provenanceRows: [],
    toolTranscripts: [],
    ...overrides,
  };
}

describe('SqliteBundleIngestStore', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-bundle-ingest-store-'));
    dbPath = join(tempDir, '.ktx', 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists run and report state across reopened SQLite handles', async () => {
    const store = new SqliteBundleIngestStore({
      dbPath,
      idFactory: idFactory(['run-1', 'report-1']),
      now: () => new Date('2026-04-30T10:00:00.000Z'),
    });

    const run = await store.create(runArgs({ jobId: 'job-1', syncId: 'sync-1' }));
    expect(run).toEqual({ id: 'run-1' });

    await store.markCompleted(run.id, diffSummary({ added: 2, unchanged: 1 }));
    const report = await store.create({
      runId: run.id,
      jobId: 'job-1',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: reportBody('sync-1'),
    });

    expect(report).toMatchObject({
      id: 'report-1',
      runId: 'run-1',
      jobId: 'job-1',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: { syncId: 'sync-1' },
      createdAt: '2026-04-30T10:00:00.000Z',
    });

    const reopened = new SqliteBundleIngestStore({ dbPath });
    await expect(reopened.findByJobId('job-1')).resolves.toMatchObject({
      id: 'report-1',
      runId: 'run-1',
      body: { syncId: 'sync-1', supersededBy: null },
    });

    await reopened.markSuperseded('job-1', 'job-2');
    await expect(reopened.findByJobId('job-1')).resolves.toMatchObject({
      body: { syncId: 'sync-1', supersededBy: 'job-2' },
    });
    await expect(reopened.findByJobId('missing-job')).resolves.toBeNull();
  });

  it('uses only completed runs when serving latest provenance hashes and artifacts', async () => {
    const store = new SqliteBundleIngestStore({
      dbPath,
      idFactory: idFactory(['run-old', 'run-failed', 'run-new']),
      now: () => new Date('2026-04-30T10:00:00.000Z'),
    });

    const oldRun = await store.create(runArgs({ jobId: 'job-old', syncId: 'sync-old' }));
    await store.insertMany([
      {
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-old',
        rawPath: 'pages/revenue.md',
        rawContentHash: 'hash-old',
        artifactKind: 'wiki',
        artifactKey: 'knowledge/global/revenue.md',
        artifactContentHash: null,
        actionType: 'wiki_written',
      },
    ]);
    await store.markCompleted(oldRun.id, diffSummary());

    const failedRun = await store.create(runArgs({ jobId: 'job-failed', syncId: 'sync-failed' }));
    await store.insertMany([
      {
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-failed',
        rawPath: 'pages/revenue.md',
        rawContentHash: 'hash-failed',
        artifactKind: null,
        artifactKey: null,
        artifactContentHash: null,
        actionType: 'skipped',
      },
    ]);
    await store.markFailed(failedRun.id);

    const newRun = await store.create(runArgs({ jobId: 'job-new', syncId: 'sync-new' }));
    await store.insertMany([
      {
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-new',
        rawPath: 'pages/revenue.md',
        rawContentHash: 'hash-new',
        artifactKind: 'wiki',
        artifactKey: 'knowledge/global/revenue.md',
        artifactContentHash: 'artifact-hash-new',
        actionType: 'wiki_written',
      },
      {
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-new',
        rawPath: 'pages/revenue.md',
        rawContentHash: 'hash-new',
        artifactKind: 'sl',
        artifactKey: 'warehouse.revenue',
        artifactContentHash: null,
        actionType: 'measure_added',
      },
    ]);
    await store.markCompleted(newRun.id, diffSummary({ modified: 1 }));

    await expect(store.findLatestHashesForCompletedSyncs('docs', 'notion')).resolves.toEqual(
      new Map([['pages/revenue.md', 'hash-new']]),
    );
    const diffSet = await new DiffSetService(store).compute(
      'docs',
      'notion',
      new Map([
        ['pages/revenue.md', 'hash-new'],
        ['pages/new-policy.md', 'hash-added'],
      ]),
    );
    expect(diffSet).toEqual({
      added: ['pages/new-policy.md'],
      modified: [],
      deleted: [],
      unchanged: ['pages/revenue.md'],
    });

    const artifacts = await store.findLatestArtifactsForRawPaths('docs', 'notion', ['pages/revenue.md']);
    expect(artifacts.get('pages/revenue.md')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sync_id: 'sync-new',
          raw_content_hash: 'hash-new',
          artifact_kind: 'wiki',
          artifact_key: 'knowledge/global/revenue.md',
          action_type: 'wiki_written',
        }),
        expect.objectContaining({
          sync_id: 'sync-new',
          artifact_kind: 'sl',
          artifact_key: 'warehouse.revenue',
          action_type: 'measure_added',
        }),
      ]),
    );
  });

  it('does not baseline skipped provenance from failed work units or zero-work retry runs', async () => {
    const store = new SqliteBundleIngestStore({ dbPath });
    const rawHashes = new Map([
      ['pages/page-1/metadata.json', 'hash-metadata'],
      ['pages/page-1/page.md', 'hash-page'],
    ]);

    const failedRun = await store.create(runArgs({ jobId: 'job-failed-review', syncId: 'sync-failed-review' }));
    await store.insertMany(
      [...rawHashes].map(([rawPath, rawContentHash]) => ({
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-failed-review',
        rawPath,
        rawContentHash,
        artifactKind: null,
        artifactKey: null,
        artifactContentHash: null,
        actionType: 'skipped' as const,
      })),
    );
    await store.markCompleted(failedRun.id, diffSummary({ added: 2 }));
    await store.create({
      runId: failedRun.id,
      jobId: 'job-failed-review',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: emptyReportBody('sync-failed-review', {
        workUnits: [
          {
            unitKey: 'notion-page-page-1',
            rawFiles: [...rawHashes.keys()],
            status: 'failed',
            reason: 'invalid_grant',
            actions: [],
            touchedSlSources: [],
          },
        ],
        failedWorkUnits: ['notion-page-page-1'],
      }),
    });

    const noWorkRun = await store.create(runArgs({ jobId: 'job-no-work', syncId: 'sync-no-work' }));
    await store.insertMany(
      [...rawHashes].map(([rawPath, rawContentHash]) => ({
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-no-work',
        rawPath,
        rawContentHash,
        artifactKind: null,
        artifactKey: null,
        artifactContentHash: null,
        actionType: 'skipped' as const,
      })),
    );
    await store.markCompleted(noWorkRun.id, diffSummary({ unchanged: 2 }));
    await store.create({
      runId: noWorkRun.id,
      jobId: 'job-no-work',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: emptyReportBody('sync-no-work', { workUnits: [], failedWorkUnits: [] }),
    });

    await expect(store.findLatestHashesForCompletedSyncs('docs', 'notion')).resolves.toEqual(new Map());
    await expect(new DiffSetService(store).compute('docs', 'notion', rawHashes)).resolves.toEqual({
      added: ['pages/page-1/metadata.json', 'pages/page-1/page.md'],
      modified: [],
      deleted: [],
      unchanged: [],
    });
  });

  it('baselines skipped provenance from successful no-output work unit runs', async () => {
    const store = new SqliteBundleIngestStore({ dbPath });
    const run = await store.create(runArgs({ jobId: 'job-reviewed-no-output', syncId: 'sync-reviewed-no-output' }));

    await store.insertMany([
      {
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-reviewed-no-output',
        rawPath: 'pages/page-1/page.md',
        rawContentHash: 'hash-reviewed',
        artifactKind: null,
        artifactKey: null,
        artifactContentHash: null,
        actionType: 'skipped',
      },
    ]);
    await store.markCompleted(run.id, diffSummary({ added: 1 }));
    await store.create({
      runId: run.id,
      jobId: 'job-reviewed-no-output',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: emptyReportBody('sync-reviewed-no-output', {
        workUnits: [
          {
            unitKey: 'notion-page-page-1',
            rawFiles: ['pages/page-1/page.md'],
            status: 'success',
            actions: [],
            touchedSlSources: [],
          },
        ],
        failedWorkUnits: [],
      }),
    });

    await expect(store.findLatestHashesForCompletedSyncs('docs', 'notion')).resolves.toEqual(
      new Map([['pages/page-1/page.md', 'hash-reviewed']]),
    );
    await expect(
      new DiffSetService(store).compute('docs', 'notion', new Map([['pages/page-1/page.md', 'hash-reviewed']])),
    ).resolves.toMatchObject({
      added: [],
      unchanged: ['pages/page-1/page.md'],
    });
  });

  it('baselines artifact provenance in partial failures but not skipped-only failed paths', async () => {
    const store = new SqliteBundleIngestStore({ dbPath });
    const run = await store.create(runArgs({ jobId: 'job-partial', syncId: 'sync-partial' }));

    await store.insertMany([
      {
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-partial',
        rawPath: 'pages/success/page.md',
        rawContentHash: 'hash-success',
        artifactKind: 'wiki',
        artifactKey: 'knowledge/notion/success.md',
        artifactContentHash: 'artifact-success',
        actionType: 'wiki_written',
      },
      {
        connectionId: 'docs',
        sourceKey: 'notion',
        syncId: 'sync-partial',
        rawPath: 'pages/failed/page.md',
        rawContentHash: 'hash-failed',
        artifactKind: null,
        artifactKey: null,
        artifactContentHash: null,
        actionType: 'skipped',
      },
    ]);
    await store.markCompleted(run.id, diffSummary({ added: 2 }));
    await store.create({
      runId: run.id,
      jobId: 'job-partial',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: emptyReportBody('sync-partial', {
        workUnits: [
          {
            unitKey: 'notion-page-success',
            rawFiles: ['pages/success/page.md'],
            status: 'success',
            actions: [],
            touchedSlSources: [],
          },
          {
            unitKey: 'notion-page-failed',
            rawFiles: ['pages/failed/page.md'],
            status: 'failed',
            reason: 'invalid_grant',
            actions: [],
            touchedSlSources: [],
          },
        ],
        failedWorkUnits: ['notion-page-failed'],
      }),
    });

    await expect(store.findLatestHashesForCompletedSyncs('docs', 'notion')).resolves.toEqual(
      new Map([['pages/success/page.md', 'hash-success']]),
    );
    await expect(
      new DiffSetService(store).compute(
        'docs',
        'notion',
        new Map([
          ['pages/success/page.md', 'hash-success'],
          ['pages/failed/page.md', 'hash-failed'],
        ]),
      ),
    ).resolves.toEqual({
      added: ['pages/failed/page.md'],
      modified: [],
      deleted: [],
      unchanged: ['pages/success/page.md'],
    });
  });

  it('returns the latest stored report across bundle ingest runs', async () => {
    const store = new SqliteBundleIngestStore({
      dbPath,
      idFactory: idFactory(['run-old', 'report-old', 'run-new', 'report-new']),
      now: () => new Date('2026-04-30T10:00:00.000Z'),
    });

    const oldRun = await store.create(runArgs({ jobId: 'job-old', syncId: 'sync-old' }));
    await store.markCompleted(oldRun.id, diffSummary());
    await store.create({
      runId: oldRun.id,
      jobId: 'job-old',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: reportBody('sync-old'),
    });

    const newRun = await store.create(runArgs({ jobId: 'job-new', syncId: 'sync-new' }));
    await store.markCompleted(newRun.id, diffSummary({ modified: 1 }));
    await store.create({
      runId: newRun.id,
      jobId: 'job-new',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: reportBody('sync-new'),
    });

    await expect(store.findLatestReport()).resolves.toMatchObject({
      id: 'report-new',
      runId: 'run-new',
      jobId: 'job-new',
      body: { syncId: 'sync-new' },
    });
  });

  it('replaces a prior run with the same job_id when re-creating', async () => {
    const store = new SqliteBundleIngestStore({
      dbPath,
      idFactory: idFactory(['run-old', 'report-old', 'run-new', 'report-new']),
      now: () => new Date('2026-04-30T10:00:00.000Z'),
    });

    const oldRun = await store.create(runArgs({ jobId: 'demo-full-ingest', syncId: 'sync-1' }));
    expect(oldRun).toEqual({ id: 'run-old' });
    await store.markCompleted(oldRun.id, diffSummary());
    await store.create({
      runId: oldRun.id,
      jobId: 'demo-full-ingest',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: reportBody('sync-1'),
    });

    const newRun = await store.create(runArgs({ jobId: 'demo-full-ingest', syncId: 'sync-2' }));
    expect(newRun).toEqual({ id: 'run-new' });
    await store.markCompleted(newRun.id, diffSummary());
    await store.create({
      runId: newRun.id,
      jobId: 'demo-full-ingest',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: reportBody('sync-2'),
    });

    const reopened = new SqliteBundleIngestStore({ dbPath });
    await expect(reopened.findByJobId('demo-full-ingest')).resolves.toMatchObject({
      runId: 'run-new',
      body: { syncId: 'sync-2' },
    });
  });

  it('lists local canonical pins for the bundle runner port', async () => {
    const store = new SqliteBundleIngestStore({ dbPath });

    await store.replaceCanonicalPins('docs', [
      {
        contestedKey: 'gross revenue',
        canonicalArtifactKey: 'finance.revenue',
        pinnedAt: '2026-04-30T09:00:00.000Z',
        pinnedBy: 'analyst@example.com',
        reason: 'Finance source is canonical.',
      },
      {
        contestedKey: 'active customer',
        canonicalArtifactKey: 'crm.active_customer',
        pinnedAt: '2026-04-30T09:05:00.000Z',
        pinnedBy: 'analyst@example.com',
        reason: null,
      },
    ]);

    await expect(store.listPins(['docs'])).resolves.toEqual([
      {
        contestedKey: 'active customer',
        canonicalArtifactKey: 'crm.active_customer',
        pinnedAt: '2026-04-30T09:05:00.000Z',
        pinnedBy: 'analyst@example.com',
        reason: null,
      },
      {
        contestedKey: 'gross revenue',
        canonicalArtifactKey: 'finance.revenue',
        pinnedAt: '2026-04-30T09:00:00.000Z',
        pinnedBy: 'analyst@example.com',
        reason: 'Finance source is canonical.',
      },
    ]);
    await expect(store.listPins(['other'])).resolves.toEqual([]);
  });

  it('finds a report by report id, run id, or job id for local status and replay', async () => {
    const store = new SqliteBundleIngestStore({
      dbPath,
      idFactory: idFactory(['run-lookup', 'report-lookup']),
      now: () => new Date('2026-04-30T11:00:00.000Z'),
    });

    const run = await store.create(runArgs({ jobId: 'job-lookup', syncId: 'sync-lookup' }));
    await store.markCompleted(run.id, diffSummary({ added: 1 }));
    await store.create({
      runId: run.id,
      jobId: 'job-lookup',
      connectionId: 'docs',
      sourceKey: 'notion',
      body: reportBody('sync-lookup'),
    });

    await expect(store.findReportByAnyId('report-lookup')).resolves.toMatchObject({
      id: 'report-lookup',
      runId: 'run-lookup',
      jobId: 'job-lookup',
    });
    await expect(store.findReportByAnyId('run-lookup')).resolves.toMatchObject({
      id: 'report-lookup',
      runId: 'run-lookup',
      jobId: 'job-lookup',
    });
    await expect(store.findReportByAnyId('job-lookup')).resolves.toMatchObject({
      id: 'report-lookup',
      runId: 'run-lookup',
      jobId: 'job-lookup',
    });
    await expect(store.findReportByAnyId('missing')).resolves.toBeNull();
  });
});
