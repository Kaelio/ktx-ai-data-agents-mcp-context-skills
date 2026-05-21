import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, SourceAdapter, WorkUnit } from '../../types.js';

export class FakeSourceAdapter implements SourceAdapter {
  readonly source = 'fake';
  readonly skillNames: string[] = [];

  detect(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    const subDirs = (await readdir(stagedDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const workUnits: WorkUnit[] = [];
    for (const subDir of subDirs) {
      const entries = await readdir(join(stagedDir, subDir), { withFileTypes: true, recursive: true });
      const rawFiles = entries
        .filter((e) => e.isFile())
        .map((e) => relative(stagedDir, join(e.parentPath, e.name)))
        .sort();
      if (rawFiles.length === 0) {
        continue;
      }
      if (diffSet) {
        const touched = new Set([...diffSet.added, ...diffSet.modified]);
        const anyTouched = rawFiles.some((p) => touched.has(p));
        if (!anyTouched) {
          continue;
        }
      }
      workUnits.push({
        unitKey: `fake-${subDir}`,
        displayLabel: subDir,
        rawFiles,
        peerFileIndex: [],
        dependencyPaths: [],
      });
    }

    const eviction = diffSet && diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted] } : undefined;
    return { workUnits, eviction };
  }
}
