import { readdir } from 'node:fs/promises';

const LKML_EXT_RE = /\.(lkml|lookml)$/i;

export async function detectLookmlStagedDir(stagedDir: string): Promise<boolean> {
  const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && LKML_EXT_RE.test(entry.name)) {
      return true;
    }
  }
  return false;
}
