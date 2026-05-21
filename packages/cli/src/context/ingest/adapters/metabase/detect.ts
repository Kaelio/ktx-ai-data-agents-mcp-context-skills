import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { STAGED_FILES } from './types.js';

export async function detectMetabaseStagedDir(stagedDir: string): Promise<boolean> {
  try {
    await stat(join(stagedDir, STAGED_FILES.syncConfig));
  } catch {
    return false;
  }
  const cardsDir = join(stagedDir, STAGED_FILES.cardsDir);
  let cardEntries: string[];
  try {
    cardEntries = await readdir(cardsDir);
  } catch {
    return false;
  }
  return cardEntries.some((name) => name.endsWith('.json'));
}
