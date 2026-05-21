import { access } from 'node:fs/promises';
import { join } from 'node:path';

export async function detectDbtStagedDir(stagedDir: string): Promise<boolean> {
  for (const name of ['dbt_project.yml', 'dbt_project.yaml'] as const) {
    try {
      await access(join(stagedDir, name));
      return true;
    } catch {}
  }
  return false;
}
