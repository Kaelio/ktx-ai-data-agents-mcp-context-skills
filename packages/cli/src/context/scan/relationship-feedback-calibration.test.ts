import type { KtxLocalProject } from '../project/index.js';
import { describe, expect, it, vi } from 'vitest';
import {
  buildKtxRelationshipFeedbackCalibrationReport,
  calibrateLocalRelationshipFeedbackLabels,
  formatKtxRelationshipFeedbackCalibrationMarkdown,
} from './relationship-feedback-calibration.js';
import type {
  ExportLocalRelationshipFeedbackLabelsResult,
  KtxRelationshipFeedbackLabel,
} from './relationship-feedback-export.js';

function label(
  input: Partial<KtxRelationshipFeedbackLabel> &
    Pick<KtxRelationshipFeedbackLabel, 'candidateId' | 'decision' | 'score'>,
): KtxRelationshipFeedbackLabel {
  return {
    schemaVersion: 1,
    previousStatus: 'review',
    connectionId: 'warehouse',
    runId: 'scan-run-a',
    syncId: 'sync-a',
    decidedAt: '2026-05-07T12:00:00.000Z',
    reviewer: 'Andrey',
    note: null,
    relationshipType: 'many_to_one',
    source: 'deterministic_name',
    confidence: input.score ?? 0,
    pkScore: input.pkScore ?? null,
    fkScore: input.fkScore ?? input.score,
    fromTable: 'public.orders',
    fromColumns: ['customer_id'],
    toTable: 'public.customers',
    toColumns: ['id'],
    reasons: [],
    artifactPath: 'raw-sources/warehouse/live-database/sync-a/enrichment/relationship-review-decisions.json',
    ...input,
  };
}

function feedback(labels: KtxRelationshipFeedbackLabel[]): ExportLocalRelationshipFeedbackLabelsResult {
  return {
    generatedAt: '2026-05-07T13:00:00.000Z',
    filters: { connectionId: null, decision: 'all' },
    summary: {
      total: labels.length,
      accepted: labels.filter((item) => item.decision === 'accepted').length,
      rejected: labels.filter((item) => item.decision === 'rejected').length,
      connections: new Set(labels.map((item) => item.connectionId)).size,
      runs: new Set(labels.map((item) => `${item.connectionId}:${item.runId}`)).size,
    },
    labels,
    warnings: [],
  };
}

