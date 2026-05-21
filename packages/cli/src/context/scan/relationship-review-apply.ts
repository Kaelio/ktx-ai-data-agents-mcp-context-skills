import type { KtxLocalProject } from '../project/index.js';
import {
  readLocalScanRelationshipArtifacts,
  type ReadLocalScanRelationshipArtifactsResult,
} from './relationship-artifacts.js';
import {
  readLocalScanStructuralSnapshot,
  type ReadLocalScanStructuralSnapshotInput,
} from './local-structural-artifacts.js';
import {
  writeLocalScanManifestShards,
  type WriteLocalScanManifestShardsInput,
  type WriteLocalScanManifestShardsResult,
} from './local-enrichment-artifacts.js';
import type { KtxEnrichedRelationship, KtxRelationshipUpdate } from './enrichment-types.js';
import type {
  KtxRelationshipReviewDecisionArtifact,
  KtxRelationshipReviewDecisionEntry,
} from './relationship-review-decisions.js';

const DECISIONS_FILE = 'relationship-review-decisions.json';

export interface ApplyLocalScanRelationshipReviewDecisionsInput {
  runId: string;
  applyAllAccepted?: boolean;
  candidateIds?: readonly string[];
  dryRun?: boolean;
  readLocalScanRelationshipArtifacts?: typeof readLocalScanRelationshipArtifacts;
  readLocalScanStructuralSnapshot?: (
    input: ReadLocalScanStructuralSnapshotInput,
  ) => Promise<WriteLocalScanManifestShardsInput['snapshot']>;
  writeLocalScanManifestShards?: (
    input: WriteLocalScanManifestShardsInput,
  ) => Promise<WriteLocalScanManifestShardsResult>;
}

export interface AppliedRelationshipReviewDecision {
  candidateId: string;
  decidedAt: string;
  reviewer: string;
  note: string | null;
  relationship: KtxEnrichedRelationship;
}

export interface ApplyLocalScanRelationshipReviewDecisionsResult {
  runId: string;
  connectionId: string;
  syncId: string;
  dryRun: boolean;
  decisionsPath: string;
  selectedDecisions: number;
  appliedRelationships: number;
  relationships: KtxEnrichedRelationship[];
  manifestShards: string[];
  manifestShardsWritten: number;
}

function decisionsPathFromRelationshipsPath(relationshipsPath: string): string {
  return relationshipsPath.replace(/relationships\.json$/u, DECISIONS_FILE);
}

async function readDecisionArtifact(
  project: KtxLocalProject,
  path: string,
  runId: string,
): Promise<KtxRelationshipReviewDecisionArtifact> {
  let raw: { content: string };
  try {
    raw = await project.fileStore.readFile(path);
  } catch {
    throw new Error(`Relationship review decisions were not found for scan run "${runId}"`);
  }
  const parsed = JSON.parse(raw.content) as KtxRelationshipReviewDecisionArtifact;
  return {
    connectionId: parsed.connectionId,
    runId: parsed.runId,
    syncId: parsed.syncId,
    generatedAt: parsed.generatedAt,
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
  };
}

function assertSelection(input: ApplyLocalScanRelationshipReviewDecisionsInput): void {
  const candidateIds = input.candidateIds ?? [];
  if (input.applyAllAccepted === true && candidateIds.length > 0) {
    throw new Error('Use either --all-accepted or --candidate, not both');
  }
  if (input.applyAllAccepted !== true && candidateIds.length === 0) {
    throw new Error('Pass --all-accepted or at least one --candidate to choose review decisions to apply');
  }
}

function selectAcceptedDecisions(
  artifact: KtxRelationshipReviewDecisionArtifact,
  input: ApplyLocalScanRelationshipReviewDecisionsInput,
): KtxRelationshipReviewDecisionEntry[] {
  assertSelection(input);
  if (input.applyAllAccepted === true) {
    return artifact.decisions.filter((decision) => decision.decision === 'accepted');
  }

  const decisionsById = new Map(artifact.decisions.map((decision) => [decision.candidateId, decision]));
  const selected: KtxRelationshipReviewDecisionEntry[] = [];
  for (const candidateId of input.candidateIds ?? []) {
    const decision = decisionsById.get(candidateId);
    if (!decision) {
      throw new Error(`Relationship review decision "${candidateId}" was not found for scan run "${input.runId}"`);
    }
    if (decision.decision !== 'accepted') {
      throw new Error(`Relationship review decision "${candidateId}" is ${decision.decision}, not accepted`);
    }
    selected.push(decision);
  }
  return selected;
}

