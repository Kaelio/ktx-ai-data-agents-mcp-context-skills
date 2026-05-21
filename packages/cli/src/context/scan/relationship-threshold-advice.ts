import type { KtxLocalProject } from '../project/index.js';
import {
  exportLocalRelationshipFeedbackLabels,
  type ExportLocalRelationshipFeedbackLabelsInput,
  type ExportLocalRelationshipFeedbackLabelsResult,
  type KtxRelationshipFeedbackExportWarning,
  type KtxRelationshipFeedbackLabel,
} from './relationship-feedback-export.js';
import type { KtxResolvedRelationshipStatus } from './relationship-graph-resolver.js';

const DEFAULT_ACCEPT_THRESHOLDS = [0.95, 0.9, 0.85, 0.8, 0.75] as const;
const DEFAULT_REVIEW_THRESHOLDS = [0.65, 0.6, 0.55, 0.5, 0.45] as const;

type AdvicePredictedStatus = KtxResolvedRelationshipStatus;
export type KtxRelationshipThresholdAdviceStatus = 'ready' | 'insufficient_labels' | 'no_eligible_thresholds';

export interface BuildKtxRelationshipThresholdAdviceReportInput {
  acceptThresholds?: readonly number[];
  reviewThresholds?: readonly number[];
  minTotalLabels?: number;
  minAcceptedLabels?: number;
  minRejectedLabels?: number;
  minAcceptedBandPrecision?: number;
  minAcceptedOrReviewRecall?: number;
  minRejectedBandPrecision?: number;
}

export interface AdviseLocalRelationshipFeedbackThresholdsInput
  extends Omit<ExportLocalRelationshipFeedbackLabelsInput, 'decision'>,
    BuildKtxRelationshipThresholdAdviceReportInput {
  exportLocalRelationshipFeedbackLabels?: typeof exportLocalRelationshipFeedbackLabels;
}

export interface KtxRelationshipThresholdAdviceCandidate {
  acceptThreshold: number;
  reviewThreshold: number;
  eligible: boolean;
  predictedAccepted: number;
  predictedReview: number;
  predictedRejected: number;
  acceptedBandPrecision: number | null;
  acceptedRecall: number | null;
  acceptedOrReviewRecall: number | null;
  rejectedBandPrecision: number | null;
  rejectedRecall: number | null;
  falseAcceptedRejectedLabels: number;
  falseRejectedAcceptedLabels: number;
}

export interface KtxRelationshipThresholdAdviceReport {
  generatedAt: string;
  filters: ExportLocalRelationshipFeedbackLabelsResult['filters'];
  status: KtxRelationshipThresholdAdviceStatus;
  gates: {
    minTotalLabels: number;
    minAcceptedLabels: number;
    minRejectedLabels: number;
    minAcceptedBandPrecision: number;
    minAcceptedOrReviewRecall: number;
    minRejectedBandPrecision: number;
  };
  summary: {
    totalLabels: number;
    scoredLabels: number;
    unscoredLabels: number;
    acceptedLabels: number;
    rejectedLabels: number;
    evaluatedCandidates: number;
    eligibleCandidates: number;
  };
  recommended: KtxRelationshipThresholdAdviceCandidate | null;
  candidates: KtxRelationshipThresholdAdviceCandidate[];
  reasons: string[];
  warnings: KtxRelationshipFeedbackExportWarning[];
}

interface ResolvedAdviceInput {
  acceptThresholds: number[];
  reviewThresholds: number[];
  minTotalLabels: number;
  minAcceptedLabels: number;
  minRejectedLabels: number;
  minAcceptedBandPrecision: number;
  minAcceptedOrReviewRecall: number;
  minRejectedBandPrecision: number;
}

