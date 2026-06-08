import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isFreshStarCountCache,
  readStarCountCache,
  starCountCachePath,
  writeStarCountCache,
} from '../../src/star-prompt/cache.js';

describe('star prompt cache', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ktx-star-count-cache-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('uses ~/.ktx/star-count.json', () => {
    expect(starCountCachePath(homeDir)).toBe(join(homeDir, '.ktx', 'star-count.json'));
  });

  it('round-trips strict cache data', async () => {
    await writeStarCountCache({ count: 1234, fetchedAt: '2026-06-08T10:00:00.000Z' }, { homeDir });

    expect(readStarCountCache({ homeDir })).toEqual({
      count: 1234,
      fetchedAt: '2026-06-08T10:00:00.000Z',
    });
  });

  it('returns null for missing, corrupt, or unknown-field cache files', async () => {
    expect(readStarCountCache({ homeDir })).toBeNull();

    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(starCountCachePath(homeDir), '{bad json', 'utf-8');
    expect(readStarCountCache({ homeDir })).toBeNull();

    await writeFile(
      starCountCachePath(homeDir),
      JSON.stringify({ count: 1234, fetchedAt: '2026-06-08T10:00:00.000Z', extra: true }),
      'utf-8',
    );
    expect(readStarCountCache({ homeDir })).toBeNull();
  });

  it('writes formatted JSON with a trailing newline', async () => {
    await writeStarCountCache({ count: 9876, fetchedAt: '2026-06-08T10:00:00.000Z' }, { homeDir });

    const raw = await readFile(starCountCachePath(homeDir), 'utf-8');
    expect(raw).toContain('"count": 9876');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('detects fresh and stale cache entries', () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    const ttlMs = 24 * 60 * 60 * 1000;

    expect(
      isFreshStarCountCache({ count: 1, fetchedAt: '2026-06-07T12:00:01.000Z' }, now, ttlMs),
    ).toBe(true);
    expect(
      isFreshStarCountCache({ count: 1, fetchedAt: '2026-06-07T11:59:59.000Z' }, now, ttlMs),
    ).toBe(false);
    expect(isFreshStarCountCache({ count: 1, fetchedAt: 'not-a-date' }, now, ttlMs)).toBe(false);
    expect(isFreshStarCountCache(null, now, ttlMs)).toBe(false);
  });
});