describe('relationship feedback calibration', () => {
  it('builds score buckets and threshold-band summary from feedback labels', () => {
    const report = buildKtxRelationshipFeedbackCalibrationReport(
      feedback([
        label({
          candidateId: 'orders:orders.customer_id->customers:customers.id',
          decision: 'accepted',
          score: 0.91,
          pkScore: 0.97,
          fkScore: 0.91,
        }),
        label({
          candidateId: 'orders:orders.account_id->accounts:accounts.id',
          decision: 'accepted',
          score: 0.61,
          pkScore: 0.88,
          fkScore: 0.61,
        }),
        label({
          candidateId: 'orders:orders.note_id->notes:notes.id',
          decision: 'rejected',
          score: 0.21,
          pkScore: 0.4,
          fkScore: 0.21,
        }),
        label({
          candidateId: 'orders:orders.region_id->regions:regions.id',
          decision: 'rejected',
          score: 0.88,
          pkScore: 0.9,
          fkScore: 0.88,
        }),
      ]),
      {
        acceptThreshold: 0.85,
        reviewThreshold: 0.55,
      },
    );

    expect(report.thresholds).toEqual({ accept: 0.85, review: 0.55 });
    expect(report.summary).toEqual({
      total: 4,
      scored: 4,
      unscored: 0,
      acceptedLabels: 2,
      rejectedLabels: 2,
      predictedAccepted: 2,
      predictedReview: 1,
      predictedRejected: 1,
      acceptedBandPrecision: 0.5,
      rejectedBandPrecision: 1,
      reviewBandAcceptedRate: 1,
      meanAcceptedScore: 0.76,
      meanRejectedScore: 0.545,
    });
    expect(report.buckets.map((bucket) => [bucket.label, bucket.total, bucket.accepted, bucket.rejected, bucket.acceptanceRate])).toEqual([
      ['0.00-0.24', 1, 0, 1, 0],
      ['0.25-0.49', 0, 0, 0, null],
      ['0.50-0.74', 1, 1, 0, 1],
      ['0.75-1.00', 2, 1, 1, 0.5],
    ]);
    expect(report.labels.map((item) => [item.candidateId, item.predictedStatus, item.bucket])).toEqual([
      ['orders:orders.account_id->accounts:accounts.id', 'review', '0.50-0.74'],
      ['orders:orders.customer_id->customers:customers.id', 'accepted', '0.75-1.00'],
      ['orders:orders.note_id->notes:notes.id', 'rejected', '0.00-0.24'],
      ['orders:orders.region_id->regions:regions.id', 'accepted', '0.75-1.00'],
    ]);
  });

  it('keeps unscored labels visible without treating them as threshold predictions', () => {
    const report = buildKtxRelationshipFeedbackCalibrationReport(
      feedback([
        label({
          candidateId: 'orders:orders.note_id->notes:notes.id',
          decision: 'rejected',
          score: null,
          confidence: 0.2,
          fkScore: null,
        }),
      ]),
      {
        acceptThreshold: 0.85,
        reviewThreshold: 0.55,
      },
    );

    expect(report.summary).toMatchObject({
      total: 1,
      scored: 0,
      unscored: 1,
      predictedAccepted: 0,
      predictedReview: 0,
      predictedRejected: 0,
      acceptedBandPrecision: null,
      rejectedBandPrecision: null,
      reviewBandAcceptedRate: null,
      meanAcceptedScore: null,
      meanRejectedScore: null,
    });
    expect(report.labels[0]).toMatchObject({
      candidateId: 'orders:orders.note_id->notes:notes.id',
      predictedStatus: 'unscored',
      bucket: 'unscored',
    });
  });

  it('formats a stable markdown summary for human CLI output', () => {
    const report = buildKtxRelationshipFeedbackCalibrationReport(
      feedback([
        label({ candidateId: 'orders:orders.customer_id->customers:customers.id', decision: 'accepted', score: 0.91 }),
        label({ candidateId: 'orders:orders.note_id->notes:notes.id', decision: 'rejected', score: 0.21 }),
      ]),
      {
        acceptThreshold: 0.85,
        reviewThreshold: 0.55,
      },
    );

    expect(formatKtxRelationshipFeedbackCalibrationMarkdown(report)).toContain(
      'KTX relationship feedback calibration',
    );
    expect(formatKtxRelationshipFeedbackCalibrationMarkdown(report)).toContain('Total labels: 2');
    expect(formatKtxRelationshipFeedbackCalibrationMarkdown(report)).toContain('Accepted-band precision: 1.000');
    expect(formatKtxRelationshipFeedbackCalibrationMarkdown(report)).toContain(
      '0.75-1.00: total=1 accepted=1 rejected=0 acceptanceRate=1.000',
    );
  });

  it('wraps the feedback exporter and preserves exporter warnings', async () => {
    const project = { projectDir: '/tmp/ktx-project' } as KtxLocalProject;
    const exportLocalRelationshipFeedbackLabels = vi.fn(async () => ({
      ...feedback([
        label({ candidateId: 'orders:orders.customer_id->customers:customers.id', decision: 'accepted', score: 0.91 }),
      ]),
      warnings: [{ path: 'raw-sources/broken/live-database/sync/enrichment/relationship-review-decisions.json', message: 'Unexpected token' }],
    }));

    const report = await calibrateLocalRelationshipFeedbackLabels(project, {
      connectionId: 'warehouse',
      decision: 'all',
      acceptThreshold: 0.9,
      reviewThreshold: 0.5,
      exportLocalRelationshipFeedbackLabels,
    });

    expect(exportLocalRelationshipFeedbackLabels).toHaveBeenCalledWith(project, {
      connectionId: 'warehouse',
      decision: 'all',
    });
    expect(report.thresholds).toEqual({ accept: 0.9, review: 0.5 });
    expect(report.warnings).toEqual([
      { path: 'raw-sources/broken/live-database/sync/enrichment/relationship-review-decisions.json', message: 'Unexpected token' },
    ]);
  });
});
