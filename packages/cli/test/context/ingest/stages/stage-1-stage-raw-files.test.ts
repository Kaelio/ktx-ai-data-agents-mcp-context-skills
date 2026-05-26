import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stageRawFilesStage1 } from '../../../../src/context/ingest/stages/stage-1-stage-raw-files.js';

describe('Stage 1 — stageRawFiles', () => {
  let stagedDir: string;
  let workdir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'stage1-src-'));
    workdir = await mkdtemp(join(tmpdir(), 'stage1-wt-'));
    await mkdir(join(stagedDir, 'views'), { recursive: true });
    await writeFile(join(stagedDir, 'views', 'a.yml'), 'alpha', 'utf-8');
    await writeFile(join(stagedDir, 'b.yml'), 'beta', 'utf-8');
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  });

  it('copies all files under raw-sources/<conn>/<src>/<sync> and returns their hash map', async () => {
    const result = await stageRawFilesStage1({
      stagedDir,
      worktreeRoot: workdir,
      connectionId: 'c1',
      sourceKey: 'fake',
      syncId: 's1',
    });
    const copied = await readFile(join(workdir, 'raw-sources/c1/fake/s1/views/a.yml'), 'utf-8');
    expect(copied).toBe('alpha');
    expect(result.currentHashes.get('views/a.yml')).toMatch(/^[0-9a-f]{64}$/);
    expect(result.currentHashes.get('b.yml')).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawDirInWorktree).toBe('raw-sources/c1/fake/s1');
  });

  it('different content produces different hashes', async () => {
    const r1 = await stageRawFilesStage1({
      stagedDir,
      worktreeRoot: workdir,
      connectionId: 'c1',
      sourceKey: 'fake',
      syncId: 's1',
    });
    const other = await mkdtemp(join(tmpdir(), 'stage1-other-'));
    await writeFile(join(other, 'b.yml'), 'bravo', 'utf-8');
    const r2 = await stageRawFilesStage1({
      stagedDir: other,
      worktreeRoot: workdir,
      connectionId: 'c1',
      sourceKey: 'fake',
      syncId: 's2',
    });
    expect(r1.currentHashes.get('b.yml')).not.toBe(r2.currentHashes.get('b.yml'));
    await rm(other, { recursive: true, force: true });
  });
});
