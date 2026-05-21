import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { STAGED_FILES } from './types.js';

const LOOKER_ENTITY_FILE_RE = /^(explores\/[^/]+\/[^/]+|dashboards\/[^/]+|looks\/[^/]+)\.json$/;

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

export async function detectLookerStagedDir(stagedDir: string): Promise<boolean> {
  try {
    await stat(join(stagedDir, STAGED_FILES.syncConfig));
  } catch {
    return false;
  }

  try {
    const paths = await walk(stagedDir);
    return paths.some((path) => LOOKER_ENTITY_FILE_RE.test(path));
  } catch {
    return false;
  }
}
