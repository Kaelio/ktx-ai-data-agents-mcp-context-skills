import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ChunkResult,
  ClusterWorkUnitsContext,
  DiffSet,
  FetchContext,
  IngestTrigger,
  ScopeDescriptor,
  SourceAdapter,
  TriageSignals,
  WorkUnit,
} from '../../types.js';
import { chunkNotionStagedDir, describeNotionScope } from './chunk.js';
import { clusterNotionWorkUnits } from './cluster.js';
import { detectNotionStagedDir } from './detect.js';
import { fetchNotionSnapshot, type NotionFetchLogger } from './fetch.js';
import { NotionClient } from './notion-client.js';
import { parseNotionPullConfig } from './pull-config.js';
import { type NotionMetadata, notionManifestSchema, notionMetadataSchema } from './types.js';

interface NotionPullSucceededContext {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  trigger: IngestTrigger;
  completedAt: Date;
  stagedDir: string;
  nextSuccessfulCursor: string | null;
}

export interface NotionSourceAdapterDeps {
  onPullSucceeded?: (ctx: NotionPullSucceededContext) => Promise<void>;
  logger?: NotionFetchLogger;
}

export class NotionSourceAdapter implements SourceAdapter {
  readonly source = 'notion';
  readonly skillNames = ['notion_synthesize'];
  readonly reconcileSkillNames: string[] = [];
  readonly evidenceIndexing = 'documents' as const;
  readonly triageSupported = true;

  constructor(private readonly deps: NotionSourceAdapterDeps = {}) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectNotionStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, _ctx: FetchContext): Promise<void> {
    const config = parseNotionPullConfig(pullConfig);
    await fetchNotionSnapshot({
      client: new NotionClient(config.authToken),
      config,
      stagedDir,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkNotionStagedDir(stagedDir, diffSet);
  }

  clusterWorkUnits(ctx: ClusterWorkUnitsContext): Promise<WorkUnit[]> {
    return clusterNotionWorkUnits({
      workUnits: ctx.workUnits,
      stagedDir: ctx.stagedDir,
      embedding: ctx.embedding,
    });
  }

  describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    return describeNotionScope(stagedDir);
  }

  async getTriageSignals(stagedDir: string, externalId: string): Promise<TriageSignals> {
    const metadata = await this.findMetadataByExternalId(stagedDir, externalId);
    if (!metadata) {
      return {};
    }

    return {
      parentType: this.parentType(metadata),
      objectType: metadata.objectType,
      isDateTitled: this.isDateLikeTitle(metadata.title),
      lastEditedAt: metadata.lastEditedAt ?? undefined,
      propertyHints: this.propertyHints(metadata.properties),
    };
  }

  private async findMetadataByExternalId(stagedDir: string, externalId: string): Promise<NotionMetadata | null> {
    const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
    const metadataPaths = entries
      .filter((entry) => entry.isFile() && entry.name === 'metadata.json')
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();

    for (const metadataPath of metadataPaths) {
      const metadata = notionMetadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf-8')));
      if (metadata.id === externalId) {
        return metadata;
      }
    }

    return null;
  }

  private parentType(metadata: NotionMetadata): string {
    if (metadata.dataSourceId) {
      return 'data_source_id';
    }
    if (metadata.databaseId) {
      return 'database_id';
    }
    if (metadata.parentId) {
      return 'page_id';
    }
    return 'workspace';
  }

  private isDateLikeTitle(title: string): boolean {
    const trimmed = title.trim();
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
      /^\d{4}-\d{2}-\d{2}\b/.test(trimmed) ||
      /^\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(trimmed) ||
      (!Number.isNaN(Date.parse(trimmed)) && /\d{4}/.test(trimmed))
    );
  }

  private propertyHints(properties: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, value]) => {
          const hint = this.propertyHintValue(value);
          return hint === null ? [] : [[key, hint]];
        })
        .slice(0, 8),
    );
  }

  private propertyHintValue(value: unknown): string | null {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value === null) {
      return 'null';
    }
    return null;
  }

  async onPullSucceeded(ctx: {
    connectionId: string;
    sourceKey: string;
    syncId: string;
    trigger: IngestTrigger;
    completedAt: Date;
    stagedDir: string;
  }): Promise<void> {
    const manifest = notionManifestSchema.parse(
      JSON.parse(await readFile(join(ctx.stagedDir, 'manifest.json'), 'utf-8')),
    );
    await this.deps.onPullSucceeded?.({ ...ctx, nextSuccessfulCursor: manifest.nextSuccessfulCursor });
  }
}
