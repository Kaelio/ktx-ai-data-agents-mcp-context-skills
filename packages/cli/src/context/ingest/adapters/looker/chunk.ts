import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, WorkUnit } from '../../types.js';
import { buildLookerReconcileNotes } from './reconcile.js';
import {
  STAGED_FILES,
  type StagedDashboardFile,
  type StagedLookerQuery,
  type StagedLookFile,
  stagedDashboardFileSchema,
  stagedExploreFileSchema,
  stagedLookFileSchema,
} from './types.js';

interface LoadedLookerProject {
  allPaths: string[];
  dashboardsByPath: Map<string, StagedDashboardFile>;
  looksByPath: Map<string, StagedLookFile>;
  explorePaths: string[];
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

async function loadProject(stagedDir: string): Promise<LoadedLookerProject> {
  const allPaths = await walk(stagedDir);
  const dashboardsByPath = new Map<string, StagedDashboardFile>();
  const looksByPath = new Map<string, StagedLookFile>();
  const explorePaths: string[] = [];

  for (const path of allPaths) {
    if (/^dashboards\/[^/]+\.json$/.test(path)) {
      dashboardsByPath.set(
        path,
        stagedDashboardFileSchema.parse(JSON.parse(await readFile(join(stagedDir, path), 'utf-8'))),
      );
      continue;
    }
    if (/^looks\/[^/]+\.json$/.test(path)) {
      looksByPath.set(path, stagedLookFileSchema.parse(JSON.parse(await readFile(join(stagedDir, path), 'utf-8'))));
      continue;
    }
    if (/^explores\/[^/]+\/[^/]+\.json$/.test(path)) {
      const explore = stagedExploreFileSchema.parse(JSON.parse(await readFile(join(stagedDir, path), 'utf-8')));
      explorePaths.push(explorePath(explore.modelName, explore.exploreName));
    }
  }

  return { allPaths, dashboardsByPath, looksByPath, explorePaths: [...new Set(explorePaths)].sort() };
}

export async function chunkLookerStagedDir(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
  const project = await loadProject(stagedDir);
  const firstRunUnits = emitFirstRunWorkUnits(project);
  const result = diffSet ? applyDiffSet(firstRunUnits, diffSet) : { workUnits: firstRunUnits };
  const eviction =
    diffSet && diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted].sort() } : result.eviction;
  return {
    ...result,
    eviction,
    reconcileNotes: result.workUnits.length > 0 || eviction ? buildLookerReconcileNotes() : [],
  };
}

