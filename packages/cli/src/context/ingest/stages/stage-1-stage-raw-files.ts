import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { rawSourcesDirForSync } from '../raw-sources-paths.js';

interface StageRawFilesParams {
  stagedDir: string;
  worktreeRoot: string;
  connectionId: string;
  sourceKey: string;
  syncId: string;
}

interface StageRawFilesResult {
  currentHashes: Map<string, string>;
  rawDirInWorktree: string;
}

export async function stageRawFilesStage1(params: StageRawFilesParams): Promise<StageRawFilesResult> {
  const rawDirRel = rawSourcesDirForSync(params.connectionId, params.sourceKey, params.syncId);
  const targetRoot = join(params.worktreeRoot, rawDirRel);
  const currentHashes = new Map<string, string>();

  const entries = await readdir(params.stagedDir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const absSrc = join(entry.parentPath, entry.name);
    const rel = relative(params.stagedDir, absSrc);
    const body = await readFile(absSrc);
    const hash = createHash('sha256').update(body).digest('hex');
    currentHashes.set(rel, hash);
    const dest = join(targetRoot, rel);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, body);
  }
  return { currentHashes, rawDirInWorktree: rawDirRel };
}
