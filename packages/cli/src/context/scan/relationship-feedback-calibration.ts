import type { KtxLocalProject } from '../project/index.js';
import {
  exportLocalRelationshipFeedbackLabels,
  type ExportLocalRelationshipFeedbackLabelsInput,
  type ExportLocalRelationshipFeedbackLabelsResult,
  type KtxRelationshipFeedbackExportWarning,
  type KtxRelationshipFeedbackLabel,
} from './relationship-feedback-export.js';
import type { KtxResolvedRelationshipStatus } from './relationship-graph-resolver.js';
import type { KtxRelationshipReviewDecisionValue } from './relationship-review-decisions.js';

const DEFAULT_ACCEPT_THRESHOLD = 0.85;
const DEFAULT_REVIEW_THRESHOLD = 0.55;

type CalibrationPredictedStatus = KtxResolvedRelationshipStatus | 'unscored';

interface Thresholds {
  accept: number;
  review: number;
}

export interface BuildKtxRelationshipFeedbackCalibrationReportInput {
  acceptThreshold?: number;
  reviewThreshold?: number;
}

export interface CalibrateLocalRelationshipFeedbackLabelsInput
  extends ExportLocalRelationshipFeedbackLabelsInput,
    BuildKtxRelationshipFeedbackCalibrationReportInput {
  exportLocalRelationshipFeedbackLabels?: typeof exportLocalRelationshipFeedbackLabels;
}

export interface KtxRelationshipFeedbackCalibrationBucket {
  label: string;
  minInclusive: number;
  maxInclusive: number;
  total: number;
  accepted: number;
  rejected: number;
  acceptanceRate: number | null;
}

export interface KtxRelationshipFeedbackCalibrationLabel {
  candidateId: string;
  decision: KtxRelationshipReviewDecisionValue;
  previousStatus: KtxRelationshipFeedbackLabel['previousStatus'];
  predictedStatus: CalibrationPredictedStatus;
  bucket: string;
  score: number | null;
  pkScore: number | null;
  fkScore: number | null;
  connectionId: string;
  runId: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  source: string;
  reasons: string[];
}

export interface KtxRelationshipFeedbackCalibrationReport {
  generatedAt: string;
  filters: ExportLocalRelationshipFeedbackLabelsResult['filters'];
  thresholds: Thresholds;
  summary: {
    total: number;
    scored: number;
    unscored: number;
    acceptedLabels: number;
    rejectedLabels: number;
    predictedAccepted: number;
    predictedReview: number;
    predictedRejected: number;
    acceptedBandPrecision: number | null;
    rejectedBandPrecision: number | null;
    reviewBandAcceptedRate: number | null;
    meanAcceptedScore: number | null;
    meanRejectedScore: number | null;
  };
  buckets: KtxRelationshipFeedbackCalibrationBucket[];
  labels: KtxRelationshipFeedbackCalibrationLabel[];
  warnings: KtxRelationshipFeedbackExportWarning[];
}

const BUCKETS = [
  { label: '0.00-0.24', minInclusive: 0, maxInclusive: 0.249999 },
  { label: '0.25-0.49', minInclusive: 0.25, maxInclusive: 0.499999 },
  { label: '0.50-0.74', minInclusive: 0.5, maxInclusive: 0.749999 },
  { label: '0.75-1.00', minInclusive: 0.75, maxInclusive: 1 },
] as const;

