import type { ChunkResult, DiffSet, FetchContext, IngestTrigger, ScopeDescriptor, SourceAdapter } from '../../types.js';
import { chunkLookerStagedDir } from './chunk.js';
import { detectLookerStagedDir } from './detect.js';
import { getLookerTriageSignals } from './evidence-documents.js';
import { fetchLookerRuntimeBundle, type LookerClientFactory } from './fetch.js';
import { readLookerFetchReport } from './fetch-report.js';
import { describeLookerScope } from './scope.js';
import { listLookerTargetConnectionIds } from './target-connections.js';

interface LookerPullSucceededContext {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  trigger: IngestTrigger;
  completedAt: Date;
  stagedDir: string;
}

export interface LookerSourceAdapterDeps {
  clientFactory: LookerClientFactory;
  now?: () => Date;
  onPullSucceeded?: (ctx: LookerPullSucceededContext) => Promise<void>;
}

export class LookerSourceAdapter implements SourceAdapter {
  readonly source = 'looker';
  readonly skillNames: string[] = ['looker_ingest'];
  readonly evidenceIndexing = 'documents' as const;
  readonly triageSupported = true;

  constructor(private readonly deps: LookerSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectLookerStagedDir(stagedDir);
  }

  fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    return fetchLookerRuntimeBundle({
      pullConfig,
      stagedDir,
      ctx,
      clientFactory: this.deps.clientFactory,
      now: this.deps.now,
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkLookerStagedDir(stagedDir, diffSet);
  }

  readFetchReport(stagedDir: string) {
    return readLookerFetchReport(stagedDir);
  }

  listTargetConnectionIds(stagedDir: string): Promise<string[]> {
    return listLookerTargetConnectionIds(stagedDir);
  }

  getTriageSignals(stagedDir: string, externalId: string) {
    return getLookerTriageSignals(stagedDir, externalId);
  }

  describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    return describeLookerScope(stagedDir);
  }

  async onPullSucceeded(ctx: LookerPullSucceededContext): Promise<void> {
    await this.deps.onPullSucceeded?.(ctx);
  }
}
