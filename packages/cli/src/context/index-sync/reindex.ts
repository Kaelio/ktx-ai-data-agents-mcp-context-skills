import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ktxLocalStateDbPath } from '../../context/project/local-state-db.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { loadLocalSlSourceRecords } from '../../context/sl/local-sl.js';
import { SlSearchService } from '../../context/sl/sl-search.service.js';
import { SqliteSlSourcesIndex } from '../../context/sl/sqlite-sl-sources-index.js';
import { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import { SqliteKnowledgeIndex } from '../../context/wiki/sqlite-knowledge-index.js';
import type { ReindexOptions, ReindexScopeResult, ReindexSummary, ReindexWorkResult } from './types.js';

type DiscoveredScope =
  | { kind: 'wiki'; scope: 'GLOBAL'; scopeId: null; label: 'global' }
  | { kind: 'wiki'; scope: 'USER'; scopeId: string; label: `user/${string}` }
  | { kind: 'sl'; connectionId: string; label: string };

const ZERO: ReindexWorkResult = {
  scanned: 0,
  updated: 0,
  deleted: 0,
  embeddingsRecomputed: 0,
  embeddingsFailed: 0,
};

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function childDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function discoverReindexScopes(project: KtxLocalProject): Promise<DiscoveredScope[]> {
  const scopes: DiscoveredScope[] = [];
  if (await directoryExists(join(project.projectDir, 'wiki/global'))) {
    scopes.push({ kind: 'wiki', scope: 'GLOBAL', scopeId: null, label: 'global' });
  }
  for (const userId of await childDirectories(join(project.projectDir, 'wiki/user'))) {
    scopes.push({ kind: 'wiki', scope: 'USER', scopeId: userId, label: `user/${userId}` });
  }
  for (const connectionId of await childDirectories(join(project.projectDir, 'semantic-layer'))) {
    if (connectionId !== '_schema') {
      scopes.push({ kind: 'sl', connectionId, label: connectionId });
    }
  }
  return scopes;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
}

function addTotals(left: ReindexWorkResult, right: ReindexWorkResult): ReindexWorkResult {
  return {
    scanned: left.scanned + right.scanned,
    updated: left.updated + right.updated,
    deleted: left.deleted + right.deleted,
    embeddingsRecomputed: left.embeddingsRecomputed + right.embeddingsRecomputed,
    embeddingsFailed: left.embeddingsFailed + right.embeddingsFailed,
  };
}

function durationSince(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

function embeddingFailureError(work: ReindexWorkResult): string | undefined {
  if (work.embeddingsFailed === 0) {
    return undefined;
  }
  return `${work.embeddingsFailed} embedding recomputation${work.embeddingsFailed === 1 ? '' : 's'} failed`;
}

export async function reindexLocalIndexes(
  project: KtxLocalProject,
  options: ReindexOptions,
): Promise<ReindexSummary> {
  const startedAt = process.hrtime.bigint();
  const dbPath = ktxLocalStateDbPath(project);
  const scopes = await discoverReindexScopes(project);
  const wikiIndex = new SqliteKnowledgeIndex({ dbPath });
  const slIndex = new SqliteSlSourcesIndex({ dbPath });
  const wikiService = new KnowledgeWikiService(project.fileStore, options.embeddingService, wikiIndex, project.git);
  const slService = new SlSearchService(options.embeddingService, slIndex);
  const results: ReindexScopeResult[] = [];

  for (const scope of scopes) {
    const scopeStartedAt = process.hrtime.bigint();
    try {
      let work: ReindexWorkResult;
      if (scope.kind === 'wiki') {
        if (options.force) {
          wikiIndex.clear(scope.scope, scope.scopeId);
        }
        work = await wikiService.syncIndex(scope.scope, scope.scopeId);
        results.push({
          kind: 'wiki',
          label: scope.label,
          scope: scope.scope === 'GLOBAL' ? 'global' : 'user',
          scopeId: scope.scopeId,
          ...work,
          ...(options.force ? { deleted: 0 } : {}),
          ...(options.embeddingService && work.embeddingsFailed > 0 ? { error: embeddingFailureError(work) } : {}),
          durationMs: durationSince(scopeStartedAt),
        });
        continue;
      }

      if (options.force) {
        await slIndex.clear(scope.connectionId);
      }
      const records = await loadLocalSlSourceRecords(project, { connectionId: scope.connectionId });
      work = await slService.indexSources(
        scope.connectionId,
        records.map((record) => record.source),
      );
      results.push({
        kind: 'sl',
        label: scope.label,
        connectionId: scope.connectionId,
        ...work,
        ...(options.force ? { deleted: 0 } : {}),
        ...(options.embeddingService && work.embeddingsFailed > 0 ? { error: embeddingFailureError(work) } : {}),
        durationMs: durationSince(scopeStartedAt),
      });
    } catch (error) {
      results.push({
        kind: scope.kind,
        label: scope.label,
        ...(scope.kind === 'wiki'
          ? { scope: scope.scope === 'GLOBAL' ? 'global' : 'user', scopeId: scope.scopeId }
          : { connectionId: scope.connectionId }),
        ...ZERO,
        durationMs: durationSince(scopeStartedAt),
        error: errorMessage(error),
      });
    }
  }

  return {
    scopes: results,
    totals: results.reduce(addTotals, ZERO),
    dbPath: relative(project.projectDir, dbPath) || dbPath,
    force: options.force,
    embeddingsAvailable: options.embeddingService !== null,
    durationMs: durationSince(startedAt),
  };
}
