import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STAGED_FILES, type StagedLookerFetchReport, stagedLookerFetchReportSchema } from './types.js';

export async function readLookerFetchReport(stagedDir: string): Promise<StagedLookerFetchReport | null> {
  try {
    const raw = await readFile(join(stagedDir, STAGED_FILES.fetchReport), 'utf-8');
    return stagedLookerFetchReportSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeLookerFetchReport(stagedDir: string, report: StagedLookerFetchReport): Promise<void> {
  const parsed = stagedLookerFetchReportSchema.parse(report);
  const target = join(stagedDir, STAGED_FILES.fetchReport);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
}
