import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const YAML_EXT_RE = /\.(ya?ml)$/i;

/** @internal */
export function normalizeDbtPath(path: string): string {
  return path.replaceAll('\\', '/');
}

async function collectYamlFiles(stagedDir: string): Promise<string[]> {
  const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !YAML_EXT_RE.test(entry.name)) {
      continue;
    }
    const abs = join(entry.parentPath, entry.name);
    paths.push(normalizeDbtPath(relative(stagedDir, abs)));
  }
  paths.sort();
  return paths;
}

export interface ParsedDbtProject {
  /** All `.yml` / `.yaml` paths under stagedDir, relative + sorted. */
  allPaths: string[];
}

export async function parseDbtStagedDir(stagedDir: string): Promise<ParsedDbtProject> {
  const allPaths = await collectYamlFiles(stagedDir);
  return { allPaths };
}
