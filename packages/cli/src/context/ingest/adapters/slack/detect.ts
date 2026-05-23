import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SLACK_SOURCE_KEY } from './types.js';

export async function detectSlackStagedDir(stagedDir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8')) as { source?: unknown };
    if (manifest.source === SLACK_SOURCE_KEY) {
      return true;
    }
  } catch {
    // Fall through to structural detection for manually staged dirs.
  }

  try {
    const entries = await readdir(join(stagedDir, 'wiki', 'global'), { withFileTypes: true, recursive: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.md'));
  } catch {
    return false;
  }
}
