import type { KtxLocalProject } from '../project/index.js';
import type { KtxRelationshipType } from './enrichment-types.js';
import { readLocalScanRelationshipArtifacts } from './relationship-artifacts.js';
import type {
  KtxRelationshipArtifactEdge,
  KtxRelationshipArtifactEndpoint,
} from './relationship-diagnostics.js';
import type { KtxResolvedRelationshipStatus } from './relationship-graph-resolver.js';

const LOCAL_AUTHOR = 'ktx';
const LOCAL_AUTHOR_EMAIL = 'ktx@example.com';
const DECISIONS_FILE = 'relationship-review-decisions.json';

export type KtxRelationshipReviewDecisionValue = 'accepted' | 'rejected';

export interface WriteLocalScanRelationshipReviewDecisionInput {
  runId: string;
  candidateId: string;
  decision: KtxRelationshipReviewDecisionValue;
  reviewer: string;
  note: string | null;
  decidedAt?: string;
}

export interface KtxRelationshipReviewDecisionEntry {
  candidateId: string;
  decision: KtxRelationshipReviewDecisionValue;
  previousStatus: KtxResolvedRelationshipStatus;
  connectionId: string;
  runId: string;
  syncId: string;
  decidedAt: string;
  reviewer: string;
  note: string | null;
  from: KtxRelationshipArtifactEndpoint;
  to: KtxRelationshipArtifactEndpoint;
  relationshipType: KtxRelationshipType;
  source: string;
  score: number | null;
  confidence: number;
  pkScore: number | null;
  fkScore: number | null;
  reasons: string[];
}

export interface KtxRelationshipReviewDecisionArtifact {
  connectionId: string;
  runId: string;
  syncId: string;
  generatedAt: string;
  decisions: KtxRelationshipReviewDecisionEntry[];
}

export interface WriteLocalScanRelationshipReviewDecisionResult {
  path: string;
  decision: KtxRelationshipReviewDecisionEntry;
  artifact: KtxRelationshipReviewDecisionArtifact;
}

function reviewDecisionPath(relationshipsPath: string): string {
  return relationshipsPath.replace(/relationships\.json$/u, DECISIONS_FILE);
}

function allCandidateEdges(result: Awaited<ReturnType<typeof readLocalScanRelationshipArtifacts>>): KtxRelationshipArtifactEdge[] {
  if (!result) {
    return [];
  }
  return [...result.relationships.accepted, ...result.relationships.review, ...result.relationships.rejected];
}

async function readExistingDecisions(
  project: KtxLocalProject,
  path: string,
  fallback: Omit<KtxRelationshipReviewDecisionArtifact, 'decisions'>,
): Promise<KtxRelationshipReviewDecisionArtifact> {
  try {
    const raw = await project.fileStore.readFile(path);
    const parsed = JSON.parse(raw.content) as KtxRelationshipReviewDecisionArtifact;
    return {
      connectionId: parsed.connectionId,
      runId: parsed.runId,
      syncId: parsed.syncId,
      generatedAt: parsed.generatedAt,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    };
  } catch {
    return { ...fallback, decisions: [] };
  }
}

function decisionEntry(input: {
  candidate: KtxRelationshipArtifactEdge;
  connectionId: string;
  runId: string;
  syncId: string;
  decision: KtxRelationshipReviewDecisionValue;
  reviewer: string;
  note: string | null;
  decidedAt: string;
}): KtxRelationshipReviewDecisionEntry {
  return {
    candidateId: input.candidate.id,
    decision: input.decision,
    previousStatus: input.candidate.status,
    connectionId: input.connectionId,
    runId: input.runId,
    syncId: input.syncId,
    decidedAt: input.decidedAt,
    reviewer: input.reviewer,
    note: input.note,
    from: input.candidate.from,
    to: input.candidate.to,
    relationshipType: input.candidate.relationshipType,
    source: input.candidate.source,
    score: input.candidate.score,
    confidence: input.candidate.confidence,
    pkScore: input.candidate.pkScore,
    fkScore: input.candidate.fkScore,
    reasons: [...input.candidate.reasons],
  };
}

function upsertDecision(
  existing: readonly KtxRelationshipReviewDecisionEntry[],
  next: KtxRelationshipReviewDecisionEntry,
): KtxRelationshipReviewDecisionEntry[] {
  return [...existing.filter((item) => item.candidateId !== next.candidateId), next].sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
}

export async function writeLocalScanRelationshipReviewDecision(
  project: KtxLocalProject,
  input: WriteLocalScanRelationshipReviewDecisionInput,
): Promise<WriteLocalScanRelationshipReviewDecisionResult | null> {
  const artifacts = await readLocalScanRelationshipArtifacts(project, input.runId);
  if (!artifacts) {
    return null;
  }

  const candidate = allCandidateEdges(artifacts).find((edge) => edge.id === input.candidateId);
  if (!candidate) {
    throw new Error(`Relationship candidate "${input.candidateId}" was not found in scan run "${input.runId}"`);
  }

  const decidedAt = input.decidedAt ?? new Date().toISOString();
  const path = reviewDecisionPath(artifacts.paths.relationships);
  const fallback = {
    connectionId: artifacts.connectionId,
    runId: artifacts.runId,
    syncId: artifacts.syncId,
    generatedAt: decidedAt,
  };
  const existing = await readExistingDecisions(project, path, fallback);
  const decision = decisionEntry({
    candidate,
    connectionId: artifacts.connectionId,
    runId: artifacts.runId,
    syncId: artifacts.syncId,
    decision: input.decision,
    reviewer: input.reviewer,
    note: input.note,
    decidedAt,
  });
  const artifact: KtxRelationshipReviewDecisionArtifact = {
    connectionId: artifacts.connectionId,
    runId: artifacts.runId,
    syncId: artifacts.syncId,
    generatedAt: decidedAt,
    decisions: upsertDecision(existing.decisions, decision),
  };

  await project.fileStore.writeFile(
    path,
    `${JSON.stringify(artifact, null, 2)}\n`,
    LOCAL_AUTHOR,
    LOCAL_AUTHOR_EMAIL,
    `scan(live-database): record relationship review decision runId=${input.runId}`,
  );

  return { path, decision, artifact };
}
