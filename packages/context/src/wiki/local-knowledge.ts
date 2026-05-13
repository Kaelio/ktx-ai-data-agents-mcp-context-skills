import { join } from 'node:path';
import YAML from 'yaml';
import type { KtxEmbeddingPort, KtxFileWriteResult } from '../core/index.js';
import type { KtxLocalProject } from '../project/index.js';
import { HybridSearchCore, type SearchCandidateGenerator } from '../search/index.js';
import { buildKnowledgeSearchText } from './knowledge-search-text.js';
import { assertFlatWikiKey, isFlatWikiKey } from './keys.js';
import { SqliteKnowledgeIndex, type SqliteKnowledgeIndexPage } from './sqlite-knowledge-index.js';
import type { HistoricSqlWikiUsageFrontmatter, WikiSearchLaneSummary, WikiSearchMatchReason } from './types.js';

export type LocalKnowledgeScope = 'GLOBAL' | 'USER';

export interface LocalKnowledgePage {
  key: string;
  path: string;
  scope: LocalKnowledgeScope;
  summary: string;
  content: string;
  tags: string[];
  refs: string[];
  slRefs: string[];
}

export interface LocalKnowledgeSummary {
  key: string;
  path: string;
  scope: LocalKnowledgeScope;
  summary: string;
}

export interface LocalKnowledgeSearchResult extends LocalKnowledgeSummary {
  score: number;
  matchReasons: WikiSearchMatchReason[];
  lanes?: WikiSearchLaneSummary[];
}

export interface WriteLocalKnowledgePageInput {
  key: string;
  scope: LocalKnowledgeScope;
  userId?: string;
  summary: string;
  content: string;
  tags?: string[];
  refs?: string[];
  slRefs?: string[];
  source?: string;
  intent?: string;
  tables?: string[];
  representativeSql?: string;
  usage?: HistoricSqlWikiUsageFrontmatter;
  fingerprints?: string[];
}

const LOCAL_AUTHOR = 'ktx';
const LOCAL_AUTHOR_EMAIL = 'ktx@example.com';

function assertSafePathToken(kind: string, value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes('..') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.includes('//')
  ) {
    throw new Error(`Unsafe ${kind}: ${value}`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function knowledgePath(scope: LocalKnowledgeScope, userId: string | undefined, key: string): string {
  const safeKey = assertFlatWikiKey(key);
  if (scope === 'GLOBAL') {
    return `knowledge/global/${safeKey}.md`;
  }
  return `knowledge/user/${assertSafePathToken('user id', userId ?? 'local')}/${safeKey}.md`;
}

function keyFromKnowledgePath(path: string, scope: LocalKnowledgeScope, userId: string): string | null {
  const prefix = scope === 'GLOBAL' ? 'knowledge/global/' : `knowledge/user/${assertSafePathToken('user id', userId)}/`;
  const key = path.slice(prefix.length).replace(/\.md$/, '');
  if (isFlatWikiKey(key)) {
    return key;
  }
  return null;
}

function parseKnowledgePage(key: string, path: string, scope: LocalKnowledgeScope, raw: string): LocalKnowledgePage {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      key,
      path,
      scope,
      summary: '',
      content: raw.trim(),
      tags: [],
      refs: [],
      slRefs: [],
    };
  }

  const frontmatter = (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
  return {
    key,
    path,
    scope,
    summary: typeof frontmatter.summary === 'string' ? frontmatter.summary : '',
    content: match[2].trim(),
    tags: stringArray(frontmatter.tags),
    refs: stringArray(frontmatter.refs),
    slRefs: stringArray(frontmatter.sl_refs),
  };
}

function serializeKnowledgePage(input: WriteLocalKnowledgePageInput): string {
  const frontmatter = {
    summary: input.summary,
    tags: input.tags ?? [],
    refs: input.refs ?? [],
    sl_refs: input.slRefs ?? [],
    usage_mode: 'auto',
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.tables === undefined ? {} : { tables: input.tables }),
    ...(input.representativeSql === undefined ? {} : { representative_sql: input.representativeSql }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.fingerprints === undefined ? {} : { fingerprints: input.fingerprints }),
  };
  return `---\n${YAML.stringify(frontmatter, { indent: 2, lineWidth: 0 }).trimEnd()}\n---\n\n${input.content.trim()}\n`;
}

