import type { ChunkResult, DiffSet, WorkUnit } from '../../types.js';
import { buildLookmlGraph, type LookmlGraph } from './graph.js';
import type { ParsedLookmlProject } from './parse.js';

interface ChunkOptions {
  diffSet?: DiffSet;
  mismatchedModelNames?: Set<string>;
}

function lookmlSlDisallowedNotes(modelName: string, existingNotes: string): string {
  return [
    '[LOOKML SL WRITES DISALLOWED]',
    'reason: lookml_connection_mismatch',
    `model: ${modelName}`,
    'Do not call sl_write_source or sl_edit_source for this WorkUnit.',
    'Continue wiki extraction and context candidates from the raw LookML files.',
    '[/LOOKML SL WRITES DISALLOWED]',
    '',
    existingNotes,
  ].join('\n');
}

/**
 * Emit WorkUnits for a parsed LookML project.
 *
 *   First run (no diffSet): one WU per model + `lookml-orphans` (if any non-owned views)
 *                           + `lookml-dashboard-<name>` per dashboard file.
 *
 *   Re-sync (diffSet provided): filter to WUs whose rawFiles intersect added∪modified;
 *                               widen dependencyPaths with every file in `allPaths`
 *                               that's upstream of the WU's changed files via the graph.
 *                               Emit a single EvictionUnit for diffSet.deleted.
 */
export function chunkLookmlProject(project: ParsedLookmlProject, opts: ChunkOptions = {}): ChunkResult {
  const graph = buildLookmlGraph(project);
  const firstRunUnits = emitFirstRunWorkUnits(project, graph, opts);
  if (!opts.diffSet) {
    return { workUnits: firstRunUnits };
  }
  return applyDiffSet(firstRunUnits, project, graph, opts.diffSet);
}

function emitFirstRunWorkUnits(project: ParsedLookmlProject, graph: LookmlGraph, opts: ChunkOptions): WorkUnit[] {
  const allModelPaths = [...new Set(project.models.map((m) => m.path))].sort();
  const allDashboardPaths = [...new Set(project.dashboards.map((d) => d.path))].sort();
  // Dedupe: a .view.lkml with multiple `view:` blocks produces multiple ParsedLookmlView
  // entries sharing one path.
  const allViewPaths = [...new Set(project.views.map((v) => v.path))].sort();

  const workUnits: WorkUnit[] = [];

  // Per-model WU, sorted by model name for determinism.
  const sortedModels = [...project.models].sort((a, b) => a.name.localeCompare(b.name));

  for (const model of sortedModels) {
    const includedViewPaths = (graph.viewsIncludedByModel.get(model.name) ?? []).filter((p) =>
      allViewPaths.includes(p),
    );
    // Views the model includes and which this model ALSO owns (first-includer-wins).
    const ownedViewPaths = includedViewPaths.filter((p) => graph.ownerByViewPath.get(p) === model.name);
    // Views the model includes but that another lexicographically-earlier model owns.
    // These land in dependencyPaths so this WU's agent can READ them, but the "canonical
    // write" for those views happens in the owner's WU.
    const nonOwnedDepViewPaths = includedViewPaths.filter((p) => graph.ownerByViewPath.get(p) !== model.name).sort();

    const rawFiles = [model.path, ...ownedViewPaths].sort();
    const peerFileIndex = [
      ...allModelPaths.filter((p) => p !== model.path),
      ...allViewPaths.filter((p) => !rawFiles.includes(p) && !nonOwnedDepViewPaths.includes(p)),
      ...allDashboardPaths,
    ].sort();

    const isMismatched = opts.mismatchedModelNames?.has(model.name) ?? false;
    const notes =
      model.explores.length > 0
        ? `LookML model "${model.name}" (explores: ${model.explores.join(', ')})`
        : `LookML model "${model.name}"`;

    workUnits.push({
      unitKey: `lookml-${model.name}`,
      displayLabel: `LookML model "${model.name}"`,
      rawFiles,
      peerFileIndex,
      dependencyPaths: nonOwnedDepViewPaths,
      notes: isMismatched ? lookmlSlDisallowedNotes(model.name, notes) : notes,
      slDisallowed: isMismatched ? true : undefined,
      slDisallowedReason: isMismatched ? 'lookml_connection_mismatch' : undefined,
    });
  }

  // Orphan view WU — views that no model includes. Skip entirely if none.
  const orphanViewPaths = allViewPaths.filter((p) => !graph.ownerByViewPath.has(p)).sort();
  if (orphanViewPaths.length > 0) {
    workUnits.push({
      unitKey: 'lookml-orphans',
      displayLabel: 'LookML orphan views',
      rawFiles: orphanViewPaths,
      peerFileIndex: [...allModelPaths, ...allDashboardPaths].sort(),
      dependencyPaths: [],
      notes: 'Views not referenced by any .model.lkml (orphaned)',
    });
  }

  // One WU per dashboard file.
  for (const dashboard of [...project.dashboards].sort((a, b) => a.name.localeCompare(b.name))) {
    workUnits.push({
      unitKey: `lookml-dashboard-${dashboard.name}`,
      displayLabel: `LookML dashboard "${dashboard.name}"`,
      rawFiles: [dashboard.path],
      peerFileIndex: [...allModelPaths, ...allViewPaths].sort(),
      dependencyPaths: [],
      notes: `LookML dashboard "${dashboard.name}"`,
    });
  }

  return workUnits;
}

function applyDiffSet(
  firstRunUnits: WorkUnit[],
  _project: ParsedLookmlProject,
  graph: LookmlGraph,
  diffSet: DiffSet,
): ChunkResult {
  const touched = new Set([...diffSet.added, ...diffSet.modified]);
  const keptUnits: WorkUnit[] = [];

  for (const wu of firstRunUnits) {
    const anyTouched = wu.rawFiles.some((p) => touched.has(p));
    if (!anyTouched) {
      continue;
    }

    // Widen dependencyPaths: for every view in rawFiles, add paths of all transitive
    // extends ancestors (if known in the graph) that aren't already in rawFiles.
    const existingDeps = new Set(wu.dependencyPaths);
    for (const rawPath of wu.rawFiles) {
      const viewNames = graph.viewNamesByPath.get(rawPath) ?? [];
      for (const viewName of viewNames) {
        const ancestors = graph.extendsAncestorsByViewName.get(viewName) ?? [];
        for (const ancestorName of ancestors) {
          const ancestorPaths = graph.pathsByViewName.get(ancestorName) ?? [];
          for (const ancestorPath of ancestorPaths) {
            if (!wu.rawFiles.includes(ancestorPath)) {
              existingDeps.add(ancestorPath);
            }
          }
        }
      }
    }
    keptUnits.push({
      ...wu,
      dependencyPaths: [...existingDeps].sort(),
    });
  }

  const eviction = diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted].sort() } : undefined;
  return { workUnits: keptUnits, eviction };
}
