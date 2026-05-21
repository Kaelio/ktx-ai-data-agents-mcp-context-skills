import type { KtxLocalProject } from '../project/index.js';
import { describe, expect, it, vi } from 'vitest';
import {
  adviseLocalRelationshipFeedbackThresholds,
  buildKtxRelationshipThresholdAdviceReport,
  formatKtxRelationshipThresholdAdviceMarkdown,
} from './relationship-threshold-advice.js';
import type {
  ExportLocalRelationshipFeedbackLabelsResult,
  KtxRelationshipFeedbackLabel,
} from './relationship-feedback-export.js';

function label(
  input: Partial<KtxRelationshipFeedbackLabel> & Pick<KtxRelationshipFeedbackLabel, 'candidateId' | 'decision' | 'score'>,
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

describe('relationship threshold advice', () => {
  it('selects the highest-quality threshold candidate when enough labels exist', () => {
    const report = buildKtxRelationshipThresholdAdviceReport(
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
        acceptThresholds: [0.9, 0.85],
        reviewThresholds: [0.55],
        minTotalLabels: 4,
        minAcceptedLabels: 2,
        minRejectedLabels: 2,
        minAcceptedBandPrecision: 0.75,
        minAcceptedOrReviewRecall: 0.75,
        minRejectedBandPrecision: 0.75,
      },
    );

    expect(report.status).toBe('ready');
    expect(report.summary).toMatchObject({
      totalLabels: 4,
      scoredLabels: 4,
      acceptedLabels: 2,
      rejectedLabels: 2,
      eligibleCandidates: 1,
    });
    expect(report.recommended).toMatchObject({
      acceptThreshold: 0.9,
      reviewThreshold: 0.55,
      eligible: true,
      acceptedBandPrecision: 1,
      acceptedRecall: 0.5,
      acceptedOrReviewRecall: 1,
      rejectedBandPrecision: 1,
      rejectedRecall: 1,
      falseAcceptedRejectedLabels: 0,
      falseRejectedAcceptedLabels: 0,
    });
    expect(report.candidates.map((candidate) => [candidate.acceptThreshold, candidate.reviewThreshold, candidate.eligible])).toEqual([
      [0.9, 0.55, true],
      [0.85, 0.55, false],
    ]);
  });

  it('reports insufficient labels without hiding evaluated candidates', () => {
    const report = buildKtxRelationshipThresholdAdviceReport(
      feedback([
        label({ candidateId: 'orders:orders.customer_id->customers:customers.id', decision: 'accepted', score: 0.91 }),
        label({ candidateId: 'orders:orders.note_id->notes:notes.id', decision: 'rejected', score: 0.21 }),
      ]),
      {
        acceptThresholds: [0.9],
        reviewThresholds: [0.55],
        minTotalLabels: 10,
        minAcceptedLabels: 5,
        minRejectedLabels: 5,
      },
    );

    expect(report.status).toBe('insufficient_labels');
    expect(report.recommended).toBeNull();
    expect(report.summary).toMatchObject({
      totalLabels: 2,
      scoredLabels: 2,
      acceptedLabels: 1,
      rejectedLabels: 1,
      eligibleCandidates: 1,
    });
    expect(report.reasons).toEqual([
      'Need at least 10 scored labels; found 2.',
      'Need at least 5 accepted labels; found 1.',
      'Need at least 5 rejected labels; found 1.',
    ]);
    expect(report.candidates).toHaveLength(1);
  });

  it('reports no eligible thresholds when label counts pass but quality gates fail', () => {
    const report = buildKtxRelationshipThresholdAdviceReport(
      feedback([
        label({ candidateId: 'a', decision: 'accepted', score: 0.92 }),
        label({ candidateId: 'b', decision: 'accepted', score: 0.58 }),
        label({ candidateId: 'c', decision: 'rejected', score: 0.91 }),
        label({ candidateId: 'd', decision: 'rejected', score: 0.2 }),
      ]),
      {
        acceptThresholds: [0.9],
        reviewThresholds: [0.55],
        minTotalLabels: 4,
        minAcceptedLabels: 2,
        minRejectedLabels: 2,
        minAcceptedBandPrecision: 0.9,
      },
    );

    expect(report.status).toBe('no_eligible_thresholds');
    expect(report.recommended).toBeNull();
    expect(report.reasons).toEqual(['No threshold candidate met the precision and recall gates.']);
    expect(report.candidates[0]).toMatchObject({
      acceptThreshold: 0.9,
      reviewThreshold: 0.55,
      eligible: false,
      acceptedBandPrecision: 0.5,
    });
  });

  it('wraps the feedback exporter and preserves warnings', async () => {
    const project = { projectDir: '/tmp/ktx-project' } as KtxLocalProject;
    const exportLocalRelationshipFeedbackLabels = vi.fn(async () => ({
      ...feedback([]),
      warnings: [
        {
          path: 'raw-sources/broken/live-database/sync/enrichment/relationship-review-decisions.json',
          message: 'Unexpected token',
        },
      ],
    }));

    const report = await adviseLocalRelationshipFeedbackThresholds(project, {
      connectionId: 'warehouse',
      exportLocalRelationshipFeedbackLabels,
      minTotalLabels: 1,
    });

    expect(exportLocalRelationshipFeedbackLabels).toHaveBeenCalledWith(project, {
      connectionId: 'warehouse',
      decision: 'all',
    });
    expect(report.warnings).toEqual([
      {
        path: 'raw-sources/broken/live-database/sync/enrichment/relationship-review-decisions.json',
        message: 'Unexpected token',
      },
    ]);
  });

  it('formats a stable human-readable report', () => {
    const report = buildKtxRelationshipThresholdAdviceReport(
      feedback([
        label({ candidateId: 'orders:orders.customer_id->customers:customers.id', decision: 'accepted', score: 0.91 }),
        label({ candidateId: 'orders:orders.account_id->accounts:accounts.id', decision: 'accepted', score: 0.61 }),
        label({ candidateId: 'orders:orders.note_id->notes:notes.id', decision: 'rejected', score: 0.21 }),
        label({ candidateId: 'orders:orders.region_id->regions:regions.id', decision: 'rejected', score: 0.88 }),
      ]),
      {
        acceptThresholds: [0.9],
        reviewThresholds: [0.55],
        minTotalLabels: 4,
        minAcceptedLabels: 2,
        minRejectedLabels: 2,
        minAcceptedBandPrecision: 0.75,
      },
    );

    expect(formatKtxRelationshipThresholdAdviceMarkdown(report)).toContain('KTX relationship threshold advice');
    expect(formatKtxRelationshipThresholdAdviceMarkdown(report)).toContain('Status: ready');
    expect(formatKtxRelationshipThresholdAdviceMarkdown(report)).toContain('Recommended: accept=0.90 review=0.55');
    expect(formatKtxRelationshipThresholdAdviceMarkdown(report)).toContain('acceptedPrecision=1.000');
  });
});