async function readPageAtPath(
  project: KtxLocalProject,
  key: string,
  path: string,
  scope: LocalKnowledgeScope,
): Promise<LocalKnowledgePage | null> {
  try {
    const result = await project.fileStore.readFile(path);
    return parseKnowledgePage(key, path, scope, result.content);
  } catch {
    return null;
  }
}

export async function writeLocalKnowledgePage(
  project: KtxLocalProject,
  input: WriteLocalKnowledgePageInput,
): Promise<KtxFileWriteResult> {
  const path = knowledgePath(input.scope, input.userId, input.key);
  return project.fileStore.writeFile(
    path,
    serializeKnowledgePage(input),
    LOCAL_AUTHOR,
    LOCAL_AUTHOR_EMAIL,
    `Write knowledge page: ${input.key}`,
  );
}

export async function readLocalKnowledgePage(
  project: KtxLocalProject,
  input: { key: string; userId?: string },
): Promise<LocalKnowledgePage | null> {
  const userPath = knowledgePath('USER', input.userId, input.key);
  const userPage = await readPageAtPath(project, input.key, userPath, 'USER');
  if (userPage) {
    return userPage;
  }
  return readPageAtPath(project, input.key, knowledgePath('GLOBAL', undefined, input.key), 'GLOBAL');
}

export async function listLocalKnowledgePages(
  project: KtxLocalProject,
  input: { userId?: string } = {},
): Promise<LocalKnowledgeSummary[]> {
  const userId = input.userId ?? 'local';
  const pages: LocalKnowledgeSummary[] = [];
  for (const scope of ['GLOBAL', 'USER'] as const) {
    const root = scope === 'GLOBAL' ? 'knowledge/global' : `knowledge/user/${assertSafePathToken('user id', userId)}`;
    const listed = await project.fileStore.listFiles(root);
    for (const path of listed.files.filter((file) => file.endsWith('.md')).sort()) {
      const key = keyFromKnowledgePath(path, scope, userId);
      if (!key) {
        continue;
      }
      const page = await readPageAtPath(project, key, path, scope);
      if (page) {
        pages.push({ key, path, scope, summary: page.summary });
      }
    }
  }
  return pages.sort((left, right) => left.path.localeCompare(right.path));
}

function scorePage(page: LocalKnowledgePage, terms: string[]): number {
  const haystack = buildKnowledgeSearchText(page.key, page.summary, page.content, page.tags).toLowerCase();
  return terms.some((term) => haystack.includes(term)) ? 3 : 0;
}

function sqliteKnowledgeDbPath(project: KtxLocalProject): string {
  return join(project.projectDir, '.ktx', 'db.sqlite');
}

function pageSearchText(page: LocalKnowledgePage): string {
  return buildKnowledgeSearchText(page.key, page.summary, page.content, page.tags);
}

async function embeddingForPageSearchText(
  searchText: string,
  embeddingService: KtxEmbeddingPort | null,
): Promise<number[] | null> {
  if (!embeddingService) {
    return null;
  }
  return embeddingService.computeEmbedding(searchText);
}

