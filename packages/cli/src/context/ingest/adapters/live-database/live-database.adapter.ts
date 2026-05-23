import type { ChunkResult, DiffSet, FetchContext, SourceAdapter } from '../../types.js';
import { chunkLiveDatabaseStagedDir } from './chunk.js';
import { detectLiveDatabaseStagedDir, writeLiveDatabaseSnapshot } from './stage.js';
import type { LiveDatabaseSourceAdapterDeps } from './types.js';

export class LiveDatabaseSourceAdapter implements SourceAdapter {
  readonly source = 'live-database';
  readonly skillNames = ['live_database_ingest'];

  constructor(private readonly deps: LiveDatabaseSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectLiveDatabaseStagedDir(stagedDir);
  }

  async fetch(_pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    const tableScope = ctx.tableScope;
    const snapshot = await this.deps.introspection.extractSchema(ctx.connectionId, { tableScope });
    await writeLiveDatabaseSnapshot(stagedDir, {
      ...snapshot,
      connectionId: ctx.connectionId,
      extractedAt: snapshot.extractedAt ?? (this.deps.now ?? (() => new Date()))().toISOString(),
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkLiveDatabaseStagedDir(stagedDir, diffSet);
  }
}
