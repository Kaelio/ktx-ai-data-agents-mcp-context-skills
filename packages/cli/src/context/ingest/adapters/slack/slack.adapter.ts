import type { ChunkResult, DiffSet, FetchContext, ScopeDescriptor, SourceAdapter } from '../../types.js';
import { chunkSlackStagedDir, describeSlackScope } from './chunk.js';
import { detectSlackStagedDir } from './detect.js';
import { fetchSlackSnapshot } from './fetch.js';
import type { SlackApi } from './slack-client.js';

export interface SlackSourceAdapterDeps {
  client?: SlackApi;
  now?: () => Date;
}

export class SlackSourceAdapter implements SourceAdapter {
  readonly source = 'slack';
  readonly skillNames = ['notion_synthesize'];
  readonly reconcileSkillNames: string[] = [];
  readonly evidenceIndexing = 'documents' as const;
  readonly triageSupported = false;

  constructor(private readonly deps: SlackSourceAdapterDeps = {}) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectSlackStagedDir(stagedDir);
  }

  fetch(pullConfig: unknown, stagedDir: string, _ctx: FetchContext): Promise<void> {
    return fetchSlackSnapshot({
      config: pullConfig,
      stagedDir,
      ...(this.deps.client ? { client: this.deps.client } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkSlackStagedDir(stagedDir, diffSet);
  }

  describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    return describeSlackScope(stagedDir);
  }
}