function resolveInput(input: BuildKtxRelationshipThresholdAdviceReportInput): ResolvedAdviceInput {
  return {
    acceptThresholds: [...(input.acceptThresholds ?? DEFAULT_ACCEPT_THRESHOLDS)].sort((left, right) => right - left),
    reviewThresholds: [...(input.reviewThresholds ?? DEFAULT_REVIEW_THRESHOLDS)].sort((left, right) => right - left),
    minTotalLabels: input.minTotalLabels ?? 20,
    minAcceptedLabels: input.minAcceptedLabels ?? 5,
    minRejectedLabels: input.minRejectedLabels ?? 5,
    minAcceptedBandPrecision: input.minAcceptedBandPrecision ?? 0.9,
    minAcceptedOrReviewRecall: input.minAcceptedOrReviewRecall ?? 0.8,
    minRejectedBandPrecision: input.minRejectedBandPrecision ?? 0.8,
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : roundMetric(numerator / denominator);
}

function prediction(score: number, acceptThreshold: number, reviewThreshold: number): AdvicePredictedStatus {
  if (score >= acceptThreshold) {
    return 'accepted';
  }
  if (score >= reviewThreshold) {
    return 'review';
  }
  return 'rejected';
}

function isMetricAtLeast(value: number | null, minimum: number): boolean {
  return value !== null && value >= minimum;
}

function thresholdCandidate(
  labels: readonly KtxRelationshipFeedbackLabel[],
  acceptThreshold: number,
  reviewThreshold: number,
  gates: ResolvedAdviceInput,
): KtxRelationshipThresholdAdviceCandidate {
  const scored = labels.filter((label): label is KtxRelationshipFeedbackLabel & { score: number } => label.score !== null);
  const acceptedLabels = scored.filter((label) => label.decision === 'accepted');
  const rejectedLabels = scored.filter((label) => label.decision === 'rejected');
  const predictions = scored.map((label) => ({
    label,
    predictedStatus: prediction(label.score, acceptThreshold, reviewThreshold),
  }));
  const predictedAccepted = predictions.filter((item) => item.predictedStatus === 'accepted');
  const predictedReview = predictions.filter((item) => item.predictedStatus === 'review');
  const predictedRejected = predictions.filter((item) => item.predictedStatus === 'rejected');
  const acceptedBandPrecision = ratio(
    predictedAccepted.filter((item) => item.label.decision === 'accepted').length,
    predictedAccepted.length,
  );
  const acceptedOrReviewRecall = ratio(
    predictions.filter((item) => item.label.decision === 'accepted' && item.predictedStatus !== 'rejected').length,
    acceptedLabels.length,
  );
  const rejectedBandPrecision = ratio(
    predictedRejected.filter((item) => item.label.decision === 'rejected').length,
    predictedRejected.length,
  );

  return {
    acceptThreshold,
    reviewThreshold,
    eligible:
      predictedAccepted.length > 0 &&
      predictedRejected.length > 0 &&
      isMetricAtLeast(acceptedBandPrecision, gates.minAcceptedBandPrecision) &&
      isMetricAtLeast(acceptedOrReviewRecall, gates.minAcceptedOrReviewRecall) &&
      isMetricAtLeast(rejectedBandPrecision, gates.minRejectedBandPrecision),
    predictedAccepted: predictedAccepted.length,
    predictedReview: predictedReview.length,
    predictedRejected: predictedRejected.length,
    acceptedBandPrecision,
    acceptedRecall: ratio(
      predictedAccepted.filter((item) => item.label.decision === 'accepted').length,
      acceptedLabels.length,
    ),
    acceptedOrReviewRecall,
    rejectedBandPrecision,
    rejectedRecall: ratio(
      predictions.filter((item) => item.label.decision === 'rejected' && item.predictedStatus !== 'accepted').length,
      rejectedLabels.length,
    ),
    falseAcceptedRejectedLabels: predictedAccepted.filter((item) => item.label.decision === 'rejected').length,
    falseRejectedAcceptedLabels: predictedRejected.filter((item) => item.label.decision === 'accepted').length,
  };
}

function metricRank(value: number | null): number {
  return value ?? -1;
}

function sortCandidates(
  candidates: readonly KtxRelationshipThresholdAdviceCandidate[],
): KtxRelationshipThresholdAdviceCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      Number(right.eligible) - Number(left.eligible) ||
      metricRank(right.acceptedBandPrecision) - metricRank(left.acceptedBandPrecision) ||
      metricRank(right.acceptedOrReviewRecall) - metricRank(left.acceptedOrReviewRecall) ||
      metricRank(right.rejectedBandPrecision) - metricRank(left.rejectedBandPrecision) ||
      right.acceptThreshold - left.acceptThreshold ||
      right.reviewThreshold - left.reviewThreshold,
  );
}

function labelGateReasons(labels: readonly KtxRelationshipFeedbackLabel[], gates: ResolvedAdviceInput): string[] {
  const scored = labels.filter((label) => label.score !== null);
  const accepted = scored.filter((label) => label.decision === 'accepted');
  const rejected = scored.filter((label) => label.decision === 'rejected');
  const reasons: string[] = [];
  if (scored.length < gates.minTotalLabels) {
    reasons.push(`Need at least ${gates.minTotalLabels} scored labels; found ${scored.length}.`);
  }
  if (accepted.length < gates.minAcceptedLabels) {
    reasons.push(`Need at least ${gates.minAcceptedLabels} accepted labels; found ${accepted.length}.`);
  }
  if (rejected.length < gates.minRejectedLabels) {
    reasons.push(`Need at least ${gates.minRejectedLabels} rejected labels; found ${rejected.length}.`);
  }
  return reasons;
}

