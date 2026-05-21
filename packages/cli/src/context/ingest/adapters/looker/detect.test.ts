import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLookerStagedDir } from './detect.js';

async function touch(stagedDir: string, relPath: string, body = '{}\n'): Promise<void> {
  const abs = join(stagedDir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf-8');
}

describe('detectLookerStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'looker-detect-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('returns true when sync-config.json and at least one runtime entity are present', async () => {
    await touch(stagedDir, 'sync-config.json');
    await touch(stagedDir, 'explores/b2b/sales_pipeline.json');
    expect(await detectLookerStagedDir(stagedDir)).toBe(true);
  });

  it('returns true for dashboard-only staged dirs', async () => {
    await touch(stagedDir, 'sync-config.json');
    await touch(stagedDir, 'dashboards/10.json');
    expect(await detectLookerStagedDir(stagedDir)).toBe(true);
  });

  it('returns false without sync-config.json', async () => {
    await touch(stagedDir, 'looks/20.json');
    expect(await detectLookerStagedDir(stagedDir)).toBe(false);
  });

  it('returns false when only control files are present', async () => {
    await touch(stagedDir, 'sync-config.json');
    await touch(stagedDir, 'lookml_models.json');
    await touch(stagedDir, 'signals/dashboard_usage.json', '[]\n');
    expect(await detectLookerStagedDir(stagedDir)).toBe(false);
  });
});
