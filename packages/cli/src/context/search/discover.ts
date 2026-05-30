import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import type { KtxScanReport, KtxSchemaColumn, KtxSchemaTable, KtxTableRef } from '../../context/scan/types.js';
import { DEFAULT_PRIORITY, resolveDescription } from '../../context/sl/descriptions.js';
import { loadLocalSlSourceRecords } from '../../context/sl/local-sl.js';
import { readLocalKnowledgePage, searchLocalKnowledgePages } from '../wiki/local-knowledge.js';
import { HybridSearchCore } from '../../context/search/hybrid-search-core.js';
import type { FusedSearchCandidate, SearchCandidateGenerator } from '../../context/search/types.js';

type KtxDiscoverDataKind = 'wiki' | 'sl_source' | 'sl_measure' | 'sl_dimension' | 'table' | 'column';
type KtxDiscoverDataMatchedOn = 'name' | 'display' | 'description' | 'comment' | 'expr' | 'sample_value' | 'body';

export interface KtxDiscoverDataInput {
  query: string;
  connectionId?: string;
  kinds?: KtxDiscoverDataKind[];
  limit?: number;
}

interface KtxDiscoverDataRef {
  kind: KtxDiscoverDataKind;
  id: string;
  score: number;
  summary: string | null;
  snippet: string | null;
  matchedOn: KtxDiscoverDataMatchedOn;
  connectionId?: string;
  tableRef?: KtxTableRef;
  columnName?: string;
}

export type KtxDiscoverDataResponse = KtxDiscoverDataRef[];

export interface KtxDiscoverDataServiceOptions {
  userId?: string;
  embeddingService?: KtxEmbeddingPort | null;
}

interface CandidateRecord {
  ref: Omit<KtxDiscoverDataRef, 'score'>;
  rankScore: number;
}

type RawTable = KtxSchemaTable & {
  descriptions?: Record<string, string>;
  columns: Array<KtxSchemaColumn & { descriptions?: Record<string, string>; sampleValues?: unknown[] }>;
};

interface LatestScan {
  report: KtxScanReport;
  rawSourcesDir: string;
  tables: RawTable[];
}

const ALL_KINDS: KtxDiscoverDataKind[] = ['wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column'];

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
}

function hasKind(kinds: ReadonlySet<KtxDiscoverDataKind>, kind: KtxDiscoverDataKind): boolean {
  return kinds.has(kind);
}

function cap200(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 200 ? compact.slice(0, 200) : compact;
}