export function buildKtxRelationshipThresholdAdviceReport(
  feedback: ExportLocalRelationshipFeedbackLabelsResult,
  input: BuildKtxRelationshipThresholdAdviceReportInput = {},
): KtxRelationshipThresholdAdviceReport {
  const gates = resolveInput(input);
  const scored = feedback.labels.filter((label) => label.score !== null);
  const acceptedLabels = scored.filter((label) => label.decision === 'accepted');
  const rejectedLabels = scored.filter((label) => label.decision === 'rejected');
  const candidates = sortCandidates(
    gates.acceptThresholds.flatMap((acceptThreshold) =>
      gates.reviewThresholds.flatMap((reviewThreshold) =>
        acceptThreshold > reviewThreshold
          ? [thresholdCandidate(feedback.labels, acceptThreshold, reviewThreshold, gates)]
          : [],
      ),
    ),
  );
  const labelReasons = labelGateReasons(feedback.labels, gates);
  const eligibleCandidates = candidates.filter((candidate) => candidate.eligible);
  const status: KtxRelationshipThresholdAdviceStatus =
    labelReasons.length > 0 ? 'insufficient_labels' : eligibleCandidates.length > 0 ? 'ready' : 'no_eligible_thresholds';
  const reasons =
    status === 'insufficient_labels'
      ? labelReasons
      : status === 'no_eligible_thresholds'
        ? ['No threshold candidate met the precision and recall gates.']
        : [];

  return {
    generatedAt: feedback.generatedAt,
    filters: feedback.filters,
    status,
    gates: {
      minTotalLabels: gates.minTotalLabels,
      minAcceptedLabels: gates.minAcceptedLabels,
      minRejectedLabels: gates.minRejectedLabels,
      minAcceptedBandPrecision: gates.minAcceptedBandPrecision,
      minAcceptedOrReviewRecall: gates.minAcceptedOrReviewRecall,
      minRejectedBandPrecision: gates.minRejectedBandPrecision,
    },
    summary: {
      totalLabels: feedback.labels.length,
      scoredLabels: scored.length,
      unscoredLabels: feedback.labels.length - scored.length,
      acceptedLabels: acceptedLabels.length,
      rejectedLabels: rejectedLabels.length,
      evaluatedCandidates: candidates.length,
      eligibleCandidates: eligibleCandidates.length,
    },
    recommended: status === 'ready' ? eligibleCandidates[0] ?? null : null,
    candidates,
    reasons,
    warnings: [...feedback.warnings],
  };
}

export async function adviseLocalRelationshipFeedbackThresholds(
  project: KtxLocalProject,
  input: AdviseLocalRelationshipFeedbackThresholdsInput = {},
): Promise<KtxRelationshipThresholdAdviceReport> {
  const exporter = input.exportLocalRelationshipFeedbackLabels ?? exportLocalRelationshipFeedbackLabels;
  const feedback = await exporter(project, {
    connectionId: input.connectionId,
    decision: 'all',
  });
  return buildKtxRelationshipThresholdAdviceReport(feedback, input);
}

function formatMetric(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

function candidateLine(candidate: KtxRelationshipThresholdAdviceCandidate): string {
  return [
    `accept=${candidate.acceptThreshold.toFixed(2)}`,
    `review=${candidate.reviewThreshold.toFixed(2)}`,
    `eligible=${candidate.eligible ? 'yes' : 'no'}`,
    `acceptedPrecision=${formatMetric(candidate.acceptedBandPrecision)}`,
    `acceptedRecall=${formatMetric(candidate.acceptedRecall)}`,
    `acceptedOrReviewRecall=${formatMetric(candidate.acceptedOrReviewRecall)}`,
    `rejectedPrecision=${formatMetric(candidate.rejectedBandPrecision)}`,
    `rejectedRecall=${formatMetric(candidate.rejectedRecall)}`,
    `falseAcceptedRejected=${candidate.falseAcceptedRejectedLabels}`,
    `falseRejectedAccepted=${candidate.falseRejectedAcceptedLabels}`,
  ].join(' ');
}

export function formatKtxRelationshipThresholdAdviceMarkdown(report: KtxRelationshipThresholdAdviceReport): string {
  const lines = [
    'KTX relationship threshold advice',
    `Generated: ${report.generatedAt}`,
    `Filter connection: ${report.filters.connectionId ?? 'all'}`,
    `Status: ${report.status}`,
    `Labels: total=${report.summary.totalLabels} scored=${report.summary.scoredLabels} accepted=${report.summary.acceptedLabels} rejected=${report.summary.rejectedLabels}`,
    `Gates: minTotal=${report.gates.minTotalLabels} minAccepted=${report.gates.minAcceptedLabels} minRejected=${report.gates.minRejectedLabels} acceptedPrecision=${report.gates.minAcceptedBandPrecision.toFixed(3)} acceptedOrReviewRecall=${report.gates.minAcceptedOrReviewRecall.toFixed(3)} rejectedPrecision=${report.gates.minRejectedBandPrecision.toFixed(3)}`,
    `Evaluated candidates: ${report.summary.evaluatedCandidates}`,
    `Eligible candidates: ${report.summary.eligibleCandidates}`,
    `Recommended: ${
      report.recommended
        ? `accept=${report.recommended.acceptThreshold.toFixed(2)} review=${report.recommended.reviewThreshold.toFixed(2)}`
        : 'none'
    }`,
  ];

  if (report.reasons.length > 0) {
    lines.push('', 'Reasons', ...report.reasons.map((reason) => `  - ${reason}`));
  }

  if (report.candidates.length > 0) {
    lines.push('', 'Top candidates', ...report.candidates.slice(0, 5).map((candidate) => `  - ${candidateLine(candidate)}`));
  }

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings');
    for (const warning of report.warnings.slice(0, 5)) {
      lines.push(`  - ${warning.path}: ${warning.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
