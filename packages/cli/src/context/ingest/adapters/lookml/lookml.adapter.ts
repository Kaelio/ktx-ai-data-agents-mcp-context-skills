import { join } from 'node:path';
import type { ChunkResult, DiffSet, FetchContext, SourceAdapter } from '../../types.js';
import { chunkLookmlProject } from './chunk.js';
import { detectLookmlStagedDir } from './detect.js';
import {
  buildLookmlValidationArtifacts,
  readLookmlFetchReport,
  readLookmlMismatchedModelNames,
  writeLookmlValidationArtifacts,
} from './fetch-report.js';
import { fetchLookmlRepo } from './fetch.js';
import { parseLookmlStagedDir } from './parse.js';
import { parseLookmlPullConfig } from './pull-config.js';

export interface LookmlSourceAdapterDeps {
  homeDir: string;
  targetConnectionIds?: string[];
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

export class LookmlSourceAdapter implements SourceAdapter {
  readonly source = 'lookml';
  readonly skillNames: string[] = ['lookml_ingest'];

  constructor(private readonly deps: LookmlSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectLookmlStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    const config = parseLookmlPullConfig(pullConfig);
    const cacheDir = this.resolveCacheDir(ctx.connectionId);
    await fetchLookmlRepo({ config, cacheDir, stagedDir });
    const project = await parseLookmlStagedDir(stagedDir);
    await writeLookmlValidationArtifacts(
      stagedDir,
      buildLookmlValidationArtifacts(project, {
        expectedLookerConnectionName: config.expectedLookerConnectionName,
      }),
    );
  }

  readFetchReport(stagedDir: string) {
    return readLookmlFetchReport(stagedDir);
  }

  async listTargetConnectionIds(_stagedDir: string): Promise<string[]> {
    return uniqueSorted(this.deps.targetConnectionIds);
  }

  async chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    const project = await parseLookmlStagedDir(stagedDir);
    const mismatchedModelNames = await readLookmlMismatchedModelNames(stagedDir);
    return chunkLookmlProject(project, { diffSet, mismatchedModelNames });
  }

  private resolveCacheDir(connectionId: string): string {
    return join(this.deps.homeDir, 'ingest-lookml-repos', connectionId);
  }
}
