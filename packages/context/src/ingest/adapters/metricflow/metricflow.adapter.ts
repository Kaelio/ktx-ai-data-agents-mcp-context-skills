import { join } from 'node:path';
import type {
  ChunkResult,
  DeterministicProjectionContext,
  DiffSet,
  FetchContext,
  ProjectionResult,
  SourceAdapter,
} from '../../types.js';
import { chunkMetricFlowProject } from './chunk.js';
import { detectMetricFlowStagedDir } from './detect.js';
import { parseMetricflowFiles, type MetricFlowParseResult } from './deep-parse.js';
import { fetchMetricflowRepo } from './fetch.js';
import { importMetricflowSemanticModels } from './import-semantic-models.js';
import { parseMetricFlowStagedDir, type ParsedMetricFlowProject } from './parse.js';
import {
  metricflowHostTablesFromParsedTargets,
  readMetricflowProjectionConfig,
  writeMetricflowProjectionConfig,
} from './projection-config.js';
import { parseMetricflowPullConfig } from './pull-config.js';

export interface MetricflowSourceAdapterDeps {
  homeDir: string;
  targetConnectionIds?: string[];
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

export class MetricflowSourceAdapter implements SourceAdapter {
  readonly source = 'metricflow';
  readonly skillNames: string[] = ['metricflow_ingest'];

  constructor(private readonly deps: MetricflowSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectMetricFlowStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    const config = parseMetricflowPullConfig(pullConfig);
    await fetchMetricflowRepo({
      config,
      cacheDir: this.resolveCacheDir(ctx.connectionId),
      stagedDir,
    });
    await writeMetricflowProjectionConfig(stagedDir, {
      parsedTargetTables: config.parsedTargetTables,
    });
  }

  async listTargetConnectionIds(_stagedDir: string): Promise<string[]> {
    return uniqueSorted(this.deps.targetConnectionIds);
  }

  async chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    const project = await parseMetricFlowStagedDir(stagedDir);
    const chunk = await chunkMetricFlowProject(project, { diffSet });
    const parseArtifacts = parseMetricflowStagedDirForImport(project);
    return { ...chunk, parseArtifacts };
  }

  async project(ctx: DeterministicProjectionContext): Promise<ProjectionResult> {
    if (!isMetricFlowParseResult(ctx.parseArtifacts)) {
      return {
        warnings: [],
        errors: ['MetricFlow deterministic projection requires parseArtifacts from chunk()'],
        touchedSources: [],
        changedWikiPageKeys: [],
      };
    }

    const projectionConfig = await readMetricflowProjectionConfig(ctx.stagedDir);
    const result = await importMetricflowSemanticModels(
      { semanticLayerService: ctx.semanticLayerService },
      {
        connectionId: ctx.connectionId,
        parseResult: ctx.parseArtifacts,
        targetSchema: null,
        hostTables: metricflowHostTablesFromParsedTargets(projectionConfig.parsedTargetTables),
        workdir: ctx.workdir,
      },
    );

    return {
      result,
      warnings: result.warnings,
      errors: result.errors,
      touchedSources: result.touchedSources,
      changedWikiPageKeys: [],
    };
  }

  private resolveCacheDir(connectionId: string): string {
    return join(this.deps.homeDir, 'ingest-metricflow-repos', connectionId);
  }
}

function parseMetricflowStagedDirForImport(project: ParsedMetricFlowProject): MetricFlowParseResult {
  return parseMetricflowFiles(project.files);
}

function isMetricFlowParseResult(value: unknown): value is MetricFlowParseResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<MetricFlowParseResult>;
  return (
    Array.isArray(candidate.semanticModels) &&
    Array.isArray(candidate.crossModelMetrics) &&
    Array.isArray(candidate.relationships) &&
    Array.isArray(candidate.warnings)
  );
}
