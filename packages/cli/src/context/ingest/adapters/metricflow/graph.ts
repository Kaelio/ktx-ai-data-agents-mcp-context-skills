import type { ParsedMetricFlowProject } from './parse.js';

export interface MetricFlowComponent {
  /** Stable integer id, assigned in lexicographic order of `leadName`. */
  id: number;
  /** Sorted list of relative paths making up this component. */
  paths: string[];
  /** Sorted list of semantic_model names in this component. Empty for metric-only components. */
  semanticModelNames: string[];
  /** Sorted list of metric names whose defining file is in this component. */
  metricNames: string[];
  /** Lexicographically-first semantic_model name, or first metric name if none. Drives unitKey. */
  leadName: string;
}

export interface MetricFlowGraph {
  components: MetricFlowComponent[];
  /** Map semantic_model name → containing component id. */
  componentByModelName: Map<string, number>;
  /** Map relative path → containing component id. */
  componentByPath: Map<string, number>;
  /** Map semantic_model name → its declaring path. */
  pathByModelName: Map<string, string>;
  /** Map semantic_model name → sorted transitive extends ancestor names (used for dependency widening in re-sync). */
  extendsAncestorsByModelName: Map<string, string[]>;
}

class UnionFind<T> {
  private readonly parent = new Map<T, T>();

  add(item: T): void {
    if (!this.parent.has(item)) {
      this.parent.set(item, item);
    }
  }

  find(item: T): T {
    this.add(item);
    let root = item;
    while (this.parent.get(root) !== root) {
      const next = this.parent.get(root);
      if (next === undefined) {
        throw new Error('union-find parent missing during root traversal');
      }
      root = next;
    }
    // Path compression — walk again, point each to root.
    let cursor = item;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      if (next === undefined) {
        throw new Error('union-find parent missing during path compression');
      }
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: T, b: T): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      this.parent.set(ra, rb);
    }
  }

  roots(): T[] {
    return [...this.parent.keys()].filter((k) => this.find(k) === k);
  }
}

function transitiveAncestors(modelName: string, direct: Map<string, string[]>, visited = new Set<string>()): string[] {
  if (visited.has(modelName)) {
    return [];
  }
  visited.add(modelName);
  const parents = direct.get(modelName) ?? [];
  const out = new Set<string>();
  for (const parent of parents) {
    out.add(parent);
    for (const a of transitiveAncestors(parent, direct, visited)) {
      out.add(a);
    }
  }
  return [...out].sort();
}

export function buildMetricFlowGraph(project: ParsedMetricFlowProject): MetricFlowGraph {
  // Index: semantic_model name → path, measure_name → semantic_model_path.
  const pathByModelName = new Map<string, string>();
  const semanticModelPathToName = new Map<string, string>();
  const measureOwnerPath = new Map<string, string>();
  for (const sm of project.semanticModels) {
    pathByModelName.set(sm.name, sm.path);
    semanticModelPathToName.set(sm.path, sm.name);
    for (const mName of sm.measureNames) {
      if (!measureOwnerPath.has(mName)) {
        measureOwnerPath.set(mName, sm.path);
      }
    }
  }

  // Union-find keyed by relative path. Every path that carries at least one semantic_model
  // or at least one metric enters the structure; other YAMLs (e.g. `dbt_project.yml`) are
  // ignored.
  const uf = new UnionFind<string>();
  const participatingPaths = new Set<string>();
  for (const sm of project.semanticModels) {
    uf.add(sm.path);
    participatingPaths.add(sm.path);
  }
  for (const m of project.metrics) {
    uf.add(m.path);
    participatingPaths.add(m.path);
  }

  // (a) extends: unions.
  for (const sm of project.semanticModels) {
    for (const parent of sm.extendsFrom) {
      const parentPath = pathByModelName.get(parent);
      if (parentPath) {
        uf.union(sm.path, parentPath);
      }
    }
  }

  // (b) metric → measure reference unions. For simple/cumulative, union metric file with
  // the owner semantic_model file of the referenced measure. For derived/ratio/conversion,
  // each referenced metric name ultimately resolves to a measure; we look it up directly
  // in the measure index. When a metric's dependsOn item is itself a metric name (derived),
  // we don't try to chase the chain — the transitive union still happens because the chained
  // metric's own file will also get unioned to the underlying measure's owner.
  for (const m of project.metrics) {
    const candidates: string[] = [];
    if (m.measureRef) {
      candidates.push(m.measureRef);
    }
    candidates.push(...m.dependsOn);
    for (const name of candidates) {
      const ownerPath = measureOwnerPath.get(name);
      if (ownerPath) {
        uf.union(m.path, ownerPath);
      }
    }
  }

  // Group participating paths by root.
  const groups = new Map<string, string[]>();
  for (const path of participatingPaths) {
    const root = uf.find(path);
    const list = groups.get(root) ?? [];
    list.push(path);
    groups.set(root, list);
  }

  // Build component records.
  const components: MetricFlowComponent[] = [];
  const componentByPath = new Map<string, number>();
  const componentByModelName = new Map<string, number>();

  // Compute leadName for each raw group before assigning ids so ordering is stable.
  const rawComponents = [...groups.values()].map((paths) => {
    const sortedPaths = [...paths].sort();
    const smNames = sortedPaths
      .map((p) => semanticModelPathToName.get(p))
      .filter((n): n is string => typeof n === 'string')
      .sort();
    const metricNames = project.metrics
      .filter((m) => sortedPaths.includes(m.path))
      .map((m) => m.name)
      .sort();
    const leadName = smNames[0] ?? metricNames[0] ?? sortedPaths[0];
    return { paths: sortedPaths, semanticModelNames: smNames, metricNames, leadName };
  });
  rawComponents.sort((a, b) => a.leadName.localeCompare(b.leadName));

  rawComponents.forEach((rc, id) => {
    components.push({ id, ...rc });
    for (const path of rc.paths) {
      componentByPath.set(path, id);
    }
    for (const name of rc.semanticModelNames) {
      componentByModelName.set(name, id);
    }
  });

  // Extends ancestor index (used by DiffSet widening).
  const directExtends = new Map<string, string[]>();
  for (const sm of project.semanticModels) {
    directExtends.set(sm.name, [...sm.extendsFrom].sort());
  }
  const extendsAncestorsByModelName = new Map<string, string[]>();
  for (const sm of project.semanticModels) {
    extendsAncestorsByModelName.set(sm.name, transitiveAncestors(sm.name, directExtends));
  }

  return {
    components,
    componentByModelName,
    componentByPath,
    pathByModelName,
    extendsAncestorsByModelName,
  };
}
