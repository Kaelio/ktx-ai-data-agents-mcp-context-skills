import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SqlAnalysisPort } from '../../../../context/sql-analysis/ports.js';
import {
  bucketDistinctUsers,
  bucketErrorRate,
  bucketExecutions,
  bucketFrequency,
  bucketP95Runtime,
  bucketRecency,
} from './buckets.js';
import { splitHistoricSqlPatternInputs } from './pattern-inputs.js';
import {
  compileHistoricSqlRedactionPatterns,
  redactHistoricSqlText,
  type HistoricSqlRedactionPattern,
} from './redaction.js';
import {
  HISTORIC_SQL_SOURCE_KEY,
  aggregatedTemplateSchema,
  historicSqlUnifiedPullConfigSchema,
  type AggregatedTemplate,
  type HistoricSqlReader,
  type HistoricSqlUnifiedPullConfig,
  type StagedPatternsInput,
  type StagedTableInput,
} from './types.js';

interface StageHistoricSqlAggregatedSnapshotInput {
  stagedDir: string;
  connectionId: string;
  queryClient: unknown;
  reader: HistoricSqlReader;
  sqlAnalysis: SqlAnalysisPort;
  pullConfig: unknown;
  now?: Date;
}

interface ParsedTemplate {
  template: AggregatedTemplate;
  tablesTouched: string[];
  includedTables: string[];
  columnsByClause: Record<string, string[]>;
}

interface EnabledTableFilter {
  exact: Set<string>;
  uniqueUnqualified: Set<string>;
}

interface TableAccumulator {
  table: string;
  executions: number;
  distinctUsers: number;
  errorRateNumerator: number;
  p95RuntimeMs: number | null;
  lastSeen: string;
  columnsByClause: Map<string, Map<string, number>>;
  observedJoins: Map<string, Map<string, number>>;
  topTemplates: AggregatedTemplate[];
}

const TRIVIAL_SQL_RE = /^\s*SELECT\s+(1|NOW\(\)|CURRENT_TIMESTAMP|VERSION\(\))\s*;?\s*$/i;
const NOISE_PREFIX_RE = /^\s*(SHOW|DESCRIBE|DESC|EXPLAIN|USE|SET)\b/i;
const SYSTEM_TABLE_RE = /\b(INFORMATION_SCHEMA|SNOWFLAKE\.ACCOUNT_USAGE|pg_|system\.)/i;

function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  const target = join(root, relPath);
  return mkdir(dirname(target), { recursive: true }).then(() =>
    writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf-8'),
  );
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern));
}

function matchesAny(value: string | null, patterns: RegExp[]): boolean {
  return !!value && patterns.some((pattern) => pattern.test(value));
}

// ktx's own warehouse scan emits relationship- and column-profiling probes that land in
// pg_stat_statements (relationship-validation, relationship-composite-candidates, and each
// dialect's relationship value aggregation). They are ktx introspection, not genuine query
// usage, so they must not be mined back as query history. The markers are ktx-owned
// identifiers, stable across dialects.
function isKtxScanProbe(sql: string): boolean {
  if (/\brelationship_profile_values\b/i.test(sql)) {
    return true;
  }
  return /\bchild_values\b/i.test(sql) && /\bparent_values\b/i.test(sql);
}

function shouldDropBySql(sql: string, config: HistoricSqlUnifiedPullConfig): boolean {
  if (NOISE_PREFIX_RE.test(sql) || SYSTEM_TABLE_RE.test(sql)) return true;
  if (isKtxScanProbe(sql)) return true;
  if (config.filters.dropTrivialProbes !== false && TRIVIAL_SQL_RE.test(sql)) return true;
  return false;
}

function shouldDropByUsers(template: AggregatedTemplate, config: HistoricSqlUnifiedPullConfig): boolean {
  const service = config.filters.serviceAccounts;
  if (!service || service.mode === 'mark-only' || service.patterns.length === 0) return false;
  const patterns = compilePatterns(service.patterns);
  const matchingExecutions = template.topUsers
    .filter((entry) => matchesAny(entry.user, patterns))
    .reduce((sum, entry) => sum + entry.executions, 0);
  const allExecutions = template.topUsers.reduce((sum, entry) => sum + entry.executions, 0);
  const serviceOnly = allExecutions > 0 && matchingExecutions >= allExecutions;
  return service.mode === 'exclude' ? serviceOnly : !serviceOnly;
}