function thresholds(input: BuildKtxRelationshipFeedbackCalibrationReportInput): Thresholds {
  return {
    accept: input.acceptThreshold ?? DEFAULT_ACCEPT_THRESHOLD,
    review: input.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD,
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : roundMetric(numerator / denominator);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function scoreBucket(score: number | null): string {
  if (score === null) {
    return 'unscored';
  }
  return BUCKETS.find((bucket) => score >= bucket.minInclusive && score <= bucket.maxInclusive)?.label ?? 'unscored';
}

function predictedStatus(score: number | null, currentThresholds: Thresholds): CalibrationPredictedStatus {
  if (score === null) {
    return 'unscored';
  }
  if (score >= currentThresholds.accept) {
    return 'accepted';
  }
  if (score >= currentThresholds.review) {
    return 'review';
  }
  return 'rejected';
}

function calibrationLabel(
  label: KtxRelationshipFeedbackLabel,
  currentThresholds: Thresholds,
): KtxRelationshipFeedbackCalibrationLabel {
  return {
    candidateId: label.candidateId,
    decision: label.decision,
    previousStatus: label.previousStatus,
    predictedStatus: predictedStatus(label.score, currentThresholds),
    bucket: scoreBucket(label.score),
    score: label.score,
    pkScore: label.pkScore,
    fkScore: label.fkScore,
    connectionId: label.connectionId,
    runId: label.runId,
    fromTable: label.fromTable,
    fromColumns: [...label.fromColumns],
    toTable: label.toTable,
    toColumns: [...label.toColumns],
    source: label.source,
    reasons: [...label.reasons],
  };
}

function summarize(
  labels: readonly KtxRelationshipFeedbackCalibrationLabel[],
): KtxRelationshipFeedbackCalibrationReport['summary'] {
  const scored = labels.filter((label) => label.score !== null);
  const predictedAccepted = scored.filter((label) => label.predictedStatus === 'accepted');
  const predictedReview = scored.filter((label) => label.predictedStatus === 'review');
  const predictedRejected = scored.filter((label) => label.predictedStatus === 'rejected');
  const acceptedLabels = labels.filter((label) => label.decision === 'accepted');
  const rejectedLabels = labels.filter((label) => label.decision === 'rejected');

  return {
    total: labels.length,
    scored: scored.length,
    unscored: labels.length - scored.length,
    acceptedLabels: acceptedLabels.length,
    rejectedLabels: rejectedLabels.length,
    predictedAccepted: predictedAccepted.length,
    predictedReview: predictedReview.length,
    predictedRejected: predictedRejected.length,
    acceptedBandPrecision: ratio(
      predictedAccepted.filter((label) => label.decision === 'accepted').length,
      predictedAccepted.length,
    ),
    rejectedBandPrecision: ratio(
      predictedRejected.filter((label) => label.decision === 'rejected').length,
      predictedRejected.length,
    ),
    reviewBandAcceptedRate: ratio(
      predictedReview.filter((label) => label.decision === 'accepted').length,
      predictedReview.length,
    ),
    meanAcceptedScore: mean(acceptedLabels.map((label) => label.score).filter((score): score is number => score !== null)),
    meanRejectedScore: mean(rejectedLabels.map((label) => label.score).filter((score): score is number => score !== null)),
  };
}

function buildBuckets(
  labels: readonly KtxRelationshipFeedbackCalibrationLabel[],
): KtxRelationshipFeedbackCalibrationBucket[] {
  return BUCKETS.map((bucket) => {
    const bucketLabels = labels.filter((label) => label.bucket === bucket.label);
    const accepted = bucketLabels.filter((label) => label.decision === 'accepted').length;
    const rejected = bucketLabels.filter((label) => label.decision === 'rejected').length;
    return {
      label: bucket.label,
      minInclusive: bucket.minInclusive,
      maxInclusive:
        bucket.maxInclusive === 0.249999
          ? 0.24
          : bucket.maxInclusive === 0.499999
            ? 0.49
            : bucket.maxInclusive === 0.749999
              ? 0.74
              : 1,
      total: bucketLabels.length,
      accepted,
      rejected,
      acceptanceRate: ratio(accepted, bucketLabels.length),
    };
  });
}

export function buildKtxRelationshipFeedbackCalibrationReport(
  feedback: ExportLocalRelationshipFeedbackLabelsResult,
  input: BuildKtxRelationshipFeedbackCalibrationReportInput = {},
): KtxRelationshipFeedbackCalibrationReport {
  const currentThresholds = thresholds(input);
  const labels = feedback.labels
    .map((label) => calibrationLabel(label, currentThresholds))
    .sort(
      (left, right) =>
        left.connectionId.localeCompare(right.connectionId) ||
        left.runId.localeCompare(right.runId) ||
        left.candidateId.localeCompare(right.candidateId),
    );

  return {
    generatedAt: feedback.generatedAt,
    filters: feedback.filters,
    thresholds: currentThresholds,
    summary: summarize(labels),
    buckets: buildBuckets(labels),
    labels,
    warnings: [...feedback.warnings],
  };
}

export async function calibrateLocalRelationshipFeedbackLabels(
  project: KtxLocalProject,
  input: CalibrateLocalRelationshipFeedbackLabelsInput = {},
): Promise<KtxRelationshipFeedbackCalibrationReport> {
  const exporter = input.exportLocalRelationshipFeedbackLabels ?? exportLocalRelationshipFeedbackLabels;
  const feedback = await exporter(project, {
    connectionId: input.connectionId,
    decision: input.decision,
  });
  return buildKtxRelationshipFeedbackCalibrationReport(feedback, input);
}

function formatMetric(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

export function formatKtxRelationshipFeedbackCalibrationMarkdown(
  report: KtxRelationshipFeedbackCalibrationReport,
): string {
  const lines = [
    'KTX relationship feedback calibration',
    `Generated: ${report.generatedAt}`,
    `Filter connection: ${report.filters.connectionId ?? 'all'}`,
    `Filter decision: ${report.filters.decision}`,
    `Thresholds: accept=${report.thresholds.accept.toFixed(2)} review=${report.thresholds.review.toFixed(2)}`,
    `Total labels: ${report.summary.total}`,
    `Scored labels: ${report.summary.scored}`,
    `Unscored labels: ${report.summary.unscored}`,
    `Accepted labels: ${report.summary.acceptedLabels}`,
    `Rejected labels: ${report.summary.rejectedLabels}`,
    `Predicted accepted: ${report.summary.predictedAccepted}`,
    `Predicted review: ${report.summary.predictedReview}`,
    `Predicted rejected: ${report.summary.predictedRejected}`,
    `Accepted-band precision: ${formatMetric(report.summary.acceptedBandPrecision)}`,
    `Rejected-band precision: ${formatMetric(report.summary.rejectedBandPrecision)}`,
    `Review-band accepted rate: ${formatMetric(report.summary.reviewBandAcceptedRate)}`,
    `Mean accepted score: ${formatMetric(report.summary.meanAcceptedScore)}`,
    `Mean rejected score: ${formatMetric(report.summary.meanRejectedScore)}`,
    '',
    'Score buckets',
    ...report.buckets.map(
      (bucket) =>
        `  - ${bucket.label}: total=${bucket.total} accepted=${bucket.accepted} rejected=${bucket.rejected} acceptanceRate=${formatMetric(bucket.acceptanceRate)}`,
    ),
  ];

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings');
    for (const warning of report.warnings.slice(0, 5)) {
      lines.push(`  - ${warning.path}: ${warning.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
