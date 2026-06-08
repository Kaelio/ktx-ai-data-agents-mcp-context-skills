import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const starCountCacheSchema = z
  .object({
    count: z.number().int().nonnegative(),
    fetchedAt: z.string(),
  })
  .strict();

export type StarCountCache = z.infer<typeof starCountCacheSchema>;

/** @internal */
export function starCountCachePath(homeDir = homedir()): string {
  return join(homeDir, '.ktx', 'star-count.json');
}

export function readStarCountCache(options: { homeDir?: string } = {}): StarCountCache | null {
  try {
    return starCountCacheSchema.parse(JSON.parse(readFileSync(starCountCachePath(options.homeDir), 'utf-8')));
  } catch {
    return null;
  }
}

export async function writeStarCountCache(value: StarCountCache, options: { homeDir?: string } = {}): Promise<void> {
  try {
    const path = starCountCachePath(options.homeDir);
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  } catch {
    return;
  }
}

export function isFreshStarCountCache(cache: StarCountCache | null, now: Date, ttlMs: number): boolean {
  if (!cache) {
    return false;
  }
  const fetchedAtMs = Date.parse(cache.fetchedAt);
  if (Number.isNaN(fetchedAtMs)) {
    return false;
  }
  return now.getTime() - fetchedAtMs < ttlMs;
}