function tableId(table: KtxRelationshipReviewDecisionEntry['from']['table']): string {
  return [table.catalog, table.db, table.name].filter((part): part is string => Boolean(part)).join('.');
}

function columnIds(table: KtxRelationshipReviewDecisionEntry['from']['table'], columns: readonly string[]): string[] {
  const prefix = tableId(table);
  return columns.map((column) => `${prefix}.${column}`);
}

function relationshipFromDecision(decision: KtxRelationshipReviewDecisionEntry): KtxEnrichedRelationship {
  return {
    id: decision.candidateId,
    source: 'manual',
    from: {
      tableId: tableId(decision.from.table),
      columnIds: columnIds(decision.from.table, decision.from.columns),
      table: decision.from.table,
      columns: [...decision.from.columns],
    },
    to: {
      tableId: tableId(decision.to.table),
      columnIds: columnIds(decision.to.table, decision.to.columns),
      table: decision.to.table,
      columns: [...decision.to.columns],
    },
    relationshipType: decision.relationshipType,
    confidence: 1,
    isPrimaryKeyReference: true,
  };
}

function relationshipUpdate(
  connectionId: string,
  relationships: readonly KtxEnrichedRelationship[],
): KtxRelationshipUpdate {
  return {
    connectionId,
    accepted: [...relationships],
    rejected: [],
    skipped: [],
  };
}

function assertApplyableArtifacts(artifacts: ReadLocalScanRelationshipArtifactsResult): string {
  const rawSourcesDir = artifacts.report.artifactPaths.rawSourcesDir;
  if (!rawSourcesDir) {
    throw new Error(`Scan run "${artifacts.runId}" does not have raw source artifacts for manifest rewriting`);
  }
  return rawSourcesDir;
}

export async function applyLocalScanRelationshipReviewDecisions(
  project: KtxLocalProject,
  input: ApplyLocalScanRelationshipReviewDecisionsInput,
): Promise<ApplyLocalScanRelationshipReviewDecisionsResult> {
  const readArtifacts = input.readLocalScanRelationshipArtifacts ?? readLocalScanRelationshipArtifacts;
  const artifacts = await readArtifacts(project, input.runId);
  if (!artifacts) {
    throw new Error(`Scan run "${input.runId}" was not found`);
  }

  const decisionsPath = decisionsPathFromRelationshipsPath(artifacts.paths.relationships);
  const decisions = await readDecisionArtifact(project, decisionsPath, input.runId);
  const selected = selectAcceptedDecisions(decisions, input);
  const relationships = selected.map((decision) => relationshipFromDecision(decision));
  const dryRun = input.dryRun === true;

  if (dryRun || relationships.length === 0) {
    return {
      runId: artifacts.runId,
      connectionId: artifacts.connectionId,
      syncId: artifacts.syncId,
      dryRun,
      decisionsPath,
      selectedDecisions: selected.length,
      appliedRelationships: relationships.length,
      relationships,
      manifestShards: [],
      manifestShardsWritten: 0,
    };
  }

  const rawSourcesDir = assertApplyableArtifacts(artifacts);
  const readSnapshot = input.readLocalScanStructuralSnapshot ?? readLocalScanStructuralSnapshot;
  const writeManifestShards = input.writeLocalScanManifestShards ?? writeLocalScanManifestShards;
  const snapshot = await readSnapshot({
    project,
    connectionId: artifacts.connectionId,
    driver: artifacts.report.driver,
    rawSourcesDir,
    extractedAtFallback: artifacts.report.createdAt,
  });
  const manifest = await writeManifestShards({
    project,
    connectionId: artifacts.connectionId,
    syncId: artifacts.syncId,
    driver: artifacts.report.driver,
    snapshot,
    dryRun: false,
    relationshipUpdate: relationshipUpdate(artifacts.connectionId, relationships),
  });

  return {
    runId: artifacts.runId,
    connectionId: artifacts.connectionId,
    syncId: artifacts.syncId,
    dryRun,
    decisionsPath,
    selectedDecisions: selected.length,
    appliedRelationships: relationships.length,
    relationships,
    manifestShards: manifest.manifestShards,
    manifestShardsWritten: manifest.manifestShardsWritten,
  };
}
