import type { KtxEmbeddingPort, KtxLogger } from '../core/index.js';
import { noopLogger } from '../core/index.js';
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
    private readonly embeddingService: KtxEmbeddingPort,
    private readonly slSourcesRepository: SlSourcesIndexPort,
    private readonly logger: KtxLogger = noopLogger,
  ) {}

  async indexSources(connectionId: string, sources: SemanticLayerSource[]): Promise<void> {
    if (sources.length === 0) {
      await this.slSourcesRepository.deleteByConnection(connectionId);
      return;
    }

    // Detect which sources actually changed by comparing search_text
    const existing = await this.slSourcesRepository.getExistingSearchTexts(connectionId);
    const searchTexts = sources.map((s) => this.buildSearchText(s));

    const changedIndices: number[] = [];
    for (let i = 0; i < sources.length; i++) {
      const prev = existing.get(sources[i].name);
      if (!prev || prev.searchText !== searchTexts[i] || !prev.hasEmbedding) {
        changedIndices.push(i);
      }
    }

    if (changedIndices.length === 0) {
      // Still clean up stale sources even if nothing changed
      const keepNames = sources.map((s) => s.name);
      await this.slSourcesRepository.deleteStale(connectionId, keepNames);
      this.logger.log(`SL sources for connection ${connectionId}: all ${sources.length} up to date, 0 reindexed`);
      return;
    }

    // Compute embeddings only for changed sources
    const changedTexts = changedIndices.map((i) => searchTexts[i]);
    let changedEmbeddings: (number[] | null)[];
    try {
      const batchSize = this.embeddingService.maxBatchSize;
      const allEmbeddings: number[][] = [];
      for (let i = 0; i < changedTexts.length; i += batchSize) {
        const batch = changedTexts.slice(i, i + batchSize);
        const batchEmbeddings = await this.embeddingService.computeEmbeddingsBulk(batch);
        allEmbeddings.push(...batchEmbeddings);
      }
      changedEmbeddings = allEmbeddings;
    } catch (error) {
      this.logger.warn(
        `Failed to compute SL source embeddings: ${error instanceof Error ? error.message : String(error)}`,
      );
      changedEmbeddings = changedIndices.map(() => null);
    }

    const rows = changedIndices.map((srcIdx, i) => {
      return {
        sourceName: sources[srcIdx].name,
        searchText: searchTexts[srcIdx],
        embedding: changedEmbeddings[i],
      };
    });

    await this.slSourcesRepository.upsertSources(connectionId, rows);

    // Remove sources that no longer exist in YAML
    const keepNames = sources.map((s) => s.name);
    await this.slSourcesRepository.deleteStale(connectionId, keepNames);

    this.logger.log(
      `SL sources for connection ${connectionId}: ${changedIndices.length}/${sources.length} reindexed, ${sources.length - changedIndices.length} unchanged`,
    );
  }

  async search(
    connectionId: string,
    query: string,
    limit = 15,
    minRrfScore = 0,
  ): Promise<Array<{ sourceName: string; score: number }>> {
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await this.embeddingService.computeEmbedding(query);
    } catch (error) {
      this.logger.warn(
        `Failed to compute query embedding, falling back to FTS + trigram: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const results = await this.slSourcesRepository.search(connectionId, queryEmbedding, query, limit, minRrfScore);
    return results.map((r) => ({ sourceName: r.sourceName, score: r.rrfScore }));
  }

  buildSearchText(source: SemanticLayerSource, priority: string[] = DEFAULT_PRIORITY): string {
    return buildSemanticLayerSourceSearchText(source, priority);
  }
}
