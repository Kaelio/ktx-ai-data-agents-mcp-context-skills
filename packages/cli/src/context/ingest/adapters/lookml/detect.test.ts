import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLookmlStagedDir } from './detect.js';

describe('detectLookmlStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'lkml-detect-'));
  });

  afterEach(async () => rm(stagedDir, { recursive: true, force: true }));

  it('returns true when a .model.lkml is present at root', async () => {
    await writeFile(join(stagedDir, 'orders.model.lkml'), 'include: "views/*"\n', 'utf-8');
    expect(await detectLookmlStagedDir(stagedDir)).toBe(true);
  });

  it('returns true when only a .view.lkml is present (no model)', async () => {
    await writeFile(join(stagedDir, 'x.view.lkml'), 'view: x {}\n', 'utf-8');
    expect(await detectLookmlStagedDir(stagedDir)).toBe(true);
  });

  it('returns true when .lkml files are nested under any subdirectory', async () => {
    await mkdir(join(stagedDir, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(stagedDir, 'nested', 'deeper', 'x.view.lkml'), 'view: x {}\n', 'utf-8');
    expect(await detectLookmlStagedDir(stagedDir)).toBe(true);
  });

  it('accepts the .lookml extension as well as .lkml', async () => {
    await writeFile(join(stagedDir, 'x.view.lookml'), 'view: x {}\n', 'utf-8');
    expect(await detectLookmlStagedDir(stagedDir)).toBe(true);
  });

  it('returns false for a bundle with no .lkml files at all', async () => {
    await writeFile(join(stagedDir, 'README.md'), '# hi\n', 'utf-8');
    await writeFile(join(stagedDir, 'config.yaml'), 'a: 1\n', 'utf-8');
    expect(await detectLookmlStagedDir(stagedDir)).toBe(false);
  });

  it('returns false for an empty directory', async () => {
    expect(await detectLookmlStagedDir(stagedDir)).toBe(false);
  });
});
