import { join } from 'node:path';
import type { ChunkResult, DiffSet, SourceAdapter } from '../../types.js';
import type { FetchContext } from '../../types.js';
import { loadProjectInfo } from '../../dbt-shared/project-vars.js';
import { loadDbtSchemaFiles } from '../../dbt-shared/schema-files.js';
import { parseDbtSchemaFiles } from '../dbt-descriptions/parse-schema.js';
import { chunkDbtProject } from './chunk.js';
import { detectDbtStagedDir } from './detect.js';
import { fetchDbtRepo, type DbtPullConfig } from './fetch.js';
import { parseDbtStagedDir } from './parse.js';

interface DbtSourceAdapterOptions {
  homeDir?: string;
  targetConnectionIds?: string[];
}

export class DbtSourceAdapter implements SourceAdapter {
  readonly source = 'dbt' as const;
  /** Runner merges: ingest_triage, sl_capture, wiki_capture (see ingest-bundle.runner.ts) */
  readonly skillNames: string[] = ['dbt_ingest'];

  constructor(private readonly options: DbtSourceAdapterOptions = {}) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectDbtStagedDir(stagedDir);
  }

  async listTargetConnectionIds(_stagedDir: string): Promise<string[]> {
    return [...new Set(this.options.targetConnectionIds ?? [])].sort((left, right) => left.localeCompare(right));
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    const config = pullConfig as DbtPullConfig | undefined;
    if (!config?.repoUrl) {
      throw new Error('dbt fetch requires repoUrl');
    }
    await fetchDbtRepo({
      config,
      cacheDir: join(this.options.homeDir ?? '.ktx/cache', 'dbt', ctx.connectionId),
      stagedDir,
    });
  }

  async chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    const project = await parseDbtStagedDir(stagedDir);
    const projectInfo = await loadProjectInfo(stagedDir);
    const schemaFiles = await loadDbtSchemaFiles(stagedDir);
    const parseArtifacts = parseDbtSchemaFiles(schemaFiles, projectInfo.variables, {
      projectName: projectInfo.projectName,
    });
    return { ...chunkDbtProject(project, { diffSet }), parseArtifacts };
  }
}