function shouldDropByFailure(template: AggregatedTemplate, config: HistoricSqlUnifiedPullConfig): boolean {
  const failed = config.filters.dropFailedBelow;
  return !!failed && template.stats.errorRate > failed.errorRate && template.stats.executions < failed.executions;
}

function shouldDropTemplate(template: AggregatedTemplate, config: HistoricSqlUnifiedPullConfig): boolean {
  if (shouldDropBySql(template.canonicalSql, config)) return true;
  if (shouldDropByUsers(template, config)) return true;
  if (shouldDropByFailure(template, config)) return true;
  return false;
}

function normalizeTableIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function unqualifiedTableIdentifier(value: string): string {
  const parts = normalizeTableIdentifier(value).split('.').filter(Boolean);
  return parts.at(-1) ?? '';
}

function buildEnabledTableFilter(enabledTables: string[]): EnabledTableFilter | null {
  if (enabledTables.length === 0) {
    return null;
  }
  const exact = new Set(enabledTables.map(normalizeTableIdentifier).filter((value) => value.length > 0));
  const unqualifiedCounts = new Map<string, number>();
  for (const table of exact) {
    const unqualified = unqualifiedTableIdentifier(table);
    if (unqualified.length > 0) {
      unqualifiedCounts.set(unqualified, (unqualifiedCounts.get(unqualified) ?? 0) + 1);
    }
  }
  return {
    exact,
    uniqueUnqualified: new Set(
      [...unqualifiedCounts.entries()]
        .filter(([, count]) => count === 1)
        .map(([table]) => table),
    ),
  };
}

function isEnabledTable(table: string, filter: EnabledTableFilter | null): boolean {
  if (!filter) {
    return true;
  }
  const normalized = normalizeTableIdentifier(table);
  return filter.exact.has(normalized) || filter.uniqueUnqualified.has(unqualifiedTableIdentifier(normalized));
}

/**
 * pg_stat_statements records queries as written, so the same physical table can appear
 * both bare (`accounts`, resolved via search_path) and schema-qualified
 * (`orbit_raw.accounts`). Collapse a bare identifier into its schema-qualified form when
 * exactly one qualified form shares its unqualified name, so the two never become separate
 * work units. Ambiguous bare names (two qualified forms) are left untouched.
 */
function canonicalizeTableIdentifiers(parsedTemplates: ParsedTemplate[]): void {
  const all = new Set<string>();
  for (const parsed of parsedTemplates) {
    for (const table of parsed.includedTables) {
      all.add(table);
    }
  }
  const qualifiedByUnqualified = new Map<string, Set<string>>();
  for (const table of all) {
    if (!table.includes('.')) {
      continue;
    }
    const unqualified = unqualifiedTableIdentifier(table);
    if (unqualified.length === 0) {
      continue;
    }
    const forms = qualifiedByUnqualified.get(unqualified) ?? new Set<string>();
    forms.add(table);
    qualifiedByUnqualified.set(unqualified, forms);
  }
  const canonical = new Map<string, string>();
  for (const table of all) {
    if (table.includes('.')) {
      continue;
    }
    const forms = qualifiedByUnqualified.get(unqualifiedTableIdentifier(table));
    if (forms && forms.size === 1) {
      canonical.set(table, [...forms][0]);
    }
  }
  if (canonical.size === 0) {
    return;
  }
  const remap = (table: string): string => canonical.get(table) ?? table;
  for (const parsed of parsedTemplates) {
    parsed.includedTables = [...new Set(parsed.includedTables.map(remap))].sort();
    parsed.tablesTouched = [...new Set(parsed.tablesTouched.map(remap))].sort();
  }
}

function historicSqlWindowDays(config: HistoricSqlUnifiedPullConfig): number {
  return 'windowDays' in config ? config.windowDays : 90;
}

function redactTemplateSql(
  template: AggregatedTemplate,
  redactors: readonly HistoricSqlRedactionPattern[],
): AggregatedTemplate {
  if (redactors.length === 0) {
    return template;
  }
  return {
    ...template,
    canonicalSql: redactHistoricSqlText(template.canonicalSql, redactors),
  };
}

