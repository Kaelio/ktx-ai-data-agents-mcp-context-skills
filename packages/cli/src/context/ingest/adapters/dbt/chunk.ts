import type { ChunkResult, DiffSet, WorkUnit } from '../../types.js';
import type { ParsedDbtProject } from './parse.js';

interface ChunkOptions {
  diffSet?: DiffSet;
}

/**
 * Per-model work units (when the project has more than 25 YAML files) only name `rawFiles` under
 * `models/**`. Other `.yml` (e.g. some `seeds/` or custom layouts) still appear in `peerFileIndex`
 * or in the small-project / no-models fallbacks — v1 does not emit one WU per non-models file.
 */
const MODELS_PREFIX = 'models/';

/** `peerFileIndex` is a hint only (agents may not read those paths). Cap to limit prompt size. */
const MAX_PEER_FILE_INDEX = 200;

function projectYamlPath(allPaths: string[]): string | undefined {
  if (allPaths.includes('dbt_project.yml')) {
    return 'dbt_project.yml';
  }
  if (allPaths.includes('dbt_project.yaml')) {
    return 'dbt_project.yaml';
  }
  return undefined;
}

function modelRelativePaths(allPaths: string[]): string[] {
  return allPaths.filter((p) => p.replace(/\\/g, '/').startsWith(MODELS_PREFIX)).sort();
}

function unitKeyForModelFile(mf: string): string {
  const base = mf
    .replace(/\.(ya?ml)$/i, '')
    .replace(/\\/g, '/')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `dbt-${base.toLowerCase()}`;
}

function emitFirstRunWorkUnits(allPaths: string[], dbtDep: string | undefined): WorkUnit[] {
  if (allPaths.length === 0) {
    return [];
  }

  if (allPaths.length <= 25) {
    return [
      {
        unitKey: 'dbt-all',
        displayLabel: 'dbt project (all yaml)',
        rawFiles: [...allPaths],
        peerFileIndex: [],
        dependencyPaths: [],
        notes: 'dbt project — all YAML in one WorkUnit (≤25 files)',
      },
    ];
  }

  const modelFiles = modelRelativePaths(allPaths);
  if (modelFiles.length === 0) {
    return [
      {
        unitKey: 'dbt-all',
        displayLabel: 'dbt project (all yaml, no models/**)',
        rawFiles: [...allPaths],
        peerFileIndex: [],
        dependencyPaths: dbtDep ? [dbtDep] : [],
        notes: 'dbt: no models/**/*.yml — single slice with dbt_project as dependency if present',
      },
    ];
  }

  return modelFiles.map((mf) => {
    const allPeers = allPaths.filter((p) => p !== mf).sort();
    const truncated = allPeers.length > MAX_PEER_FILE_INDEX;
    const peerFileIndex = truncated ? allPeers.slice(0, MAX_PEER_FILE_INDEX) : allPeers;
    const dependencyPaths = dbtDep && allPaths.includes(dbtDep) && mf !== dbtDep ? [dbtDep].sort() : [];
    const notes = truncated
      ? `dbt model schema slice (peer index capped at ${MAX_PEER_FILE_INDEX} of ${allPeers.length} paths)`
      : 'dbt model schema slice';
    return {
      unitKey: unitKeyForModelFile(mf),
      displayLabel: `dbt ${mf}`,
      rawFiles: [mf],
      peerFileIndex,
      dependencyPaths: dependencyPaths,
      notes,
    };
  });
}

function applyDiffSet(firstRunUnits: WorkUnit[], diffSet: DiffSet): ChunkResult {
  const touched = new Set([...diffSet.added, ...diffSet.modified]);
  const kept: WorkUnit[] = [];

  for (const wu of firstRunUnits) {
    const touchedRawFiles = wu.rawFiles.filter((p) => touched.has(p));
    const touchedDependencies = wu.dependencyPaths.filter((p) => touched.has(p));
    const touchedPeerFiles = wu.peerFileIndex.filter((p) => touched.has(p));
    if (touchedRawFiles.length === 0 && touchedDependencies.length === 0 && touchedPeerFiles.length === 0) {
      continue;
    }

    const rawFiles = touchedRawFiles.length > 0 ? touchedRawFiles : wu.rawFiles;
    const unchangedRaw = touchedRawFiles.length > 0 ? wu.rawFiles.filter((p) => !touched.has(p)) : [];
    for (const p of wu.rawFiles) {
      if (!rawFiles.includes(p) && !unchangedRaw.includes(p)) {
        unchangedRaw.push(p);
      }
    }
    const combinedDeps = new Set<string>([...wu.dependencyPaths, ...unchangedRaw, ...touchedPeerFiles]);
    kept.push({
      ...wu,
      rawFiles: rawFiles.sort(),
      dependencyPaths: [...combinedDeps].sort(),
    });
  }

  const eviction = diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted].sort() } : undefined;
  return { workUnits: kept, eviction };
}

export function chunkDbtProject(project: ParsedDbtProject, opts: ChunkOptions = {}): ChunkResult {
  const dbtDep = projectYamlPath(project.allPaths);
  const firstRun = emitFirstRunWorkUnits(project.allPaths, dbtDep);
  if (!opts.diffSet) {
    return { workUnits: firstRun };
  }
  return applyDiffSet(firstRun, opts.diffSet);
}
