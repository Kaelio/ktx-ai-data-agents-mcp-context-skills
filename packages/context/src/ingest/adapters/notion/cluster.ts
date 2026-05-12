import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KtxEmbeddingPort } from '../../../core/embedding.js';
import { kmeans, pickK } from '../../clustering/kmeans.js';
import type { WorkUnit } from '../../types.js';
import { notionMetadataSchema } from './types.js';

export const MIN_PAGES_TO_CLUSTER = 5;
const CLUSTER_TEXT_BODY_CHARS = 1024;
const CLUSTER_SEED = 42;
const NOTION_CLUSTER_SL_WRITE_GUIDANCE =
  'Write wiki entries directly with wiki_write. Search existing wiki pages for the same tables or sl_refs before creating a new page. Only write or edit SL sources after sl_discover/sl_read_source confirms a mapped non-Notion target source; if no mapped target exists, emit_unmapped_fallback and keep the fact wiki-only. Notion dataSourceCount counts Notion databases/data sources only, not warehouse/dbt mappings. If a warehouse/dbt connection exists but the named table or source is absent, use reason no_physical_table rather than no_connection_mapping. Do not create SL sources under the Notion connection just because a page mentions a warehouse table.';

interface ClusterNotionWorkUnitsArgs {
  workUnits: WorkUnit[];
  stagedDir: string;
  embedding: KtxEmbeddingPort;
}

async function buildClusterText(wu: WorkUnit, stagedDir: string): Promise<string> {
  const metadataPath = wu.rawFiles.find((p) => p.endsWith('/metadata.json'));
  const pagePath = wu.rawFiles.find((p) => p.endsWith('/page.md'));
  let title = wu.displayLabel ?? wu.unitKey;
  if (metadataPath) {
    try {
      const raw = await readFile(join(stagedDir, metadataPath), 'utf-8');
      const md = notionMetadataSchema.parse(JSON.parse(raw));
      title = md.path || md.title || title;
    } catch {
      // fall through with displayLabel
    }
  }
  let body = '';
  if (pagePath) {
    try {
      const raw = await readFile(join(stagedDir, pagePath), 'utf-8');
      body = raw.slice(0, CLUSTER_TEXT_BODY_CHARS);
    } catch {
      // empty body OK
    }
  }
  const combined = `${title}\n\n${body}`.trim();
  return combined.length > 0 ? combined : title;
}

function mergeWorkUnits(bucket: WorkUnit[], clusterIndex: number): WorkUnit {
  const rawFiles = Array.from(new Set(bucket.flatMap((w) => w.rawFiles))).sort();
  const dependencyPaths = Array.from(new Set(bucket.flatMap((w) => w.dependencyPaths))).sort();
  const allFiles = new Set([...rawFiles, ...dependencyPaths]);
  const peerFileIndex = Array.from(
    new Set(bucket.flatMap((w) => w.peerFileIndex).filter((p) => !allFiles.has(p))),
  ).sort();
  const labels = bucket
    .map((w) => w.displayLabel ?? w.unitKey)
    .filter((label, i, arr) => arr.indexOf(label) === i)
    .slice(0, 5);
  const labelSummary = labels.join(', ');
  return {
    unitKey: `notion-cluster-${clusterIndex + 1}`,
    displayLabel: `Notion cluster ${clusterIndex + 1} (${bucket.length} pages: ${labelSummary})`,
    rawFiles,
    dependencyPaths,
    peerFileIndex,
    notes:
      `Synthesize durable wiki and SL knowledge from these ${bucket.length} related Notion pages. ` +
      'Read each page with read_raw_file (or read_raw_span for oversized pages). ' +
      'Search nearby evidence with context_evidence_search/_read/_neighbors when needed. ' +
      `${NOTION_CLUSTER_SL_WRITE_GUIDANCE} ` +
      'Do not call context_candidate_write.',
  };
}

export async function clusterNotionWorkUnits(args: ClusterNotionWorkUnitsArgs): Promise<WorkUnit[]> {
  const { workUnits, stagedDir, embedding } = args;
  if (workUnits.length < MIN_PAGES_TO_CLUSTER) return workUnits;
  const k = pickK(workUnits.length);
  if (k <= 1) return [mergeWorkUnits(workUnits, 0)];
  const texts = await Promise.all(workUnits.map((wu) => buildClusterText(wu, stagedDir)));
  let vectors: number[][];
  try {
    vectors = await embedding.computeEmbeddingsBulk(texts);
  } catch {
    return workUnits;
  }
  if (vectors.length !== workUnits.length) return workUnits;
  const { assignments } = kmeans(vectors, k, { seed: CLUSTER_SEED });
  const buckets: WorkUnit[][] = Array.from({ length: k }, () => []);
  workUnits.forEach((wu, i) => {
    buckets[assignments[i]].push(wu);
  });
  return buckets.filter((b) => b.length > 0).map((b, idx) => mergeWorkUnits(b, idx));
}
