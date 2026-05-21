import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScopeDescriptor } from '../../types.js';
import { STAGED_FILES, type StagedLookerScopeFile, stagedLookerScopeFileSchema } from './types.js';

const LOOKER_ENTITY_PATH_RE = /^(dashboards|looks)\/[^/]+\.json$/;
const LOOKER_EVIDENCE_ENTITY_PATH_RE = /^evidence\/(dashboards|looks)\/([^/]+)\/(?:metadata\.json|page\.md)$/;

export async function describeLookerScope(stagedDir: string): Promise<ScopeDescriptor> {
  const scope = await readLookerScope(stagedDir);
  return {
    fingerprint: hashLookerScope(scope),
    isPathInScope: (rawPath) => isPathInLookerScope(rawPath, scope),
  };
}

async function readLookerScope(stagedDir: string): Promise<StagedLookerScopeFile> {
  try {
    const body = await readFile(join(stagedDir, STAGED_FILES.scope), 'utf-8');
    return stagedLookerScopeFileSchema.parse(JSON.parse(body));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { mode: 'full', knownCurrentRawPaths: [], fetchedRawPaths: [] };
    }
    throw error;
  }
}

/** @internal */
export function hashLookerScope(scope: StagedLookerScopeFile): string {
  const canonical = JSON.stringify({
    mode: scope.mode,
    knownCurrentRawPaths: [...scope.knownCurrentRawPaths].sort(),
    fetchedRawPaths: [...scope.fetchedRawPaths].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** @internal */
export function isPathInLookerScope(rawPath: string, scope: StagedLookerScopeFile): boolean {
  if (scope.mode === 'full') {
    return true;
  }

  const entityRawPath = scopedEntityRawPath(rawPath);
  if (!entityRawPath) {
    return true;
  }

  const knownCurrent = new Set(scope.knownCurrentRawPaths);
  const fetched = new Set(scope.fetchedRawPaths);
  return fetched.has(entityRawPath) || !knownCurrent.has(entityRawPath);
}

function scopedEntityRawPath(rawPath: string): string | null {
  if (LOOKER_ENTITY_PATH_RE.test(rawPath)) {
    return rawPath;
  }
  const evidence = LOOKER_EVIDENCE_ENTITY_PATH_RE.exec(rawPath);
  if (evidence) {
    return `${evidence[1]}/${evidence[2]}.json`;
  }
  return null;
}
