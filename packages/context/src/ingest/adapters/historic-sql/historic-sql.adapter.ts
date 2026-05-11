import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChunkResult, DiffSet, FetchContext, ScopeDescriptor, SourceAdapter } from '../../types.js';
import { chunkHistoricSqlUnifiedStagedDir, describeHistoricSqlUnifiedScope } from './chunk-unified.js';
import { detectHistoricSqlStagedDir } from './detect.js';
import { stageHistoricSqlAggregatedSnapshot } from './stage-unified.js';
import { type HistoricSqlSourceAdapterDeps } from './types.js';

export class HistoricSqlSourceAdapter implements SourceAdapter {
  readonly source = 'historic-sql';
  readonly skillNames = ['historic_sql_table_digest', 'historic_sql_patterns'];
  readonly reconcileSkillNames: string[] = [];
  readonly triageSupported = false;

  constructor(private readonly deps: HistoricSqlSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectHistoricSqlStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: ctx.connectionId,
      queryClient: this.deps.queryClient,
      reader: this.deps.reader,
      sqlAnalysis: this.deps.sqlAnalysis,
      pullConfig,
      now: this.deps.now?.(),
    });
    if (this.deps.legacyPostgresBaselineRootDir) {
      await rm(join(this.deps.legacyPostgresBaselineRootDir, ctx.connectionId, ['pgss', 'baseline.json'].join('-')), {
        force: true,
      });
    }
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkHistoricSqlUnifiedStagedDir(stagedDir, diffSet);
  }

  describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    return describeHistoricSqlUnifiedScope(stagedDir);
  }
}