function emitFirstRunWorkUnits(project: LoadedLookerProject): WorkUnit[] {
  const units: WorkUnit[] = [];

  for (const path of project.explorePaths) {
    const parts = /^explores\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!parts) {
      continue;
    }
    const deps = project.allPaths.includes(STAGED_FILES.lookmlModels) ? [STAGED_FILES.lookmlModels] : [];
    units.push(
      buildUnit(project, {
        unitKey: `looker-explore-${parts[1]}-${parts[2]}`,
        displayLabel: `Looker explore ${parts[1]}.${parts[2]}`,
        rawFiles: [path, ...evidencePathsForExplore(project, parts[1], parts[2])],
        dependencyPaths: deps,
        notes: `Write API-derived SL source looker__${parts[1]}__${parts[2]} and durable domain knowledge for this Looker explore.`,
      }),
    );
  }

  for (const [path, dashboard] of [...project.dashboardsByPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const deps = new Set<string>();
    addIfPresent(project, deps, STAGED_FILES.foldersTree);
    addIfPresent(project, deps, STAGED_FILES.signals.dashboardUsage);
    addIfPresent(project, deps, STAGED_FILES.signals.scheduledPlans);
    addIfPresent(project, deps, STAGED_FILES.signals.favorites);
    if (dashboard.ownerId) {
      addIfPresent(project, deps, `users/${dashboard.ownerId}.json`);
    }
    for (const tile of dashboard.tiles) {
      addExploreDependency(project, deps, tile.query);
    }

    units.push(
      buildUnit(project, {
        unitKey: `looker-dashboard-${dashboard.lookerId}`,
        displayLabel: `Looker dashboard "${dashboard.title}"`,
        rawFiles: [path, ...evidencePathsForDashboard(project, dashboard.lookerId)],
        dependencyPaths: [...deps].sort(),
        notes:
          'Extract generalizable metric, segment, and domain knowledge from this dashboard. Treat usage, owner, and folder data as prioritization/provenance context only. Use context_evidence_search/context_evidence_read and context_candidate_write for wiki-bound knowledge; do not write wiki pages directly from this WorkUnit.',
      }),
    );
  }

  for (const [path, look] of [...project.looksByPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const deps = new Set<string>();
    addIfPresent(project, deps, STAGED_FILES.foldersTree);
    addIfPresent(project, deps, STAGED_FILES.signals.lookUsage);
    addIfPresent(project, deps, STAGED_FILES.signals.scheduledPlans);
    addIfPresent(project, deps, STAGED_FILES.signals.favorites);
    if (look.ownerId) {
      addIfPresent(project, deps, `users/${look.ownerId}.json`);
    }
    addExploreDependency(project, deps, look.query);

    units.push(
      buildUnit(project, {
        unitKey: `looker-look-${look.lookerId}`,
        displayLabel: `Looker Look "${look.title}"`,
        rawFiles: [path, ...evidencePathsForLook(project, look.lookerId)],
        dependencyPaths: [...deps].sort(),
        notes:
          'Extract generalizable metric, segment, and domain knowledge from this Look. Treat usage, owner, and folder data as prioritization/provenance context only. Use context_evidence_search/context_evidence_read and context_candidate_write for wiki-bound knowledge; do not write wiki pages directly from this WorkUnit.',
      }),
    );
  }

  return units.sort((a, b) => a.unitKey.localeCompare(b.unitKey));
}

function buildUnit(
  project: LoadedLookerProject,
  input: Pick<WorkUnit, 'unitKey' | 'displayLabel' | 'rawFiles' | 'dependencyPaths' | 'notes'>,
): WorkUnit {
  const excluded = new Set([...input.rawFiles, ...input.dependencyPaths]);
  return {
    ...input,
    peerFileIndex: project.allPaths.filter((path) => !excluded.has(path)).sort(),
  };
}

function applyDiffSet(firstRunUnits: WorkUnit[], diffSet: DiffSet): ChunkResult {
  const touched = new Set([...diffSet.added, ...diffSet.modified]);
  const workUnits = firstRunUnits.filter((wu) => {
    const readablePaths = [...wu.rawFiles, ...wu.dependencyPaths];
    return readablePaths.some((path) => touched.has(path));
  });
  return { workUnits };
}

function addIfPresent(project: LoadedLookerProject, deps: Set<string>, path: string): void {
  if (project.allPaths.includes(path)) {
    deps.add(path);
  }
}

function addExploreDependency(project: LoadedLookerProject, deps: Set<string>, query: StagedLookerQuery | null): void {
  if (!query) {
    return;
  }
  addIfPresent(project, deps, explorePath(query.model, query.view));
}

function evidencePathsForExplore(project: LoadedLookerProject, modelName: string, exploreName: string): string[] {
  return existingPaths(project, [
    `evidence/explores/${modelName}/${exploreName}/metadata.json`,
    `evidence/explores/${modelName}/${exploreName}/page.md`,
  ]);
}

function evidencePathsForDashboard(project: LoadedLookerProject, dashboardId: string): string[] {
  return existingPaths(project, [
    `evidence/dashboards/${dashboardId}/metadata.json`,
    `evidence/dashboards/${dashboardId}/page.md`,
  ]);
}

function evidencePathsForLook(project: LoadedLookerProject, lookId: string): string[] {
  return existingPaths(project, [`evidence/looks/${lookId}/metadata.json`, `evidence/looks/${lookId}/page.md`]);
}

function existingPaths(project: LoadedLookerProject, paths: string[]): string[] {
  return paths.filter((path) => project.allPaths.includes(path));
}

function explorePath(modelName: string, exploreName: string): string {
  return `explores/${modelName}/${exploreName}.json`;
}
