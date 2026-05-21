import { minimatch } from 'minimatch';
import type { ParsedLookmlProject } from './parse.js';

export interface LookmlGraph {
  /** For each model name, every view path that model's `include:` directives resolve to. NOT filtered by ownership. */
  viewsIncludedByModel: Map<string, string[]>;
  /** For each view path, the owning model name (lexicographically-first includer). Absent when no model includes it. */
  ownerByViewPath: Map<string, string>;
  /** For each view path, every model name that included it (not only the owner). */
  includersByViewPath: Map<string, string[]>;
  /** For each view NAME (not path), the transitive `extends:` ancestor NAMES. */
  extendsAncestorsByViewName: Map<string, string[]>;
  /** Quick lookup: view name → file path. Multiple paths possible if a view is defined in multiple files. */
  pathsByViewName: Map<string, string[]>;
  /** Quick lookup: view path → view names declared in that file. */
  viewNamesByPath: Map<string, string[]>;
}

/**
 * Resolve a single include pattern (relative to stagedDir, may be a glob) against the
 * project's full file list. Returns the subset of `allPaths` that match.
 *
 * LookML `include:` uses a file-relative pattern with `*` matching one path segment and
 * `**` matching multiple. `minimatch` gives us exactly this.
 */
function resolveIncludePattern(pattern: string, allPaths: string[]): string[] {
  return allPaths.filter((p) => minimatch(p, pattern, { nocase: false })).sort();
}

function transitiveAncestors(
  viewName: string,
  directExtends: Map<string, string[]>,
  visited = new Set<string>(),
): string[] {
  if (visited.has(viewName)) {
    return [];
  }
  visited.add(viewName);
  const direct = directExtends.get(viewName) ?? [];
  const out = new Set<string>();
  for (const parent of direct) {
    out.add(parent);
    for (const ancestor of transitiveAncestors(parent, directExtends, visited)) {
      out.add(ancestor);
    }
  }
  return [...out].sort();
}

export function buildLookmlGraph(project: ParsedLookmlProject): LookmlGraph {
  const viewsIncludedByModel = new Map<string, string[]>();
  const ownerByViewPath = new Map<string, string>();
  const includersByViewPath = new Map<string, string[]>();

  // Iterate models in lexicographic-name order so the first-includer-wins rule produces
  // deterministic ownership.
  const sortedModels = [...project.models].sort((a, b) => a.name.localeCompare(b.name));

  for (const model of sortedModels) {
    const includedPaths = new Set<string>();
    for (const pattern of model.includes) {
      for (const match of resolveIncludePattern(pattern, project.allPaths)) {
        includedPaths.add(match);
      }
    }
    const sortedPaths = [...includedPaths].sort();
    viewsIncludedByModel.set(model.name, sortedPaths);

    for (const viewPath of sortedPaths) {
      const inc = includersByViewPath.get(viewPath) ?? [];
      inc.push(model.name);
      includersByViewPath.set(viewPath, inc);
      if (!ownerByViewPath.has(viewPath)) {
        ownerByViewPath.set(viewPath, model.name);
      }
    }
  }

  // Deduplicate + sort includers lists for deterministic output.
  for (const [path, names] of includersByViewPath) {
    includersByViewPath.set(path, [...new Set(names)].sort());
  }

  // Build extends graph over view NAMES.
  const directExtendsByViewName = new Map<string, string[]>();
  const pathsByViewName = new Map<string, string[]>();
  const viewNamesByPath = new Map<string, string[]>();
  for (const view of project.views) {
    directExtendsByViewName.set(view.name, view.extendsFrom);
    const paths = pathsByViewName.get(view.name) ?? [];
    if (!paths.includes(view.path)) {
      paths.push(view.path);
    }
    pathsByViewName.set(view.name, paths.sort());
    const names = viewNamesByPath.get(view.path) ?? [];
    if (!names.includes(view.name)) {
      names.push(view.name);
    }
    viewNamesByPath.set(view.path, names.sort());
  }
  const extendsAncestorsByViewName = new Map<string, string[]>();
  for (const view of project.views) {
    extendsAncestorsByViewName.set(view.name, transitiveAncestors(view.name, directExtendsByViewName));
  }

  return {
    viewsIncludedByModel,
    ownerByViewPath,
    includersByViewPath,
    extendsAncestorsByViewName,
    pathsByViewName,
    viewNamesByPath,
  };
}