function recordColumn(acc: TableAccumulator, clause: string, column: string, executions: number): void {
  const byColumn = acc.columnsByClause.get(clause) ?? new Map<string, number>();
  byColumn.set(column, (byColumn.get(column) ?? 0) + executions);
  acc.columnsByClause.set(clause, byColumn);
}

function recordJoin(acc: TableAccumulator, otherTable: string, columns: string[], executions: number): void {
  const byColumns = acc.observedJoins.get(otherTable) ?? new Map<string, number>();
  const key = [...new Set(columns)].sort().join(',');
  if (key.length > 0) {
    byColumns.set(key, (byColumns.get(key) ?? 0) + executions);
    acc.observedJoins.set(otherTable, byColumns);
  }
}

function accumulatorFor(table: string): TableAccumulator {
  return {
    table,
    executions: 0,
    distinctUsers: 0,
    errorRateNumerator: 0,
    p95RuntimeMs: null,
    lastSeen: '1970-01-01T00:00:00.000Z',
    columnsByClause: new Map(),
    observedJoins: new Map(),
    topTemplates: [],
  };
}

function addTemplate(acc: TableAccumulator, parsed: ParsedTemplate): void {
  const executions = parsed.template.stats.executions;
  acc.executions += executions;
  acc.distinctUsers = Math.max(acc.distinctUsers, parsed.template.stats.distinctUsers);
  acc.errorRateNumerator += parsed.template.stats.errorRate * executions;
  acc.p95RuntimeMs =
    acc.p95RuntimeMs === null
      ? parsed.template.stats.p95RuntimeMs
      : parsed.template.stats.p95RuntimeMs === null
        ? acc.p95RuntimeMs
        : Math.max(acc.p95RuntimeMs, parsed.template.stats.p95RuntimeMs);
  acc.lastSeen = parsed.template.stats.lastSeen > acc.lastSeen ? parsed.template.stats.lastSeen : acc.lastSeen;
  for (const [clause, columns] of Object.entries(parsed.columnsByClause)) {
    for (const column of columns) {
      recordColumn(acc, clause, column, executions);
    }
  }
  const joinColumns = parsed.columnsByClause.join ?? [];
  for (const otherTable of parsed.tablesTouched.filter((table) => table !== acc.table)) {
    recordJoin(acc, otherTable, joinColumns, executions);
  }
  acc.topTemplates.push(parsed.template);
}

function toStagedTable(acc: TableAccumulator, now: Date): StagedTableInput {
  const errorRate = acc.executions > 0 ? acc.errorRateNumerator / acc.executions : 0;
  const columnsByClause: Record<string, Array<[string, string]>> = Object.fromEntries(
    [...acc.columnsByClause.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([clause, counts]) => [
        clause,
        [...counts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([column, count]) => [column, bucketFrequency(count, acc.executions)] as [string, string]),
      ]),
  );
  const observedJoins = [...acc.observedJoins.entries()]
    .flatMap(([withTable, byColumns]) =>
      [...byColumns.entries()].map(([columns, count]) => ({
        withTable,
        on: columns.split(',').filter(Boolean),
        freq: bucketFrequency(count, acc.executions),
      })),
    )
    .sort((left, right) => left.withTable.localeCompare(right.withTable) || left.on.join(',').localeCompare(right.on.join(',')));
  const topTemplates = [...acc.topTemplates]
    .sort((left, right) => right.stats.executions - left.stats.executions || left.templateId.localeCompare(right.templateId))
    .slice(0, 5)
    .map((template) => ({
      id: template.templateId,
      canonicalSql: template.canonicalSql,
      topUsers: template.topUsers.slice(0, 5).map((entry) => ({ user: entry.user })),
    }));

  return {
    table: acc.table,
    stats: {
      executionsBucket: bucketExecutions(acc.executions),
      distinctUsersBucket: bucketDistinctUsers(acc.distinctUsers),
      errorRateBucket: bucketErrorRate(errorRate),
      p95RuntimeBucket: bucketP95Runtime(acc.p95RuntimeMs),
      recencyBucket: bucketRecency(acc.lastSeen, now),
    },
    columnsByClause,
    observedJoins,
    topTemplates,
  };
}

