import type { ChunkResult, DiffSet, WorkUnit } from '../../types.js';
import { buildMetricFlowGraph, type MetricFlowComponent, type MetricFlowGraph } from './graph.js';
import type { ParsedMetricFlowProject } from './parse.js';

interface ChunkOptions {
  diffSet?: DiffSet;
}

/**
 * Emit WorkUnits for a parsed MetricFlow project.
 *
 *   First run (no diffSet): one WU per connected component. rawFiles = all component
 *                           paths, peerFileIndex = everything else in `allPaths`.
 *
 *   Re-sync (diffSet provided): filter to components whose paths intersect added∪modified.
 *                               Move unchanged component paths from rawFiles into
 *                               dependencyPaths (the WU agent still reads them for
 *                               inheritance context, but they're not "changed"). Emit a
 *                               single EvictionUnit for diffSet.deleted.
 */
export function chunkMetricFlowProject(project: ParsedMetricFlowProject, opts: ChunkOptions = {}): ChunkResult {
  const graph = buildMetricFlowGraph(project);
  const firstRunUnits = emitFirstRunWorkUnits(project, graph);
  if (!opts.diffSet) {
    return { workUnits: firstRunUnits };
  }
  return applyDiffSet(firstRunUnits, graph, opts.diffSet);
}

function describeComponent(c: MetricFlowComponent): string {
  const parts: string[] = [];
  if (c.semanticModelNames.length > 0) {
    parts.push(`semantic_models: ${c.semanticModelNames.join(', ')}`);
  }
  if (c.metricNames.length > 0) {
    parts.push(`metrics: ${c.metricNames.join(', ')}`);
  }
  return parts.length > 0 ? `MetricFlow component (${parts.join('; ')})` : 'MetricFlow component (empty)';
}

function emitFirstRunWorkUnits(project: ParsedMetricFlowProject, graph: MetricFlowGraph): WorkUnit[] {
  const participatingPaths = new Set(graph.components.flatMap((c) => c.paths));
  const nonParticipatingPaths = project.allPaths.filter((p) => !participatingPaths.has(p)).sort();
  const allParticipatingSorted = [...participatingPaths].sort();

  return graph.components.map((component): WorkUnit => {
    const rawFiles = [...component.paths].sort();
    const rawFilesSet = new Set(rawFiles);
    const peerFileIndex = [
      ...allParticipatingSorted.filter((p) => !rawFilesSet.has(p)),
      ...nonParticipatingPaths,
    ].sort();
    return {
      unitKey: `metricflow-${component.leadName}`,
      displayLabel: `MetricFlow "${component.leadName}"`,
      rawFiles,
      peerFileIndex,
      dependencyPaths: [],
      notes: describeComponent(component),
    };
  });
}

function applyDiffSet(firstRunUnits: WorkUnit[], graph: MetricFlowGraph, diffSet: DiffSet): ChunkResult {
  const touched = new Set([...diffSet.added, ...diffSet.modified]);
  const kept: WorkUnit[] = [];

  for (const wu of firstRunUnits) {
    const anyTouched = wu.rawFiles.some((p) => touched.has(p));
    if (!anyTouched) {
      continue;
    }
    const changedFiles: string[] = [];
    const unchangedComponentFiles: string[] = [];
    for (const p of wu.rawFiles) {
      if (touched.has(p)) {
        changedFiles.push(p);
      } else {
        unchangedComponentFiles.push(p);
      }
    }
    const combinedDeps = new Set<string>([...wu.dependencyPaths, ...unchangedComponentFiles]);
    kept.push({
      ...wu,
      rawFiles: changedFiles.sort(),
      dependencyPaths: [...combinedDeps].sort(),
    });
  }

  void graph; // reserved for future widening (e.g. cross-component ancestor paths)
  const eviction = diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted].sort() } : undefined;
  return { workUnits: kept, eviction };
}
