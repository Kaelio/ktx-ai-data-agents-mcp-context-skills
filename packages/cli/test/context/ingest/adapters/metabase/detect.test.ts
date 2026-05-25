import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectMetabaseStagedDir } from '../../../../../src/context/ingest/adapters/metabase/detect.js';

async function touch(stagedDir: string, relPath: string, body: string): Promise<void> {
  const abs = join(stagedDir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf-8');
}

describe('detectMetabaseStagedDir', () => {
  let stagedDir: string;
  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'mb-detect-'));
  });
  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('returns true when sync-config.json + cards/*.json are present', async () => {
    await touch(stagedDir, 'sync-config.json', '{}');
    await touch(stagedDir, 'cards/1.json', '{}');
    expect(await detectMetabaseStagedDir(stagedDir)).toBe(true);
  });

  it('returns false when sync-config.json is missing', async () => {
    await touch(stagedDir, 'cards/1.json', '{}');
    expect(await detectMetabaseStagedDir(stagedDir)).toBe(false);
  });

  it('returns false when cards/ is empty', async () => {
    await touch(stagedDir, 'sync-config.json', '{}');
    await mkdir(join(stagedDir, 'cards'), { recursive: true });
    expect(await detectMetabaseStagedDir(stagedDir)).toBe(false);
  });

  it('returns false for an empty staged dir', async () => {
    expect(await detectMetabaseStagedDir(stagedDir)).toBe(false);
  });

  it('returns true even when the cards dir has one file and extra non-JSON siblings', async () => {
    await touch(stagedDir, 'sync-config.json', '{}');
    await touch(stagedDir, 'cards/1.json', '{}');
    await touch(stagedDir, 'README.md', '# readme');
    expect(await detectMetabaseStagedDir(stagedDir)).toBe(true);
  });
});
