import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import YAML from 'yaml';
import type { MemoryAction } from '../../../../context/memory/types.js';
import { rawSourcesDirForSync } from '../../raw-sources-paths.js';
import type { FinalizationOverrideReplay } from '../../types.js';
import { mergeUsagePreservingExternal } from '../live-database/manifest.js';
import { historicSqlEvidenceEnvelopeSchema, type HistoricSqlEvidenceEnvelope } from './evidence.js';
import type { TableUsageOutput } from './skill-schemas.js';
import { stagedManifestSchema } from './types.js';

export interface HistoricSqlProjectionInput {
  workdir: string;
  connectionId: string;
  syncId: string;
  runId: string;
  overrideReplay?: FinalizationOverrideReplay;
}

export interface HistoricSqlProjectionResult {
  tableUsageMerged: number;
  staleTablesMarked: number;
  patternPagesWritten: number;
  stalePatternPagesMarked: number;
  archivedPatternPages: number;
  touchedSources: Array<{ connectionId: string; sourceName: string }>;
  changedWikiPageKeys: string[];
  actions: MemoryAction[];
  warnings: string[];
}

interface ManifestShard {
  tables?: Record<string, { table?: string; usage?: Record<string, unknown>; columns?: unknown[]; [key: string]: unknown }>;
}

interface HistoricSqlPatternPage {
  key: string;
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

function safeKnowledgeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        result.push(relative(root, absolute).replace(/\\/g, '/'));
      }
    }
  }
  await visit(root);
  return result.sort();
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8')) as unknown;
}

async function writeYamlAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, YAML.stringify(value, { indent: 2, lineWidth: 0, version: '1.1' }), 'utf-8');
  await rename(tmp, path);
}

function tableSourceName(tableRef: string): string {
  return tableRef.split('.').filter(Boolean).at(-1) ?? tableRef;
}

function staleUsage(fetchedAt: string) {
  return {
    narrative: 'No recent historic SQL usage was observed in the latest snapshot.',
    frequencyTier: 'unused' as const,
    commonFilters: [],
    commonGroupBys: [],
    commonJoins: [],
    staleSince: fetchedAt,
  };
}

async function loadEvidence(workdir: string, runId: string): Promise<HistoricSqlEvidenceEnvelope[]> {
  const root = join(workdir, '.ktx/ingest-evidence/historic-sql', runId);
  const files = await walkFiles(root);
  const evidence: HistoricSqlEvidenceEnvelope[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith('.json'))) {
    evidence.push(historicSqlEvidenceEnvelopeSchema.parse(await readJson(join(root, file))));
  }
  return evidence;
}

function renderPatternMarkdown(pattern: HistoricSqlEvidenceEnvelope & { kind: 'pattern' }): string {
  return [
    `# ${pattern.pattern.title}`,
    '',
    pattern.pattern.narrative,
    '',
    '## Representative SQL',
    '',
    '```sql',
    pattern.pattern.definitionSql,
    '```',
    '',
    '## Tables',
    '',
    ...pattern.pattern.tablesInvolved.map((table) => `- ${table}`),
    '',
    '## Constituent Templates',
    '',
    ...pattern.pattern.constituentTemplateIds.map((id) => `- ${id}`),
    '',
  ].join('\n');
}

function overlapRatio(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  const intersection = left.filter((value) => rightSet.has(value)).length;
  return left.length === 0 ? 0 : intersection / left.length;
}

function parseMarkdownPage(key: string, path: string, raw: string): HistoricSqlPatternPage | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return {
    key,
    path,
    frontmatter: (YAML.parse(match[1] ?? '') ?? {}) as Record<string, unknown>,
    content: match[2] ?? '',
  };
}

function isHistoricPatternPage(page: HistoricSqlPatternPage): boolean {
  const tags = Array.isArray(page.frontmatter.tags) ? page.frontmatter.tags : [];
  return (
    page.frontmatter.source === 'historic-sql' &&
    tags.includes('historic-sql') &&
    tags.includes('pattern')
  );
}

