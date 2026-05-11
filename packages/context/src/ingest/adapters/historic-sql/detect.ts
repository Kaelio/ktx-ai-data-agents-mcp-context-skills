import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HISTORIC_SQL_SOURCE_KEY } from './types.js';

export async function detectHistoricSqlStagedDir(stagedDir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8')) as { source?: unknown };
    if (manifest.source === HISTORIC_SQL_SOURCE_KEY) {
      return true;
    }
    if (manifest.source !== undefined) {
      return false;
    }
  } catch {
    // Fall through to structural detection for stage-only fixtures.
  }

  try {
    await readFile(join(stagedDir, 'patterns-input.json'), 'utf-8');
    const entries = await readdir(join(stagedDir, 'tables'), { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.json'));
  } catch {
    return false;
  }
}
