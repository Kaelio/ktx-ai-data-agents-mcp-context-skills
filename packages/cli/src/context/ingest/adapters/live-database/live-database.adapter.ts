import type { ChunkResult, DiffSet, FetchContext, SourceAdapter } from '../../types.js';
import { filterSnapshotTables } from '../../../scan/enabled-tables.js';
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
    const tableScope = this.deps.resolveTableScope?.(ctx.connectionId);
    const snapshot = await this.deps.introspection.extractSchema(ctx.connectionId, { tableScope });
    const filtered = tableScope ? filterSnapshotTables(snapshot, tableScope) : snapshot;
    await writeLiveDatabaseSnapshot(stagedDir, {
      ...filtered,
      connectionId: ctx.connectionId,
      extractedAt: filtered.extractedAt ?? (this.deps.now ?? (() => new Date()))().toISOString(),
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkLiveDatabaseStagedDir(stagedDir, diffSet);
  }
}
