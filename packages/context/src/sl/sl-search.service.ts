import type { KtxEmbeddingPort, KtxLogger } from '../core/index.js';
import { noopLogger } from '../core/index.js';
import type { ReindexWorkResult } from '../index-sync/types.js';
import { DEFAULT_PRIORITY, resolveDescription } from './descriptions.js';
import { normalizeSemanticLayerDescriptions } from './description-normalization.js';
import type { SlSourcesIndexPort } from './ports.js';
import type { SemanticLayerSource } from './types.js';

export function buildSemanticLayerSourceSearchText(
  source: SemanticLayerSource,
  priority: string[] = DEFAULT_PRIORITY,
): string {
  source = normalizeSemanticLayerDescriptions(source);
  const config = { priority };
  const parts: string[] = [source.name.replace(/_/g, ' ')];

  const sourceDesc = resolveDescription(source.descriptions, config);
  if (sourceDesc) {
    parts.push(sourceDesc);
  }

  if (source.table) {
    parts.push(`table: ${source.table}`);
  }

  if (source.default_time_dimension?.dbt) {
    parts.push(`dbt default time: ${source.default_time_dimension.dbt}`);
  }

  for (const col of source.columns ?? []) {
    const colDesc = resolveDescription(col.descriptions, config);
    let extra = '';
    if (col.enum_values?.dbt?.length) {
      extra += ` [dbt values: ${col.enum_values.dbt.join(', ')}]`;
    }
    if (col.constraints?.dbt?.not_null) {
      extra += ' not_null';
    }
    if (col.constraints?.dbt?.unique) {
      extra += ' unique';
    }
    parts.push(`${col.name} (${col.type})${colDesc ? ` ${colDesc}` : ''}${extra}`);
  }

  for (const m of source.measures ?? []) {
    parts.push(`measure: ${m.name} ${m.expr}${m.description ? ` ${m.description}` : ''}`);
  }

  for (const j of source.joins ?? []) {
    parts.push(`join: ${j.to} (${j.relationship})`);
  }

  if (source.tags?.dbt?.length) {
    parts.push(`dbt tags: ${source.tags.dbt.join(', ')}`);
  }

  if (source.freshness?.dbt) {
    const fd = source.freshness.dbt;
    const bits: string[] = [];
    if (fd.loaded_at_field) {
      bits.push(`loaded_at=${fd.loaded_at_field}`);
    }
    if (fd.raw !== undefined) {
      let rawStr = JSON.stringify(fd.raw);
      if (rawStr.length > 120) {
        rawStr = `${rawStr.slice(0, 117)}...`;
      }
      bits.push(rawStr);
    }
    if (bits.length > 0) {
      parts.push(`dbt freshness: ${bits.join(' ')}`);
    }
  }

  if (source.usage) {
    const usage = source.usage;
    parts.push(`usage: ${usage.narrative}`);
    parts.push(`frequency: ${usage.frequencyTier}`);
    if (usage.commonFilters.length > 0) {
      parts.push(`commonly filtered by: ${usage.commonFilters.join(', ')}`);
    }
    if (usage.commonGroupBys?.length) {
      parts.push(`commonly grouped by: ${usage.commonGroupBys.join(', ')}`);
    }
    for (const join of usage.commonJoins) {
      parts.push(`commonly joined to ${join.table} on ${join.on.join(',')}`);
    }
    if (usage.staleSince) {
      parts.push(`stale since ${usage.staleSince}`);
    }
  }

  return parts.join('. ');
}

export class SlSearchService {
  constructor(
    private readonly embeddingService: KtxEmbeddingPort | null,
    private readonly slSourcesRepository: SlSourcesIndexPort,
    private readonly logger: KtxLogger = noopLogger,
  ) {}

  async indexSources(connectionId: string, sources: SemanticLayerSource[]): Promise<ReindexWorkResult> {
    const existing = await this.slSourcesRepository.getExistingSearchTexts(connectionId);
    if (sources.length === 0) {
      const deleted = await this.slSourcesRepository.deleteByConnection(connectionId);
      return { scanned: 0, updated: 0, deleted, embeddingsRecomputed: 0, embeddingsFailed: 0 };
    }

    const searchTexts = sources.map((s) => this.buildSearchText(s));

    const changedIndices: number[] = [];
    for (let i = 0; i < sources.length; i += 1) {
      const previous = existing.get(sources[i]!.name);
      if (!previous || previous.searchText !== searchTexts[i] || !previous.hasEmbedding) {
        changedIndices.push(i);
      }
    }

    let changedEmbeddings: (number[] | null)[] = changedIndices.map(() => null);
    let embeddingsRecomputed = 0;
    let embeddingsFailed = 0;

    if (this.embeddingService && changedIndices.length > 0) {
      try {
        const changedTexts = changedIndices.map((index) => searchTexts[index]!);
        const allEmbeddings: number[][] = [];
        for (let i = 0; i < changedTexts.length; i += this.embeddingService.maxBatchSize) {
          const batch = changedTexts.slice(i, i + this.embeddingService.maxBatchSize);
          allEmbeddings.push(...(await this.embeddingService.computeEmbeddingsBulk(batch)));
        }
        changedEmbeddings = allEmbeddings;
        embeddingsRecomputed = allEmbeddings.length;
      } catch (error) {
        this.logger.warn(
          `Failed to compute SL source embeddings: ${error instanceof Error ? error.message : String(error)}`,
        );
        embeddingsFailed = changedIndices.length;
      }
    }

    const rows = changedIndices.map((sourceIndex, embeddingIndex) => ({
      sourceName: sources[sourceIndex]!.name,
      searchText: searchTexts[sourceIndex]!,
      embedding: changedEmbeddings[embeddingIndex] ?? null,
    }));
    await this.slSourcesRepository.upsertSources(connectionId, rows);

    const keepNames = sources.map((source) => source.name);
    const deleted = await this.slSourcesRepository.deleteStale(connectionId, keepNames);
    return {
      scanned: sources.length,
      updated: changedIndices.length,
      deleted,
      embeddingsRecomputed,
      embeddingsFailed,
    };
  }

  async search(
    connectionId: string,
    query: string,
    limit = 15,
    minRrfScore = 0,
  ): Promise<Array<{ sourceName: string; score: number; snippet?: string }>> {
    let queryEmbedding: number[] | null = null;
    if (this.embeddingService) {
      try {
        queryEmbedding = await this.embeddingService.computeEmbedding(query);
      } catch (error) {
        this.logger.warn(
          `Failed to compute query embedding, falling back to FTS + trigram: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const results = await this.slSourcesRepository.search(connectionId, queryEmbedding, query, limit, minRrfScore);
    return results.map((result) => ({
      sourceName: result.sourceName,
      score: result.rrfScore,
      ...(result.snippet ? { snippet: result.snippet } : {}),
    }));
  }

  buildSearchText(source: SemanticLayerSource, priority: string[] = DEFAULT_PRIORITY): string {
    return buildSemanticLayerSourceSearchText(source, priority);
  }
}
