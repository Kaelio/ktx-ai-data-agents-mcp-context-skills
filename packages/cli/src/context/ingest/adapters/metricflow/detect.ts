import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const YAML_EXT_RE = /\.(ya?ml)$/i;

export async function detectMetricFlowStagedDir(stagedDir: string): Promise<boolean> {
  const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !YAML_EXT_RE.test(entry.name)) {
      continue;
    }
    const abs = join(entry.parentPath, entry.name);
    let body: string;
    try {
      body = await readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    let yaml: unknown;
    try {
      yaml = parseYaml(body);
    } catch {
      continue;
    }
    if (yaml && typeof yaml === 'object') {
      const obj = yaml as Record<string, unknown>;
      if (Array.isArray(obj.semantic_models) || Array.isArray(obj.metrics)) {
        return true;
      }
    }
  }
  return false;
}
