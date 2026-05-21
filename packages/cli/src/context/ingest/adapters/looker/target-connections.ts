import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { stagedDashboardFileSchema, stagedExploreFileSchema, stagedLookFileSchema } from './types.js';

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

function addTarget(targets: Set<string>, value: string | null | undefined): void {
  if (value) {
    targets.add(value);
  }
}

export async function listLookerTargetConnectionIds(stagedDir: string): Promise<string[]> {
  const targets = new Set<string>();
  for (const path of await walk(stagedDir)) {
    const fullPath = join(stagedDir, path);
    if (/^explores\/[^/]+\/[^/]+\.json$/.test(path)) {
      const explore = stagedExploreFileSchema.parse(JSON.parse(await readFile(fullPath, 'utf-8')));
      addTarget(targets, explore.targetWarehouseConnectionId);
      continue;
    }
    if (/^dashboards\/[^/]+\.json$/.test(path)) {
      const dashboard = stagedDashboardFileSchema.parse(JSON.parse(await readFile(fullPath, 'utf-8')));
      for (const tile of dashboard.tiles) {
        addTarget(targets, tile.query?.targetWarehouseConnectionId);
      }
      continue;
    }
    if (/^looks\/[^/]+\.json$/.test(path)) {
      const look = stagedLookFileSchema.parse(JSON.parse(await readFile(fullPath, 'utf-8')));
      addTarget(targets, look.query?.targetWarehouseConnectionId);
    }
  }
  return [...targets].sort();
}