function toPatternsInput(parsedTemplates: ParsedTemplate[]): StagedPatternsInput {
  return {
    templates: parsedTemplates
      .map(({ template, tablesTouched }) => ({
        id: template.templateId,
        canonicalSql: template.canonicalSql,
        tablesTouched: [...tablesTouched].sort(),
        executionsBucket: bucketExecutions(template.stats.executions),
        distinctUsersBucket: bucketDistinctUsers(template.stats.distinctUsers),
        dialect: template.dialect,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function stageHistoricSqlAggregatedSnapshot(input: StageHistoricSqlAggregatedSnapshotInput): Promise<void> {
  const config = historicSqlUnifiedPullConfigSchema.parse(input.pullConfig);
  const enabledTableFilter = buildEnabledTableFilter(config.enabledTables);
  const redactors = compileHistoricSqlRedactionPatterns(config.redactionPatterns);
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - historicSqlWindowDays(config) * 24 * 60 * 60 * 1000);
  const probe = await input.reader.probe(input.queryClient);
  const snapshot: AggregatedTemplate[] = [];
  let snapshotRowCount = 0;

  for await (const row of input.reader.fetchAggregated(input.queryClient, { start: windowStart, end: now }, config)) {
    snapshotRowCount += 1;
    const parsed = aggregatedTemplateSchema.parse(row);
    if (!shouldDropTemplate(parsed, config)) {
      snapshot.push(parsed);
    }
  }

  const analysis = await input.sqlAnalysis.analyzeBatch(
    snapshot.map((template) => ({ id: template.templateId, sql: template.canonicalSql })),
    config.dialect,
  );
  const warnings: string[] = [];
  const parsedTemplates: ParsedTemplate[] = [];
  for (const template of snapshot) {
    const parsed = analysis.get(template.templateId);
    if (!parsed || parsed.error) {
      warnings.push(`parse_failed:${template.templateId}`);
      continue;
    }
    const tablesTouched = [...new Set(parsed.tablesTouched)].filter((table) => table.length > 0).sort();
    const includedTables = tablesTouched.filter((table) => isEnabledTable(table, enabledTableFilter));
    if (includedTables.length === 0) {
      continue;
    }
    parsedTemplates.push({
      template: redactTemplateSql(template, redactors),
      tablesTouched,
      includedTables,
      columnsByClause: Object.fromEntries(
        Object.entries(parsed.columnsByClause).map(([clause, columns]) => [clause, [...new Set(columns)].sort()]),
      ),
    });
  }

  canonicalizeTableIdentifiers(parsedTemplates);

  const byTable = new Map<string, TableAccumulator>();
  for (const parsed of parsedTemplates) {
    for (const table of parsed.includedTables) {
      const acc = byTable.get(table) ?? accumulatorFor(table);
      addTemplate(acc, parsed);
      byTable.set(table, acc);
    }
  }

  await mkdir(input.stagedDir, { recursive: true });
  for (const [table, acc] of [...byTable.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    await writeJson(input.stagedDir, `tables/${table}.json`, toStagedTable(acc, now));
  }
  const patternsInput = toPatternsInput(parsedTemplates);
  const patternInputSplit = splitHistoricSqlPatternInputs(patternsInput);
  const allWarnings = [...warnings, ...patternInputSplit.warnings];
  await writeJson(input.stagedDir, 'patterns-input.json', patternInputSplit.auditInput);
  for (const shard of patternInputSplit.shards) {
    await writeJson(input.stagedDir, shard.path, shard.input);
  }
  await writeJson(input.stagedDir, 'manifest.json', {
    source: HISTORIC_SQL_SOURCE_KEY,
    connectionId: input.connectionId,
    dialect: config.dialect,
    fetchedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    snapshotRowCount,
    touchedTableCount: byTable.size,
    parseFailures: allWarnings.filter((warning) => warning.startsWith('parse_failed:')).length,
    warnings: allWarnings,
    probeWarnings: probe.warnings,
    staleArchiveAfterDays: config.staleArchiveAfterDays,
  });
}
