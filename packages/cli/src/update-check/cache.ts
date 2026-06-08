import { renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const updateCheckCacheSchema = z
  .object({
    checkedAt: z.string(),
    channel: z.enum(['latest', 'next']),
    installedVersion: z.string(),
    latestForChannel: z.string(),
    lastNoticeAt: z.string().optional(),
  })
  .strict();

export type UpdateCheckCache = z.infer<typeof updateCheckCacheSchema>;

/** @internal */
export function updateCheckCachePath(homeDir = homedir()): string {
  return join(homeDir, '.ktx', 'update-check.json');
}

export async function readUpdateCheckCache(options: { homeDir?: string } = {}): Promise<UpdateCheckCache | null> {
  try {
    return updateCheckCacheSchema.parse(JSON.parse(await readFile(updateCheckCachePath(options.homeDir), 'utf-8')));
  } catch {
    return null;
  }
}

export async function writeUpdateCheckCache(
  value: UpdateCheckCache,
  options: { homeDir?: string } = {},
): Promise<void> {
  try {
    const path = updateCheckCachePath(options.homeDir);
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  } catch {
    return;
  }
}
