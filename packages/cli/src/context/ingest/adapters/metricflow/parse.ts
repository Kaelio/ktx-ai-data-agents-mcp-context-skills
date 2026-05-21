import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ParsedMetricFlowSemanticModel {
  /** Path relative to stagedDir, e.g. "models/orders.yml". */
  path: string;
  /** `name:` on the semantic_model. */
  name: string;
  /** Best-effort ref name: `ref('x')` → 'x'; `source('s','t')` → 't'; literal → literal. */
  modelRef: string;
  /**
   * `extends:` parents declared on this semantic_model. MetricFlow does not ship
   * `extends:` as a first-class field; this adapter treats any `extends:` that
   * appears as a hint from the author that one model inherits from another.
   * Empty if absent.
   */
  extendsFrom: string[];
  measureNames: string[];
  dimensionNames: string[];
  entityNames: string[];
  primaryEntities: string[];
  foreignEntities: string[];
  defaultTimeDimension: string | null;
}

export type MetricFlowMetricType = 'simple' | 'derived' | 'cumulative' | 'ratio' | 'conversion';

export interface ParsedMetricFlowMetric {
  path: string;
  name: string;
  type: MetricFlowMetricType;
  /** For `simple` + `cumulative`. `null` for `derived`/`ratio`/`conversion`. */
  measureRef: string | null;
  /** For `derived`/`ratio`/`conversion`: the metric names this metric depends on. */
  dependsOn: string[];
}

export interface ParsedMetricFlowProject {
  semanticModels: ParsedMetricFlowSemanticModel[];
  metrics: ParsedMetricFlowMetric[];
  /** All `.yml`/`.yaml` paths seen under stagedDir, relative + sorted. */
  allPaths: string[];
  files: Array<{ path: string; content: string }>;
}

const YAML_EXT_RE = /\.(ya?ml)$/i;

async function collectYamlFiles(stagedDir: string): Promise<string[]> {
  const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !YAML_EXT_RE.test(entry.name)) {
      continue;
    }
    const abs = join(entry.parentPath, entry.name);
    paths.push(relative(stagedDir, abs));
  }
  paths.sort();
  return paths;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [];
}

/** Extract `ref('x')` / `source('s','t')` / literal from a MetricFlow `model:` field. */
function extractModelRef(modelStr: string): string {
  const refMatch = modelStr.match(/ref\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (refMatch) {
    return refMatch[1];
  }
  const sourceMatch = modelStr.match(/source\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
  if (sourceMatch) {
    return sourceMatch[1];
  }
  return modelStr;
}

interface RawSemanticModel {
  name?: unknown;
  model?: unknown;
  extends?: unknown;
  entities?: Array<{ name?: unknown; type?: unknown }>;
  dimensions?: Array<{ name?: unknown }>;
  measures?: Array<{ name?: unknown }>;
  defaults?: { agg_time_dimension?: unknown };
}

interface RawMetric {
  name?: unknown;
  type?: unknown;
  type_params?: {
    measure?: unknown;
    metrics?: Array<{ name?: unknown }>;
    numerator?: unknown;
    denominator?: unknown;
    conversion_type_params?: {
      base_measure?: unknown;
      conversion_measure?: unknown;
    };
  };
}

interface RawYaml {
  semantic_models?: RawSemanticModel[];
  metrics?: RawMetric[];
}

function extractMeasureFromInput(input: unknown): string | null {
  if (typeof input === 'string') {
    return input;
  }
  if (input && typeof input === 'object' && 'name' in input && typeof (input as { name: unknown }).name === 'string') {
    return (input as { name: string }).name;
  }
  return null;
}

function extractReferencedMetricNames(m: RawMetric): string[] {
  const tp = m.type_params ?? {};
  const names: string[] = [];
  for (const ref of tp.metrics ?? []) {
    if (ref && typeof ref.name === 'string') {
      names.push(ref.name);
    }
  }
  const num = extractMeasureFromInput(tp.numerator);
  const den = extractMeasureFromInput(tp.denominator);
  if (num) {
    names.push(num);
  }
  if (den) {
    names.push(den);
  }
  return [...new Set(names)].sort();
}

function parseSemanticModel(sm: RawSemanticModel, path: string): ParsedMetricFlowSemanticModel | null {
  if (typeof sm.name !== 'string') {
    return null;
  }
  const entities = (sm.entities ?? []).filter((e) => e && typeof e.name === 'string') as Array<{
    name: string;
    type?: unknown;
  }>;
  const primaryEntities = entities
    .filter((e) => e.type === 'primary' || e.type === 'unique')
    .map((e) => e.name)
    .sort();
  const foreignEntities = entities
    .filter((e) => e.type === 'foreign')
    .map((e) => e.name)
    .sort();
  const entityNames = entities.map((e) => e.name).sort();
  const measureNames = ((sm.measures ?? []).filter((m) => m && typeof m.name === 'string') as Array<{ name: string }>)
    .map((m) => m.name)
    .sort();
  const dimensionNames = (
    (sm.dimensions ?? []).filter((d) => d && typeof d.name === 'string') as Array<{ name: string }>
  )
    .map((d) => d.name)
    .sort();
  const modelRef = typeof sm.model === 'string' ? extractModelRef(sm.model) : '';
  const extendsFrom = asStringArray(sm.extends);
  const defaultTimeDimension =
    typeof sm.defaults?.agg_time_dimension === 'string' ? sm.defaults.agg_time_dimension : null;

  return {
    path,
    name: sm.name,
    modelRef,
    extendsFrom,
    measureNames,
    dimensionNames,
    entityNames,
    primaryEntities,
    foreignEntities,
    defaultTimeDimension,
  };
}

function parseMetric(m: RawMetric, path: string): ParsedMetricFlowMetric | null {
  if (typeof m.name !== 'string') {
    return null;
  }
  const typeStr = typeof m.type === 'string' ? m.type : '';
  const ALLOWED: MetricFlowMetricType[] = ['simple', 'derived', 'cumulative', 'ratio', 'conversion'];
  if (!ALLOWED.includes(typeStr as MetricFlowMetricType)) {
    return null;
  }
  const type = typeStr as MetricFlowMetricType;
  const measureRef =
    type === 'simple' || type === 'cumulative' ? extractMeasureFromInput(m.type_params?.measure) : null;
  const dependsOn = extractReferencedMetricNames(m);
  return { path, name: m.name, type, measureRef, dependsOn };
}

export async function parseMetricFlowStagedDir(stagedDir: string): Promise<ParsedMetricFlowProject> {
  const allPaths = await collectYamlFiles(stagedDir);
  const semanticModels: ParsedMetricFlowSemanticModel[] = [];
  const metrics: ParsedMetricFlowMetric[] = [];
  const files: Array<{ path: string; content: string }> = [];

  for (const path of allPaths) {
    const body = await readFile(join(stagedDir, path), 'utf-8');
    files.push({ path, content: body });
    let yaml: RawYaml | null;
    try {
      yaml = parseYaml(body) as RawYaml | null;
    } catch {
      yaml = null;
    }
    if (!yaml || typeof yaml !== 'object') {
      continue;
    }
    for (const sm of yaml.semantic_models ?? []) {
      const parsed = parseSemanticModel(sm, path);
      if (parsed) {
        semanticModels.push(parsed);
      }
    }
    for (const m of yaml.metrics ?? []) {
      const parsed = parseMetric(m, path);
      if (parsed) {
        metrics.push(parsed);
      }
    }
  }

  semanticModels.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  metrics.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

  return { semanticModels, metrics, allPaths, files };
}