function isArchivedPatternPage(page: HistoricSqlPatternPage): boolean {
  const tags = Array.isArray(page.frontmatter.tags) ? page.frontmatter.tags : [];
  return tags.includes('archived');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function renderMarkdownPage(frontmatter: Record<string, unknown>, content: string): string {
  let yaml = YAML.stringify(frontmatter, { indent: 2, lineWidth: 0 }).trimEnd();
  const staleSince = frontmatter.stale_since;
  if (typeof staleSince === 'string') {
    yaml = yaml.replace(`stale_since: ${staleSince}`, `stale_since: "${staleSince}"`);
  }
  return `---\n${yaml}\n---\n\n${content.trim()}\n`;
}

function existingPageSignals(page: HistoricSqlPatternPage): string[] {
  return [...stringArray(page.frontmatter.tables), ...stringArray(page.frontmatter.fingerprints)];
}

function shouldArchive(staleSince: unknown, fetchedAt: string, days: number): boolean {
  if (typeof staleSince !== 'string') return false;
  const staleTime = Date.parse(staleSince);
  const fetchedTime = Date.parse(fetchedAt);
  if (!Number.isFinite(staleTime) || !Number.isFinite(fetchedTime)) return false;
  return fetchedTime - staleTime > days * 24 * 60 * 60 * 1000;
}

async function loadPatternPages(root: string): Promise<HistoricSqlPatternPage[]> {
  const files = await walkFiles(root);
  const pages: HistoricSqlPatternPage[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith('.md'))) {
    if (file.includes('/')) {
      continue;
    }
    const key = file.replace(/\.md$/, '');
    const path = join(root, file);
    const page = parseMarkdownPage(key, path, await readFile(path, 'utf-8'));
    if (page) {
      pages.push(page);
    }
  }
  return pages;
}

function historicSqlFlatKey(slug: string): string {
  return `historic-sql-${safeKnowledgeSlug(slug)}`;
}

async function currentStagedTables(rawDir: string): Promise<Set<string>> {
  const tablesRoot = join(rawDir, 'tables');
  const files = await walkFiles(tablesRoot);
  const tables = new Set<string>();
  for (const file of files.filter((candidate) => candidate.endsWith('.json'))) {
    const value = await readJson(join(tablesRoot, file));
    if (typeof value === 'object' && value !== null && 'table' in value && typeof value.table === 'string') {
      tables.add(value.table);
    }
  }
  return tables;
}

