import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { noopLogger, type KtxLogger } from '../../../context/core/config.js';
import type { JsonValue } from '../ports.js';
import type { DiffSet } from '../types.js';
import type { ContextEvidenceIndexStorePort } from './store.js';
import type {
  ContextEvidenceEmbeddingPort,
  ContextEvidenceIndexSummary,
  ReplaceContextEvidenceChunk,
} from './types.js';

interface IndexStagedDirArgs {
  stagedDir: string;
  runId: string;
  connectionId: string;
  sourceKey: string;
  syncId: string;
  diffSet: DiffSet;
  currentHashes: Map<string, string>;
  forceRebuild?: boolean;
}

interface PublishSyncArgs {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  diffSet: DiffSet;
}

interface ContextEvidenceIndexServiceDeps {
  store: ContextEvidenceIndexStorePort;
  embeddings: ContextEvidenceEmbeddingPort;
  logger?: Pick<KtxLogger, 'warn'>;
}

type JsonObject = { [key: string]: JsonValue | undefined };

interface StagedEvidenceDocument {
  metadataPath: string;
  markdownPath: string;
  linksPath?: string;
  metadata: {
    objectType?: string;
    id?: string;
    title?: string;
    path?: string;
    url?: string | null;
    parentId?: string | null;
    databaseId?: string | null;
    dataSourceId?: string | null;
    lastEditedAt?: string | null;
    lastEditedBy?: string | null;
    properties?: JsonObject;
  };
  links?: JsonObject;
  markdown: string;
}

interface MarkdownChunk {
  headingPath: string[];
  content: string;
}

export class ContextEvidenceIndexService {
  private readonly store: ContextEvidenceIndexStorePort;
  private readonly embeddings: ContextEvidenceEmbeddingPort;
  private readonly logger: Pick<KtxLogger, 'warn'>;

  constructor(deps: ContextEvidenceIndexServiceDeps) {
    this.store = deps.store;
    this.embeddings = deps.embeddings;
    this.logger = deps.logger ?? noopLogger;
  }

  async indexStagedDir(args: IndexStagedDirArgs): Promise<ContextEvidenceIndexSummary> {
    const warnings: string[] = [];
    const documents = await this.collectDocuments(args.stagedDir, warnings);
    const indexablePaths = this.indexableDocumentPaths(args.diffSet);
    let documentsIndexed = 0;
    let chunksIndexed = 0;
    let embeddingFailures = 0;

    for (const staged of documents) {
      if (!args.forceRebuild && !this.shouldIndexDocument(args.stagedDir, staged, indexablePaths)) {
        continue;
      }

      const externalId = staged.metadata.id;
      const title = staged.metadata.title;
      const path = staged.metadata.path ?? title;

      if (!externalId || !title || !path) {
        warnings.push(`Skipped ${staged.metadataPath}: metadata requires id, title, and path`);
        continue;
      }

      const rawPath = this.toRawPath(args.stagedDir, staged.markdownPath);
      const contentHash = args.currentHashes.get(rawPath) ?? this.sha256(staged.markdown);
      const document = await this.store.upsertDocument({
        runId: args.runId,
        connectionId: args.connectionId,
        sourceKey: args.sourceKey,
        externalId,
        externalParentId: staged.metadata.parentId ?? null,
        databaseId: staged.metadata.databaseId ?? null,
        dataSourceId: staged.metadata.dataSourceId ?? null,
        title,
        path,
        url: staged.metadata.url ?? null,
        objectType: staged.metadata.objectType ?? 'page',
        lastEditedAt: staged.metadata.lastEditedAt ? new Date(staged.metadata.lastEditedAt) : null,
        lastEditedBy: staged.metadata.lastEditedBy ?? null,
        rawPath,
        syncId: args.syncId,
        contentHash,
        publishState: 'pending',
        metadata: {
          metadataPath: this.toRawPath(args.stagedDir, staged.metadataPath),
          ...(staged.linksPath && staged.links
            ? { linksPath: this.toRawPath(args.stagedDir, staged.linksPath), links: staged.links }
            : {}),
          properties: staged.metadata.properties ?? {},
        },
      });

      const chunks = this.buildChunks(staged.markdown, title);
      const searchTexts = chunks.map((chunk) => this.buildSearchText(staged, chunk));
      const embeddings = await this.computeEmbeddings(searchTexts);

      if (embeddings.failed) {
        embeddingFailures += 1;
      }

      const headingPathOccurrences = new Map<string, number>();
      const replaceChunks: ReplaceContextEvidenceChunk[] = chunks.map((chunk, ordinal) => {
        const headingLeaf = chunk.headingPath[chunk.headingPath.length - 1] ?? title;
        const headingSlug = this.slug(headingLeaf);
        const normalizedHeadingPath = this.normalizeHeadingPath(chunk.headingPath);
        const occurrence = (headingPathOccurrences.get(normalizedHeadingPath) ?? 0) + 1;
        headingPathOccurrences.set(normalizedHeadingPath, occurrence);

        return {
          chunkKey: `${this.headingLevelKey(chunk.headingPath)}:${headingSlug}:${String(ordinal).padStart(4, '0')}`,
          headingPath: chunk.headingPath,
          ordinal,
          content: chunk.content,
          searchText: searchTexts[ordinal],
          embedding: embeddings.values[ordinal] ?? null,
          tokenCount: this.estimateTokens(chunk.content),
          citation: {
            source: args.sourceKey,
            pageId: externalId,
            title,
            path,
            url: staged.metadata.url ?? null,
            lastEditedAt: staged.metadata.lastEditedAt ?? null,
            syncId: args.syncId,
            rawPath,
          },
          stableCitationKey: this.buildStableCitationKey(
            args.sourceKey,
            externalId,
            headingSlug,
            normalizedHeadingPath,
            occurrence,
          ),
          syncId: args.syncId,
          contentHash: this.sha256(chunk.content),
        };
      });

      await this.store.replaceChunks(document.id, replaceChunks);
      documentsIndexed += 1;
      chunksIndexed += replaceChunks.length;
    }

    const deletedMarkdownPaths = this.deletedMarkdownPaths(args.diffSet);
    const documentsDeleted = await this.store.countPublishedDocumentsByRawPaths(
      args.connectionId,
      args.sourceKey,
      deletedMarkdownPaths,
    );

    return { documentsIndexed, chunksIndexed, documentsDeleted, embeddingFailures, warnings };
  }

