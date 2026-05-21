import type { KtxLocalProject } from '../project/index.js';
import { getLocalScanReport } from './local-scan.js';
import type { KtxRelationshipArtifact, KtxRelationshipDiagnosticsArtifact } from './relationship-diagnostics.js';
import type { KtxRelationshipProfileArtifact } from './relationship-profiling.js';
import type { KtxScanReport } from './types.js';

export type KtxRelationshipArtifactStatus = 'accepted' | 'review' | 'rejected' | 'skipped' | 'all';

export interface ReadLocalScanRelationshipArtifactsResult {
  runId: string;
  connectionId: string;
  syncId: string;
  report: KtxScanReport;
  relationships: KtxRelationshipArtifact;
  diagnostics: KtxRelationshipDiagnosticsArtifact | null;
  profile: KtxRelationshipProfileArtifact | null;
  paths: {
    relationships: string;
    diagnostics: string | null;
    profile: string | null;
  };
}

function findArtifactPath(report: KtxScanReport, fileName: string): string | null {
  return report.artifactPaths.enrichmentArtifacts.find((path) => path.endsWith(`/enrichment/${fileName}`)) ?? null;
}

async function readJsonArtifact<T>(project: KtxLocalProject, path: string): Promise<T> {
  const raw = await project.fileStore.readFile(path);
  return JSON.parse(raw.content) as T;
}

async function readOptionalJsonArtifact<T>(project: KtxLocalProject, path: string | null): Promise<T | null> {
  if (!path) {
    return null;
  }
  try {
    return await readJsonArtifact<T>(project, path);
  } catch {
    return null;
  }
}

export async function readLocalScanRelationshipArtifacts(
  project: KtxLocalProject,
  runId: string,
): Promise<ReadLocalScanRelationshipArtifactsResult | null> {
  const report = await getLocalScanReport(project, runId);
  if (!report) {
    return null;
  }

  const relationshipsPath = findArtifactPath(report, 'relationships.json');
  if (!relationshipsPath) {
    throw new Error(`Scan report "${runId}" does not reference relationships.json`);
  }

  const diagnosticsPath = findArtifactPath(report, 'relationship-diagnostics.json');
  const profilePath = findArtifactPath(report, 'relationship-profile.json');

  return {
    runId,
    connectionId: report.connectionId,
    syncId: report.syncId,
    report,
    relationships: await readJsonArtifact<KtxRelationshipArtifact>(project, relationshipsPath),
    diagnostics: await readOptionalJsonArtifact<KtxRelationshipDiagnosticsArtifact>(project, diagnosticsPath),
    profile: await readOptionalJsonArtifact<KtxRelationshipProfileArtifact>(project, profilePath),
    paths: {
      relationships: relationshipsPath,
      diagnostics: diagnosticsPath,
      profile: profilePath,
    },
  };
}