function snippetAround(text: string | null | undefined, terms: readonly string[]): string | null {
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  const index =
    terms
      .map((term) => lower.indexOf(term))
      .filter((position) => position >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  return cap200(text.slice(Math.max(0, index - 60), index + 140));
}

function textScore(value: string | null | undefined, terms: readonly string[]): number {
  const haystack = normalize(value);
  if (!haystack || terms.length === 0) {
    return 0;
  }
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched / terms.length;
}

function bestField(
  fields: Array<{ matchedOn: KtxDiscoverDataMatchedOn; text: string | null | undefined; weight: number }>,
  terms: readonly string[],
): { matchedOn: KtxDiscoverDataMatchedOn; score: number; text: string | null } | null {
  const scored = fields
    .map((field) => ({
      matchedOn: field.matchedOn,
      score: textScore(field.text, terms) * field.weight,
      text: field.text ?? null,
    }))
    .filter((field) => field.score > 0)
    .sort((left, right) => right.score - left.score || left.matchedOn.localeCompare(right.matchedOn));
  return scored[0] ?? null;
}

function displayForTable(table: KtxTableRef): string {
  return [table.catalog, table.db, table.name].filter((part): part is string => Boolean(part)).join('.');
}

function tableRef(table: KtxSchemaTable): KtxTableRef {
  return { catalog: table.catalog, db: table.db, name: table.name };
}

async function readJson<T>(project: KtxLocalProject, path: string): Promise<T> {
  return JSON.parse((await project.fileStore.readFile(path)).content) as T;
}

async function latestScan(project: KtxLocalProject, connectionId: string): Promise<LatestScan | null> {
  const root = `raw-sources/${connectionId}/live-database`;
  let files: string[];
  try {
    files = (await project.fileStore.listFiles(root)).files;
  } catch {
    return null;
  }

  const reportPath = files
    .filter((path) => path.endsWith('/scan-report.json'))
    .sort()
    .at(-1);
  if (!reportPath) {
    return null;
  }
  const report = await readJson<KtxScanReport>(project, reportPath);
  const rawSourcesDir = report.artifactPaths.rawSourcesDir ?? reportPath.slice(0, -'/scan-report.json'.length);
  const listedTables = await project.fileStore.listFiles(`${rawSourcesDir}/tables`);
  const tables: RawTable[] = [];
  for (const path of listedTables.files.filter((file) => file.endsWith('.json')).sort()) {
    tables.push(await readJson<RawTable>(project, path));
  }
  return { report, rawSourcesDir, tables };
}

function configuredConnectionIds(project: KtxLocalProject, connectionId?: string): string[] {
  return connectionId ? [connectionId] : Object.keys(project.config.connections).sort();
}

async function wikiCandidates(
  project: KtxLocalProject,
  input: KtxDiscoverDataInput,
  options: KtxDiscoverDataServiceOptions,
  terms: readonly string[],
): Promise<CandidateRecord[]> {
  const searchResults = await searchLocalKnowledgePages(project, {
    query: input.query,
    userId: options.userId,
    embeddingService: options.embeddingService ?? null,
    limit: Math.max(input.limit ?? 10, 25),
  });
  const records: CandidateRecord[] = [];
  for (const result of searchResults) {
    const page = await readLocalKnowledgePage(project, { key: result.key, userId: options.userId });
    const content = page?.content ?? '';
    const matched = bestField(
      [
        { matchedOn: 'name', text: result.key, weight: 1.1 },
        { matchedOn: 'description', text: result.summary, weight: 1 },
        { matchedOn: 'body', text: content, weight: 0.8 },
      ],
      terms,
    );
    records.push({
      rankScore: result.score + (matched?.score ?? 0),
      ref: {
        kind: 'wiki',
        id: result.key,
        summary: result.summary || null,
        snippet: snippetAround(content, terms),
        matchedOn: matched?.matchedOn ?? 'body',
      },
    });
  }
  return records.sort((left, right) => right.rankScore - left.rankScore || left.ref.id.localeCompare(right.ref.id));
}

async function slCandidates(
  project: KtxLocalProject,
  input: KtxDiscoverDataInput,
  kinds: ReadonlySet<KtxDiscoverDataKind>,
  terms: readonly string[],
): Promise<CandidateRecord[]> {
  const records: CandidateRecord[] = [];
  for (const connectionId of configuredConnectionIds(project, input.connectionId)) {
    const sources = await loadLocalSlSourceRecords(project, { connectionId }).catch(() => []);
    for (const sourceRecord of sources) {
      const source = sourceRecord.source;
      if (hasKind(kinds, 'sl_source')) {
        const description = resolveDescription(source.descriptions, { priority: DEFAULT_PRIORITY });
        const matched = bestField(
          [
            { matchedOn: 'name', text: source.name, weight: 1.2 },
            { matchedOn: 'description', text: description, weight: 1 },
            { matchedOn: 'display', text: source.table ?? source.sql ?? null, weight: 0.8 },
          ],
          terms,
        );
        if (matched) {
          records.push({
            rankScore: matched.score,
            ref: {
              kind: 'sl_source',
              id: source.name,
              connectionId,
              summary: description,
              snippet:
                matched.matchedOn === 'description'
                  ? snippetAround(description, terms)
                  : cap200(
                      `${source.name}: ${[
                        ...source.measures.map((measure) => measure.name),
                        ...source.columns.map((column) => column.name),
                      ]
                        .slice(0, 3)
                        .join(', ')}`,
                    ),
              matchedOn: matched.matchedOn,
            },
          });
        }
      }

      if (hasKind(kinds, 'sl_measure')) {
        for (const measure of source.measures) {
          const matched = bestField(
            [
              { matchedOn: 'name', text: measure.name, weight: 1.2 },
              { matchedOn: 'description', text: measure.description, weight: 1 },
              { matchedOn: 'expr', text: measure.expr, weight: 0.9 },
            ],
            terms,
          );
          if (matched) {
            records.push({
              rankScore: matched.score,
              ref: {
                kind: 'sl_measure',
                id: `${source.name}.${measure.name}`,
                connectionId,
                summary: measure.description ?? null,
                snippet: cap200(measure.expr),
                matchedOn: matched.matchedOn,
              },
            });
          }
        }
      }

      if (hasKind(kinds, 'sl_dimension')) {
        for (const column of source.columns) {
          const description = resolveDescription(column.descriptions, { priority: DEFAULT_PRIORITY });
          const matched = bestField(
            [
              { matchedOn: 'name', text: column.name, weight: 1.2 },
              { matchedOn: 'display', text: `${source.name}.${column.name}`, weight: 1.1 },
              { matchedOn: 'description', text: description, weight: 1 },
              { matchedOn: 'expr', text: column.expr, weight: 0.9 },
            ],
            terms,
          );
          if (matched) {
            records.push({
              rankScore: matched.score,
              ref: {
                kind: 'sl_dimension',
                id: `${source.name}.${column.name}`,
                connectionId,
                summary: description,
                snippet: cap200(`${column.name} (${column.type})`),
                matchedOn: matched.matchedOn,
              },
            });
          }
        }
      }
    }
  }
  return records.sort((left, right) => right.rankScore - left.rankScore || left.ref.id.localeCompare(right.ref.id));
}

async function rawCandidates(
  project: KtxLocalProject,
  input: KtxDiscoverDataInput,
  kinds: ReadonlySet<KtxDiscoverDataKind>,
  terms: readonly string[],
): Promise<CandidateRecord[]> {
  const records: CandidateRecord[] = [];
  for (const connectionId of configuredConnectionIds(project, input.connectionId)) {
    const scan = await latestScan(project, connectionId);
    if (!scan) {
      continue;
    }
    for (const table of scan.tables) {
      const ref = tableRef(table);
      const display = displayForTable(ref);
      const tableDescription = resolveDescription(table.descriptions, { priority: DEFAULT_PRIORITY }) ?? table.comment;
      if (hasKind(kinds, 'table')) {
        const matched = bestField(
          [
            { matchedOn: 'name', text: table.name, weight: 1.2 },
            { matchedOn: 'display', text: display, weight: 1.1 },
            { matchedOn: 'description', text: tableDescription, weight: 1 },
            { matchedOn: 'comment', text: table.comment, weight: 1 },
          ],
          terms,
        );
        if (matched) {
          records.push({
            rankScore: matched.score,
            ref: {
              kind: 'table',
              id: display,
              connectionId,
              tableRef: ref,
              summary: tableDescription,
              snippet:
                matched.matchedOn === 'description' || matched.matchedOn === 'comment'
                  ? snippetAround(matched.text, terms)
                  : cap200(table.columns.slice(0, 5).map((column) => column.name).join(', ')),
              matchedOn: matched.matchedOn,
            },
          });
        }
      }

      if (hasKind(kinds, 'column')) {
        for (const column of table.columns) {
          const columnDescription = resolveDescription(column.descriptions, { priority: DEFAULT_PRIORITY }) ?? column.comment;
          const samples = (column.sampleValues ?? []).map((value) => String(value)).slice(0, 5);
          const matched = bestField(
            [
              { matchedOn: 'name', text: column.name, weight: 1.2 },
              { matchedOn: 'display', text: `${display}.${column.name}`, weight: 1.1 },
              { matchedOn: 'description', text: columnDescription, weight: 1 },
              { matchedOn: 'comment', text: column.comment, weight: 1 },
              { matchedOn: 'sample_value', text: samples.join(' '), weight: 1.3 },
            ],
            terms,
          );
          if (matched) {
            records.push({
              rankScore: matched.score,
              ref: {
                kind: 'column',
                id: `${display}.${column.name}`,
                connectionId,
                tableRef: ref,
                columnName: column.name,
                summary: columnDescription,
                snippet:
                  matched.matchedOn === 'sample_value'
                    ? cap200(`${column.nativeType} - samples: ${samples.join(', ')}`)
                    : matched.matchedOn === 'description' || matched.matchedOn === 'comment'
                      ? snippetAround(matched.text, terms)
                      : cap200(column.nativeType),
                matchedOn: matched.matchedOn,
              },
            });
          }
        }
      }
    }
  }
  return records.sort((left, right) => right.rankScore - left.rankScore || left.ref.id.localeCompare(right.ref.id));
}

function generator(
  name: string,
  candidates: CandidateRecord[],
  refsByKey: Map<string, Omit<KtxDiscoverDataRef, 'score'>>,
): SearchCandidateGenerator {
  candidates.forEach((candidate) =>
    refsByKey.set(`${candidate.ref.kind}:${candidate.ref.connectionId ?? ''}:${candidate.ref.id}`, candidate.ref),
  );
  return {
    lane: name,
    weight: 1,
    async generate() {
      return {
        candidates: candidates.map((candidate, index) => ({
          id: `${candidate.ref.kind}:${candidate.ref.connectionId ?? ''}:${candidate.ref.id}`,
          rank: index + 1,
          rawScore: candidate.rankScore,
        })),
      };
    },
  };
}

function hydrate(
  fused: FusedSearchCandidate[],
  refsByKey: Map<string, Omit<KtxDiscoverDataRef, 'score'>>,
): KtxDiscoverDataRef[] {
  const maxScore = Math.max(...fused.map((candidate) => candidate.score), 0);
  return fused
    .map((candidate) => {
      const ref = refsByKey.get(candidate.id);
      if (!ref) {
        return null;
      }
      return {
        ...ref,
        // 3 decimals is plenty for a relative-rank hint; 6 just spent bytes on noise.
        score: maxScore > 0 ? Number((candidate.score / maxScore).toFixed(3)) : 0,
      };
    })
    .filter((result): result is KtxDiscoverDataRef => result !== null);
}

export function createKtxDiscoverDataService(
  project: KtxLocalProject,
  options: KtxDiscoverDataServiceOptions = {},
): { search(input: KtxDiscoverDataInput): Promise<KtxDiscoverDataResponse> } {
  return {
    async search(input) {
      const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
      const query = input.query.trim();
      if (!query) {
        return [];
      }
      const kinds = new Set(input.kinds ?? ALL_KINDS);
      const terms = queryTerms(query);
      const refsByKey = new Map<string, Omit<KtxDiscoverDataRef, 'score'>>();
      const generators: SearchCandidateGenerator[] = [];

      if (hasKind(kinds, 'wiki')) {
        generators.push(generator('wiki', await wikiCandidates(project, { ...input, limit }, options, terms), refsByKey));
      }
      if (hasKind(kinds, 'sl_source') || hasKind(kinds, 'sl_measure') || hasKind(kinds, 'sl_dimension')) {
        generators.push(generator('semantic_layer', await slCandidates(project, { ...input, limit }, kinds, terms), refsByKey));
      }
      if (hasKind(kinds, 'table') || hasKind(kinds, 'column')) {
        generators.push(generator('raw_schema', await rawCandidates(project, { ...input, limit }, kinds, terms), refsByKey));
      }
      if (generators.length === 0) {
        return [];
      }

      const result = await new HybridSearchCore().search({
        queryText: query,
        limit,
        generators,
        laneWeights: { wiki: 1, semantic_layer: 1, raw_schema: 1 },
      });
      return hydrate(result.results, refsByKey);
    },
  };
}
