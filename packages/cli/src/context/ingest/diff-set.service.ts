import type { IngestProvenancePort } from './ports.js';
import type { DiffSet } from './types.js';

export function computeDiffSetFromHashes(
  currentHashes: Map<string, string>,
  priorHashesRaw: Map<string, string>,
  isPathInScope?: (rawPath: string) => boolean,
): DiffSet {
  const priorHashes = isPathInScope
    ? new Map([...priorHashesRaw].filter(([path]) => isPathInScope(path)))
    : priorHashesRaw;

  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];

  for (const [path, hash] of currentHashes) {
    const prior = priorHashes.get(path);
    if (prior === undefined) {
      added.push(path);
    } else if (prior === hash) {
      unchanged.push(path);
    } else {
      modified.push(path);
    }
  }

  for (const path of priorHashes.keys()) {
    if (!currentHashes.has(path)) {
      deleted.push(path);
    }
  }

  added.sort();
  modified.sort();
  unchanged.sort();
  deleted.sort();
  return { added, modified, unchanged, deleted };
}

export class DiffSetService {
  constructor(private readonly provenance: IngestProvenancePort) {}

  async compute(
    connectionId: string,
    sourceKey: string,
    currentHashes: Map<string, string>,
    isPathInScope?: (rawPath: string) => boolean,
  ): Promise<DiffSet> {
    const priorHashes = await this.provenance.findLatestHashesForCompletedSyncs(connectionId, sourceKey);
    return computeDiffSetFromHashes(currentHashes, priorHashes, isPathInScope);
  }
}