  async publishSync(args: PublishSyncArgs): Promise<{ documentsPublished: number; documentsDeleted: number }> {
    return this.store.publishSync(
      args.connectionId,
      args.sourceKey,
      args.syncId,
      this.deletedMarkdownPaths(args.diffSet),
    );
  }

  private async collectDocuments(stagedDir: string, warnings: string[]): Promise<StagedEvidenceDocument[]> {
    const metadataPaths = await this.findFiles(stagedDir, 'metadata.json');
    const documents: StagedEvidenceDocument[] = [];

    for (const metadataPath of metadataPaths) {
      const markdownPath = join(dirname(metadataPath), 'page.md');
      let markdown: string;

      try {
        markdown = await readFile(markdownPath, 'utf-8');
      } catch {
        continue;
      }

      try {
        const metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as StagedEvidenceDocument['metadata'];
        const linksPath = join(dirname(metadataPath), 'links.json');
        let links: JsonObject | undefined;
        try {
          const parsedLinks = JSON.parse(await readFile(linksPath, 'utf-8')) as unknown;
          if (parsedLinks && typeof parsedLinks === 'object' && !Array.isArray(parsedLinks)) {
            links = parsedLinks as JsonObject;
          }
        } catch {
          // links.json is optional.
        }
        documents.push({
          metadataPath,
          markdownPath,
          linksPath: links ? linksPath : undefined,
          metadata,
          links,
          markdown,
        });
      } catch (error) {
        warnings.push(
          `Skipped ${relative(stagedDir, metadataPath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return documents;
  }

  private async findFiles(root: string, fileName: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name === fileName)
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  }

  private indexableDocumentPaths(diffSet: DiffSet): Set<string> {
    return new Set([...diffSet.added, ...diffSet.modified]);
  }

  private shouldIndexDocument(stagedDir: string, staged: StagedEvidenceDocument, indexablePaths: Set<string>): boolean {
    return (
      indexablePaths.has(this.toRawPath(stagedDir, staged.markdownPath)) ||
      indexablePaths.has(this.toRawPath(stagedDir, staged.metadataPath)) ||
      (staged.linksPath ? indexablePaths.has(this.toRawPath(stagedDir, staged.linksPath)) : false)
    );
  }

  private deletedMarkdownPaths(diffSet: DiffSet): string[] {
    return diffSet.deleted.filter((path) => basename(path) === 'page.md');
  }

  private buildChunks(markdown: string, title: string): MarkdownChunk[] {
    const lines = markdown.split(/\r?\n/);
    const chunks: MarkdownChunk[] = [];
    let headingPath: string[] = [title];
    let currentLines: string[] = [];

    const flush = () => {
      const content = currentLines.join('\n').trim();

      if (content) {
        chunks.push({ headingPath: [...headingPath], content });
      }

      currentLines = [];
    };

    for (const line of lines) {
      const match = /^(#{1,6})\s+(.+)$/.exec(line);

      if (match) {
        flush();
        const level = match[1].length;
        const heading = match[2].trim();
        headingPath = level === 1 ? [heading] : [...headingPath.slice(0, level - 1), heading];
        continue;
      }

      currentLines.push(line);
    }

    flush();

    if (chunks.length === 0) {
      const content = markdown.trim();
      return content ? [{ headingPath: [title], content }] : [];
    }

    return this.splitLargeChunks(chunks);
  }

  private splitLargeChunks(chunks: MarkdownChunk[]): MarkdownChunk[] {
    const maxChars = 4800;
    const out: MarkdownChunk[] = [];

    const pushBounded = (chunk: MarkdownChunk, content: string): void => {
      for (let start = 0; start < content.length; start += maxChars) {
        const part = content.slice(start, start + maxChars).trim();
        if (part) {
          out.push({ ...chunk, content: part });
        }
      }
    };

    for (const chunk of chunks) {
      if (chunk.content.length <= maxChars) {
        out.push(chunk);
        continue;
      }

      const paragraphs = chunk.content.split(/\n{2,}/);
      let current = '';

      for (const paragraph of paragraphs) {
        if (paragraph.length > maxChars) {
          if (current) {
            out.push({ ...chunk, content: current });
            current = '';
          }
          pushBounded(chunk, paragraph);
          continue;
        }

        const next = current ? `${current}\n\n${paragraph}` : paragraph;

        if (next.length > maxChars && current) {
          out.push({ ...chunk, content: current });
          current = paragraph;
        } else {
          current = next;
        }
      }

      if (current) {
        out.push({ ...chunk, content: current });
      }
    }

    return out;
  }

  private buildSearchText(staged: StagedEvidenceDocument, chunk: MarkdownChunk): string {
    const properties = Object.entries(staged.metadata.properties ?? {})
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join('\n');

    return [staged.metadata.title, staged.metadata.path, chunk.headingPath.join(' / '), properties, chunk.content]
      .filter(Boolean)
      .join('\n');
  }

  private async computeEmbeddings(texts: string[]): Promise<{ values: Array<number[] | null>; failed: boolean }> {
    if (texts.length === 0) {
      return { values: [], failed: false };
    }

    const configuredMaxBatchSize = this.embeddings.maxBatchSize;
    const maxBatchSize: number =
      typeof configuredMaxBatchSize === 'number' &&
      Number.isInteger(configuredMaxBatchSize) &&
      configuredMaxBatchSize > 0
        ? configuredMaxBatchSize
        : 100;
    const values: Array<number[] | null> = [];
    let failed = false;

    for (let offset = 0; offset < texts.length; offset += maxBatchSize) {
      const batch = texts.slice(offset, offset + maxBatchSize);

      try {
        const batchEmbeddings = await this.embeddings.computeEmbeddingsBulk(batch);
        if (batchEmbeddings.length !== batch.length) {
          throw new Error(`expected ${batch.length} embeddings, received ${batchEmbeddings.length}`);
        }
        values.push(...batchEmbeddings);
      } catch (error) {
        failed = true;
        this.logger.warn(
          `Context evidence embeddings failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        values.push(...batch.map(() => null));
      }
    }

    return { values, failed };
  }

  private toRawPath(stagedDir: string, fullPath: string): string {
    return relative(stagedDir, fullPath).split('\\').join('/');
  }

  private headingLevelKey(headingPath: string[]): string {
    return `h${Math.min(Math.max(headingPath.length, 1), 6)}`;
  }

  private slug(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return slug || 'section';
  }

  private normalizeHeadingPath(headingPath: string[]): string {
    return headingPath
      .map((heading) => heading.trim().toLowerCase().replace(/\s+/g, ' '))
      .filter(Boolean)
      .join('/');
  }

  private buildStableCitationKey(
    sourceKey: string,
    externalId: string,
    headingSlug: string,
    normalizedHeadingPath: string,
    occurrence: number,
  ): string {
    const digest = this.sha256([sourceKey, externalId, normalizedHeadingPath, String(occurrence)].join('\0')).slice(
      0,
      16,
    );
    return `${sourceKey}:${externalId}:${headingSlug}:${digest}`;
  }

  private estimateTokens(value: string): number {
    return Math.ceil(value.split(/\s+/).filter(Boolean).length * 1.3);
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