function tokenLaneCandidates(pages: LocalKnowledgePage[], terms: string[]) {
  if (terms.length === 0) {
    return [];
  }
  return pages
    .map((page) => {
      const haystack = pageSearchText(page).toLowerCase();
      const matched = terms.filter((term) => haystack.includes(term)).length;
      return { page, score: matched / terms.length };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.page.path.localeCompare(right.page.path));
}

async function loadAllKnowledgePages(
  project: KtxLocalProject,
  input: { userId?: string } = {},
): Promise<LocalKnowledgePage[]> {
  const summaries = await listLocalKnowledgePages(project, { userId: input.userId });
  const pages: LocalKnowledgePage[] = [];
  for (const summary of summaries) {
    const page = await readPageAtPath(project, summary.key, summary.path, summary.scope);
    if (page) {
      pages.push(page);
    }
  }
  return pages;
}

async function searchLocalKnowledgePagesWithSqlite(
  project: KtxLocalProject,
  input: { query: string; userId?: string; embeddingService?: KtxEmbeddingPort | null; limit?: number },
): Promise<LocalKnowledgeSearchResult[]> {
  const pages = await loadAllKnowledgePages(project, { userId: input.userId });
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const embeddingService = input.embeddingService ?? null;
  const index = new SqliteKnowledgeIndex({ dbPath: sqliteKnowledgeDbPath(project) });
  const existingPages = index.getExistingPages();
  const indexPages: SqliteKnowledgeIndexPage[] = [];
  for (const page of pages) {
    const searchText = pageSearchText(page);
    const existing = existingPages.get(page.path);
    const embedding =
      existing?.searchText === searchText && existing.embedding
        ? existing.embedding
        : await embeddingForPageSearchText(searchText, embeddingService).catch(() => null);
    indexPages.push({
      path: page.path,
      key: page.key,
      scope: page.scope,
      summary: page.summary,
      content: page.content,
      tags: page.tags,
      embedding,
    });
  }

  index.sync(indexPages);

  const finalLimit = input.limit ?? Math.max(1, indexPages.length);
  const core = new HybridSearchCore();
  const generators: SearchCandidateGenerator[] = [
    {
      lane: 'lexical',
      async generate(args) {
        const rows = index.searchLexicalCandidates({
          queryText: args.queryText,
          limit: args.laneCandidatePoolLimit,
        });
        return {
          candidates: rows.map((row) => ({ id: row.id, rank: row.rank, rawScore: row.rawScore })),
        };
      },
    },
    {
      lane: 'token',
      async generate(args) {
        const rows = tokenLaneCandidates(pages, args.normalizedQuery.terms).slice(0, args.laneCandidatePoolLimit);
        return {
          candidates: rows.map((row, index) => ({
            id: row.page.path,
            rank: index + 1,
            rawScore: row.score,
          })),
        };
      },
    },
    {
      lane: 'semantic',
      async generate(args) {
        if (!embeddingService) {
          return { status: 'skipped', candidates: [], reason: 'embedding_unconfigured' };
        }
        try {
          const queryEmbedding = await embeddingService.computeEmbedding(args.queryText);
          const rows = index.searchSemanticCandidates({
            queryEmbedding,
            limit: args.laneCandidatePoolLimit,
          });
          return {
            candidates: rows.map((row) => ({ id: row.id, rank: row.rank, rawScore: row.rawScore })),
          };
        } catch (error) {
          return {
            status: 'skipped',
            candidates: [],
            reason: `embedding_unhealthy:${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
  ];

  const result = await core.search({ queryText: input.query, limit: finalLimit, generators });
  return result.results
    .map((fused): LocalKnowledgeSearchResult | null => {
      const page = byPath.get(fused.id);
      return page
        ? {
            key: page.key,
            path: page.path,
            scope: page.scope,
            summary: page.summary,
            score: fused.score,
            matchReasons: fused.matchReasons as WikiSearchMatchReason[],
            lanes: result.lanes,
          }
        : null;
    })
    .filter((result): result is LocalKnowledgeSearchResult => result !== null);
}

async function searchLocalKnowledgePagesWithScan(
  project: KtxLocalProject,
  input: { query: string; userId?: string; limit?: number },
): Promise<LocalKnowledgeSearchResult[]> {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const pages = await loadAllKnowledgePages(project, { userId: input.userId });
  const results: LocalKnowledgeSearchResult[] = [];
  for (const page of pages) {
    const score = scorePage(page, terms);
    if (score > 0) {
      results.push({
        key: page.key,
        path: page.path,
        scope: page.scope,
        summary: page.summary,
        score,
        matchReasons: ['token' as const],
      });
    }
  }
  return results
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, input.limit ?? results.length);
}

export async function searchLocalKnowledgePages(
  project: KtxLocalProject,
  input: { query: string; userId?: string; embeddingService?: KtxEmbeddingPort | null; limit?: number },
): Promise<LocalKnowledgeSearchResult[]> {
  if (project.config.storage.search === 'sqlite-fts5') {
    return searchLocalKnowledgePagesWithSqlite(project, input);
  }
  return searchLocalKnowledgePagesWithScan(project, input);
}
