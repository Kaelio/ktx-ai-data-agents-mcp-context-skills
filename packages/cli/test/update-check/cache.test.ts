import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readUpdateCheckCache,
  updateCheckCachePath,
  writeUpdateCheckCache,
} from '../../src/update-check/cache.js';

describe('update-check cache', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ktx-update-check-cache-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('uses ~/.ktx/update-check.json', () => {
    expect(updateCheckCachePath(homeDir)).toBe(join(homeDir, '.ktx', 'update-check.json'));
  });

  it('round-trips strict cache data', async () => {
    await writeUpdateCheckCache(
      {
        checkedAt: '2026-06-06T10:00:00.000Z',
        channel: 'latest',
        installedVersion: '0.9.0',
        latestForChannel: '0.10.0',
        lastNoticeAt: '2026-06-06T11:00:00.000Z',
      },
      { homeDir },
    );

    await expect(readUpdateCheckCache({ homeDir })).resolves.toEqual({
      checkedAt: '2026-06-06T10:00:00.000Z',
      channel: 'latest',
      installedVersion: '0.9.0',
      latestForChannel: '0.10.0',
      lastNoticeAt: '2026-06-06T11:00:00.000Z',
    });
  });

  it('returns null when the cache file is missing', async () => {
    await expect(readUpdateCheckCache({ homeDir })).resolves.toBeNull();
  });

  it('returns null when the cache file is corrupt JSON', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(updateCheckCachePath(homeDir), '{bad json', 'utf-8');

    await expect(readUpdateCheckCache({ homeDir })).resolves.toBeNull();
  });

  it('returns null when the cache has unknown fields', async () => {
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      updateCheckCachePath(homeDir),
      JSON.stringify(
        {
          checkedAt: '2026-06-06T10:00:00.000Z',
          channel: 'latest',
          installedVersion: '0.9.0',
          latestForChannel: '0.10.0',
          unexpected: true,
        },
        null,
        2,
      ),
      'utf-8',
    );

    await expect(readUpdateCheckCache({ homeDir })).resolves.toBeNull();
  });

  it('writes formatted JSON with a trailing newline', async () => {
    await writeUpdateCheckCache(
      {
        checkedAt: '2026-06-06T10:00:00.000Z',
        channel: 'next',
        installedVersion: '0.10.0-rc.1',
        latestForChannel: '0.10.0-rc.2',
      },
      { homeDir },
    );

    const raw = await readFile(updateCheckCachePath(homeDir), 'utf-8');
    expect(raw).toContain('"channel": "next"');
    expect(raw.endsWith('\n')).toBe(true);
  });
});