export async function projectHistoricSqlEvidence(input: HistoricSqlProjectionInput): Promise<HistoricSqlProjectionResult> {
  const result: HistoricSqlProjectionResult = {
    tableUsageMerged: 0,
    staleTablesMarked: 0,
    patternPagesWritten: 0,
    stalePatternPagesMarked: 0,
    archivedPatternPages: 0,
    touchedSources: [],
    changedWikiPageKeys: [],
    actions: [],
    warnings: [],
  };
  const touchedKeys = new Set<string>();
  const rawDir = join(input.workdir, rawSourcesDirForSync(input.connectionId, 'historic-sql', input.syncId));
  const manifest = stagedManifestSchema.parse(await readJson(join(rawDir, 'manifest.json')));
  const currentTables = await currentStagedTables(rawDir);
  const evidence = await loadEvidence(input.workdir, input.runId);
  if (input.overrideReplay && evidence.length === 0) {
    result.warnings.push(
      'historic-sql finalization skipped stale/archive cleanup during override replay without current-run evidence',
    );
    return result;
  }
  if (evidence.length === 0) {
    result.warnings.push('historic-sql finalization skipped because no current-run evidence was emitted');
    return result;
  }
  const tableEvidence = evidence.filter((entry): entry is HistoricSqlEvidenceEnvelope & { kind: 'table_usage' } => entry.kind === 'table_usage');
  const patternEvidence = evidence.filter((entry): entry is HistoricSqlEvidenceEnvelope & { kind: 'pattern' } => entry.kind === 'pattern');

  const schemaRoot = join(input.workdir, 'semantic-layer', input.connectionId, '_schema');
  for (const file of (await walkFiles(schemaRoot)).filter((candidate) => candidate.endsWith('.yaml') || candidate.endsWith('.yml'))) {
    const path = join(schemaRoot, file);
    const before = await readFile(path, 'utf-8');
    const shard = (YAML.parse(before) ?? {}) as ManifestShard;
    if (!shard.tables) continue;
    for (const [tableName, entry] of Object.entries(shard.tables)) {
      const tableRef = entry.table ?? tableName;
      const matchingEvidence = tableEvidence.find(
        (candidate) => candidate.table === tableRef || tableSourceName(candidate.table) === tableName,
      );
      if (matchingEvidence) {
        const merged = mergeUsagePreservingExternal(entry.usage as TableUsageOutput | undefined, matchingEvidence.usage);
        if (JSON.stringify(entry.usage ?? null) !== JSON.stringify(merged ?? null)) {
          entry.usage = merged as Record<string, unknown>;
          result.tableUsageMerged += 1;
          const sourceName = tableSourceName(matchingEvidence.table);
          const key = `${input.connectionId}:${sourceName}`;
          if (!touchedKeys.has(key)) {
            touchedKeys.add(key);
            result.touchedSources.push({ connectionId: input.connectionId, sourceName });
          }
          result.actions.push({
            target: 'sl',
            type: 'updated',
            key: sourceName,
            targetConnectionId: input.connectionId,
            detail: `Merged historic-SQL usage for ${matchingEvidence.table}`,
            rawPaths: matchingEvidence.rawPaths,
          });
        }
      } else if (entry.usage && !currentTables.has(tableRef)) {
        const merged = mergeUsagePreservingExternal(entry.usage as TableUsageOutput | undefined, staleUsage(manifest.fetchedAt));
        if (JSON.stringify(entry.usage ?? null) !== JSON.stringify(merged ?? null)) {
          entry.usage = merged as Record<string, unknown>;
          result.staleTablesMarked += 1;
          const sourceName = tableSourceName(tableRef);
          const key = `${input.connectionId}:${sourceName}`;
          if (!touchedKeys.has(key)) {
            touchedKeys.add(key);
            result.touchedSources.push({ connectionId: input.connectionId, sourceName });
          }
          result.actions.push({
            target: 'sl',
            type: 'updated',
            key: sourceName,
            targetConnectionId: input.connectionId,
            detail: `Marked historic-SQL usage stale for ${tableRef}`,
            rawPaths: ['manifest.json'],
          });
        }
      }
    }
    const after = YAML.stringify(shard, { indent: 2, lineWidth: 0, version: '1.1' });
    if (after !== before) {
      await writeYamlAtomic(path, shard);
    }
  }

  const wikiRoot = join(input.workdir, 'wiki/global');
  await mkdir(wikiRoot, { recursive: true });
  const allPages = await loadPatternPages(wikiRoot);
  const activePages = allPages.filter((page) => !isArchivedPatternPage(page));
  const patternPages = activePages.filter(isHistoricPatternPage);
  const writtenKeys = new Set<string>();

  for (const pattern of patternEvidence) {
    const incomingSignals = [...pattern.pattern.tablesInvolved, ...pattern.pattern.constituentTemplateIds];
    const reusable = patternPages.find((page) => overlapRatio(incomingSignals, existingPageSignals(page)) >= 0.6);
    const key = reusable?.key ?? historicSqlFlatKey(pattern.pattern.slug);
    const pagePath = join(wikiRoot, `${key}.md`);
    const frontmatter = {
      summary: pattern.pattern.title,
      tags: ['historic-sql', 'pattern'],
      refs: [],
      sl_refs: pattern.pattern.slRefs,
      usage_mode: 'auto',
      source: 'historic-sql',
      tables: pattern.pattern.tablesInvolved,
      representative_sql: pattern.pattern.definitionSql,
      fingerprints: pattern.pattern.constituentTemplateIds,
    };
    await mkdir(dirname(pagePath), { recursive: true });
    await writeFile(pagePath, renderMarkdownPage(frontmatter, renderPatternMarkdown(pattern)), 'utf-8');
    writtenKeys.add(key);
    result.patternPagesWritten += 1;
    result.changedWikiPageKeys.push(key);
    result.actions.push({
      target: 'wiki',
      type: reusable ? 'updated' : 'created',
      key,
      detail: `Projected historic-SQL pattern ${pattern.pattern.title}`,
      rawPaths: pattern.rawPaths,
    });
  }

  for (const page of patternPages) {
    if (writtenKeys.has(page.key)) continue;
    if (shouldArchive(page.frontmatter.stale_since, manifest.fetchedAt, manifest.staleArchiveAfterDays)) {
      const tags = [...new Set([...stringArray(page.frontmatter.tags), 'archived'])];
      await writeFile(
        page.path,
        renderMarkdownPage({ ...page.frontmatter, tags, archived_since: manifest.fetchedAt }, page.content),
        'utf-8',
      );
      result.archivedPatternPages += 1;
      result.changedWikiPageKeys.push(page.key);
      result.actions.push({
        target: 'wiki',
        type: 'updated',
        key: page.key,
        detail: `Archived stale historic-SQL pattern page ${page.key}`,
        rawPaths: ['manifest.json'],
      });
      continue;
    }
    const tags = [...new Set([...stringArray(page.frontmatter.tags), 'stale'])];
    await writeFile(
      page.path,
      renderMarkdownPage({ ...page.frontmatter, tags, stale_since: manifest.fetchedAt }, page.content),
      'utf-8',
    );
    result.stalePatternPagesMarked += 1;
    result.changedWikiPageKeys.push(page.key);
    result.actions.push({
      target: 'wiki',
      type: 'updated',
      key: page.key,
      detail: `Marked historic-SQL pattern page ${page.key} stale`,
      rawPaths: ['manifest.json'],
    });
  }

  result.changedWikiPageKeys = [...new Set(result.changedWikiPageKeys)].sort();
  return result;
}
