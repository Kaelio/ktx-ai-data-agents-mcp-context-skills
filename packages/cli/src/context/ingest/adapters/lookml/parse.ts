import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import lookmlParser, { type LookmlParseNode, type LookmlProjectByType } from 'lookml-parser';

interface ParsedLookmlModel {
  /** Path relative to stagedDir, e.g. "orders.model.lkml". */
  path: string;
  /** Model name — the file's basename minus ".model.lkml". */
  name: string;
  /** `include:` entries (glob strings). Relative to stagedDir. */
  includes: string[];
  /** Explore names declared in the model. Order is source-order. */
  explores: string[];
  connectionName: string | null;
}

interface ParsedLookmlView {
  /** Path relative to stagedDir. */
  path: string;
  /** The `view:` name (the identifier on the `view:` block, not the file name). */
  name: string;
  /** `extends:` ancestors declared on this view. Empty if none. */
  extendsFrom: string[];
  rawSqlTableName: string | null;
}

interface ParsedLookmlDashboard {
  /** Path relative to stagedDir. */
  path: string;
  /** Best-effort dashboard name: the filename minus ".dashboard.lkml". */
  name: string;
}

export interface ParsedLookmlProject {
  models: ParsedLookmlModel[];
  views: ParsedLookmlView[];
  dashboards: ParsedLookmlDashboard[];
  /** All .lkml paths the adapter saw (relative to stagedDir), sorted. */
  allPaths: string[];
}

const LKML_EXT_RE = /\.(lkml|lookml)$/i;
const MODEL_FILE_RE = /\.model\.(lkml|lookml)$/i;
const VIEW_FILE_RE = /\.view\.(lkml|lookml)$/i;
const DASHBOARD_FILE_RE = /\.dashboard\.(lkml|lookml)$/i;

async function collectLkmlFiles(stagedDir: string): Promise<string[]> {
  const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !LKML_EXT_RE.test(entry.name)) {
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

function firstString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function extractViewExtendsFromNode(viewNode: LookmlParseNode): string[] {
  // lookml-parser normalizes `extends: [a, b]` into `extends__all`, and single-value
  // `extends: x` into `extends`. We accept both.
  const node = viewNode as Record<string, unknown>;
  const allSource = node.extends__all;
  if (Array.isArray(allSource)) {
    const flat: string[] = [];
    for (const item of allSource) {
      if (Array.isArray(item)) {
        for (const inner of item) {
          if (typeof inner === 'string') {
            flat.push(inner);
          }
        }
      } else if (typeof item === 'string') {
        flat.push(item);
      }
    }
    if (flat.length > 0) {
      return flat;
    }
  }
  return asStringArray(node.extends);
}

function nameFromPath(path: string, ext: RegExp): string {
  const basename = path.split('/').pop() ?? path;
  return basename.replace(ext, '');
}

/**
 * `project.file` is keyed as `file[type][name]` (e.g. `file.view.customers`) rather
 * than by raw path. Look up the node for a given path by matching `$file_path`.
 */
function findFileNode(project: LookmlProjectByType, path: string): LookmlParseNode | undefined {
  const fileByType = project.file;
  if (!fileByType) {
    return undefined;
  }
  for (const typeBucket of Object.values(fileByType)) {
    if (!typeBucket || typeof typeBucket !== 'object') {
      continue;
    }
    for (const node of Object.values(typeBucket as Record<string, LookmlParseNode>)) {
      if ((node as Record<string, unknown>).$file_path === path) {
        return node;
      }
    }
  }
  return undefined;
}

export async function parseLookmlStagedDir(stagedDir: string): Promise<ParsedLookmlProject> {
  const allPaths = await collectLkmlFiles(stagedDir);

  const modelPaths = allPaths.filter((p) => MODEL_FILE_RE.test(p));
  const viewPaths = allPaths.filter((p) => VIEW_FILE_RE.test(p));
  const dashboardPaths = allPaths.filter((p) => DASHBOARD_FILE_RE.test(p));

  const parsableFiles = await Promise.all(
    [...modelPaths, ...viewPaths].map(async (p) => ({
      path: p,
      content: await readFile(join(stagedDir, p), 'utf-8'),
    })),
  );

  let project: LookmlProjectByType = {};
  if (parsableFiles.length > 0) {
    project = await lookmlParser.parseFiles<LookmlProjectByType>({
      source: parsableFiles,
      fileOutput: 'by-type',
      // Silence the parser's default console warnings — unreadable in test output.
      console: { log: () => {}, warn: () => {}, error: () => {} },
    });
  }

  const models: ParsedLookmlModel[] = modelPaths.map((path) => {
    const name = nameFromPath(path, /\.model\.(lkml|lookml)$/i);
    const modelNode = (project.model?.[name] ?? {}) as Record<string, unknown>;
    const includes = asStringArray(modelNode.include).concat(asStringArray(modelNode.includes));
    const explores = Object.keys((modelNode.explore ?? {}) as Record<string, unknown>).sort();
    return { path, name, includes, explores, connectionName: firstString(modelNode.connection) };
  });

  const views: ParsedLookmlView[] = [];
  for (const path of viewPaths) {
    const fileNode = findFileNode(project, path) as Record<string, unknown> | undefined;
    const viewBlock = (fileNode?.view ?? {}) as Record<string, LookmlParseNode>;
    const viewNames = Object.keys(viewBlock).sort();
    if (viewNames.length === 0) {
      views.push({
        path,
        name: nameFromPath(path, /\.view\.(lkml|lookml)$/i),
        extendsFrom: [],
        rawSqlTableName: null,
      });
      continue;
    }
    for (const vname of viewNames) {
      const viewNode = viewBlock[vname] as Record<string, unknown>;
      views.push({
        path,
        name: vname,
        extendsFrom: extractViewExtendsFromNode(viewBlock[vname]),
        rawSqlTableName: firstString(viewNode.sql_table_name),
      });
    }
  }

  const dashboards: ParsedLookmlDashboard[] = dashboardPaths.map((path) => ({
    path,
    name: nameFromPath(path, /\.dashboard\.(lkml|lookml)$/i),
  }));

  return { models, views, dashboards, allPaths };
}
