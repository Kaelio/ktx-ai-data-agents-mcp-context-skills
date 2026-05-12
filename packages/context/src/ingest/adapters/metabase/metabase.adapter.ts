import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChunkResult, DiffSet, FetchContext, ScopeDescriptor, SourceAdapter } from '../../types.js';
import { chunkMetabaseStagedDir } from './chunk.js';
import type { MetabaseClientFactory } from './client-port.js';
import { detectMetabaseStagedDir } from './detect.js';
import { fetchMetabaseBundle, type MetabaseFetchLogger } from './fetch.js';
import { computeFetchScope, hashScope, isPathInMetabaseScope } from './fetch-scope.js';
import type { MetabaseSourceStateReader } from './source-state-port.js';
import { STAGED_FILES, stagedSyncConfigSchema } from './types.js';

export interface MetabaseSourceAdapterDeps {
  clientFactory: MetabaseClientFactory;
  sourceStateReader: MetabaseSourceStateReader;
  logger?: MetabaseFetchLogger;
}

export class MetabaseSourceAdapter implements SourceAdapter {
  readonly source = 'metabase';
  readonly skillNames: string[] = ['metabase_ingest'];

  constructor(private readonly deps: MetabaseSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectMetabaseStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    await fetchMetabaseBundle({
      pullConfig,
      stagedDir,
      ctx,
      clientFactory: this.deps.clientFactory,
      sourceStateReader: this.deps.sourceStateReader,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkMetabaseStagedDir(stagedDir, { diffSet });
  }

  async describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    const body = await readFile(join(stagedDir, STAGED_FILES.syncConfig), 'utf-8');
    const syncConfig = stagedSyncConfigSchema.parse(JSON.parse(body));
    const scope = computeFetchScope(syncConfig);
    const fingerprint = hashScope(scope);
    return {
      fingerprint,
      isPathInScope: (p) => isPathInMetabaseScope(p, scope),
    };
  }
}
