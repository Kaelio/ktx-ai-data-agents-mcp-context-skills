import type { KtxLocalProject } from '../project/index.js';
import type {
  KtxRelationshipReviewDecisionArtifact,
  KtxRelationshipReviewDecisionEntry,
  KtxRelationshipReviewDecisionValue,
} from './relationship-review-decisions.js';

const DECISION_ARTIFACT_SUFFIX = '/enrichment/relationship-review-decisions.json';
const FEEDBACK_SCHEMA_VERSION = 1;

export type KtxRelationshipFeedbackDecisionFilter = KtxRelationshipReviewDecisionValue | 'all';

export interface ExportLocalRelationshipFeedbackLabelsInput {
  connectionId?: string | null;
  decision?: KtxRelationshipFeedbackDecisionFilter;
  now?: () => Date;
}

export interface KtxRelationshipFeedbackLabel {
  schemaVersion: 1;
  candidateId: string;
  decision: KtxRelationshipReviewDecisionValue;
  previousStatus: KtxRelationshipReviewDecisionEntry['previousStatus'];
  connectionId: string;
  runId: string;
  syncId: string;
  decidedAt: string;
  reviewer: string;
  note: string | null;
  relationshipType: KtxRelationshipReviewDecisionEntry['relationshipType'];
  source: string;
  score: number | null;
  confidence: number;
  pkScore: number | null;
  fkScore: number | null;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  reasons: string[];
  artifactPath: string;
}

export interface KtxRelationshipFeedbackExportWarning {
  path: string;
  message: string;
}

export interface ExportLocalRelationshipFeedbackLabelsResult {
  generatedAt: string;
  filters: {
    connectionId: string | null;
    decision: KtxRelationshipFeedbackDecisionFilter;
  };
  summary: {
    total: number;
    accepted: number;
    rejected: number;
    connections: number;
    runs: number;
  };
  labels: KtxRelationshipFeedbackLabel[];
  warnings: KtxRelationshipFeedbackExportWarning[];
}

function qualifiedTableName(entry: KtxRelationshipReviewDecisionEntry, side: 'from' | 'to'): string {
  const table = entry[side].table;
  return [table.catalog, table.db, table.name].filter((part): part is string => Boolean(part)).join('.');
}

function labelFromDecision(entry: KtxRelationshipReviewDecisionEntry, artifactPath: string): KtxRelationshipFeedbackLabel {
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    candidateId: entry.candidateId,
    decision: entry.decision,
    previousStatus: entry.previousStatus,
    connectionId: entry.connectionId,
    runId: entry.runId,
    syncId: entry.syncId,
    decidedAt: entry.decidedAt,
    reviewer: entry.reviewer,
    note: entry.note,
    relationshipType: entry.relationshipType,
    source: entry.source,
    score: entry.score,
    confidence: entry.confidence,
    pkScore: entry.pkScore,
    fkScore: entry.fkScore,
    fromTable: qualifiedTableName(entry, 'from'),
    fromColumns: [...entry.from.columns],
    toTable: qualifiedTableName(entry, 'to'),
    toColumns: [...entry.to.columns],
    reasons: [...entry.reasons],
    artifactPath,
  };
}

function sortLabels(labels: KtxRelationshipFeedbackLabel[]): KtxRelationshipFeedbackLabel[] {
  return [...labels].sort((left, right) => {
    return (
      left.connectionId.localeCompare(right.connectionId) ||
      left.runId.localeCompare(right.runId) ||
      left.candidateId.localeCompare(right.candidateId) ||
      left.decidedAt.localeCompare(right.decidedAt)
    );
  });
}

function passesFilters(
  label: KtxRelationshipFeedbackLabel,
  filters: { connectionId: string | null; decision: KtxRelationshipFeedbackDecisionFilter },
): boolean {
  if (filters.connectionId && label.connectionId !== filters.connectionId) {
    return false;
  }
  return filters.decision === 'all' || label.decision === filters.decision;
}

function messageFromUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readDecisionLabels(
  project: KtxLocalProject,
  artifactPath: string,
): Promise<KtxRelationshipFeedbackLabel[]> {
  const raw = await project.fileStore.readFile(artifactPath);
  const parsed = JSON.parse(raw.content) as KtxRelationshipReviewDecisionArtifact;
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  return decisions.map((entry) => labelFromDecision(entry, artifactPath));
}

function summarize(labels: KtxRelationshipFeedbackLabel[]): ExportLocalRelationshipFeedbackLabelsResult['summary'] {
  return {
    total: labels.length,
    accepted: labels.filter((label) => label.decision === 'accepted').length,
    rejected: labels.filter((label) => label.decision === 'rejected').length,
    connections: new Set(labels.map((label) => label.connectionId)).size,
    runs: new Set(labels.map((label) => `${label.connectionId}:${label.runId}`)).size,
  };
}

export async function exportLocalRelationshipFeedbackLabels(
  project: KtxLocalProject,
  input: ExportLocalRelationshipFeedbackLabelsInput = {},
): Promise<ExportLocalRelationshipFeedbackLabelsResult> {
  const filters = {
    connectionId: input.connectionId ?? null,
    decision: input.decision ?? 'all',
  };
  const listed = await project.fileStore.listFiles('raw-sources');
  const artifactPaths = listed.files.filter((path) => path.endsWith(DECISION_ARTIFACT_SUFFIX)).sort();
  const labels: KtxRelationshipFeedbackLabel[] = [];
  const warnings: KtxRelationshipFeedbackExportWarning[] = [];

  for (const artifactPath of artifactPaths) {
    try {
      labels.push(...(await readDecisionLabels(project, artifactPath)));
    } catch (error) {
      warnings.push({ path: artifactPath, message: messageFromUnknownError(error) });
    }
  }

  const filtered = sortLabels(labels.filter((label) => passesFilters(label, filters)));
  return {
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    filters,
    summary: summarize(filtered),
    labels: filtered,
    warnings,
  };
}

export function formatKtxRelationshipFeedbackLabelsJsonl(result: ExportLocalRelationshipFeedbackLabelsResult): string {
  if (result.labels.length === 0) {
    return '';
  }
  return `${result.labels.map((label) => JSON.stringify(label)).join('\n')}\n`;
}
