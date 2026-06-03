import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SqlAnalysisPort } from '../../../../context/sql-analysis/ports.js';
import { tableRefKey, tableRefSet, type KtxTableRefKey } from '../../../scan/table-ref.js';
import type { KtxTableRef } from '../../../scan/types.js';
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
  tablesTouched: KtxTableRef[];
  includedTables: KtxTableRef[];
  columnsByClause: Record<string, string[]>;
}

interface TableAccumulator {
  tableRef: KtxTableRef;
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

function displayTableRef(ref: KtxTableRef): string {
  return [ref.catalog, ref.db, ref.name].filter((part): part is string => !!part && part.length > 0).join('.');
}

function schemaNameForRef(ref: KtxTableRef): string | null {
  return ref.db && ref.db.length > 0 ? ref.db : null;
}

function schemaNamesFromConfig(enabledSchemas: readonly string[]): Set<string> {
  return new Set(enabledSchemas.filter((schema) => schema !== '*'));
}

function isScopeFloorDisabled(config: HistoricSqlUnifiedPullConfig): boolean {
  return config.enabledSchemas.includes('*');
}

function shouldFailOpenScope(config: HistoricSqlUnifiedPullConfig): boolean {
  return config.enabledTables.length === 0 && !isScopeFloorDisabled(config) && config.enabledSchemas.length === 0;
}

function includedTableRefs(
  tablesTouched: readonly KtxTableRef[],
  config: HistoricSqlUnifiedPullConfig,
): KtxTableRef[] {
  if (config.enabledTables.length > 0) {
    const enabled = tableRefSet(config.enabledTables);
    return tablesTouched.filter((ref) => enabled.has(tableRefKey(ref)));
  }
  if (isScopeFloorDisabled(config) || shouldFailOpenScope(config)) {
    return [...tablesTouched];
  }
  const schemas = schemaNamesFromConfig(config.enabledSchemas);
  return tablesTouched.filter((ref) => {
    const schema = schemaNameForRef(ref);
    return schema !== null && schemas.has(schema);
  });
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

function accumulatorFor(tableRef: KtxTableRef): TableAccumulator {
  return {
    tableRef,
    table: displayTableRef(tableRef),
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
  for (const otherTable of parsed.tablesTouched.filter((table) => tableRefKey(table) !== tableRefKey(acc.tableRef))) {
    recordJoin(acc, displayTableRef(otherTable), joinColumns, executions);
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
    tableRef: acc.tableRef,
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
        tablesTouched: [...tablesTouched].sort((left, right) => tableRefKey(left).localeCompare(tableRefKey(right))),
        executionsBucket: bucketExecutions(template.stats.executions),
        distinctUsersBucket: bucketDistinctUsers(template.stats.distinctUsers),
        dialect: template.dialect,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function stageHistoricSqlAggregatedSnapshot(input: StageHistoricSqlAggregatedSnapshotInput): Promise<void> {
  const config = historicSqlUnifiedPullConfigSchema.parse(input.pullConfig);
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

  const analysisItems = snapshot.map((template) => ({ id: template.templateId, sql: template.canonicalSql }));
  const analysisOptions =
    config.modeledTableCatalog.length > 0 ? { catalog: { tables: config.modeledTableCatalog } } : undefined;
  const warnings: string[] = [
    ...config.scopeFloorWarnings,
    ...(shouldFailOpenScope(config) ? ['query_history_scope_floor_disabled:empty_modeled_scope'] : []),
  ];
  let scopeDisabledByQualificationFailure = false;
  let analysis: Awaited<ReturnType<SqlAnalysisPort['analyzeBatch']>>;
  try {
    analysis = await input.sqlAnalysis.analyzeBatch(analysisItems, config.dialect, analysisOptions);
  } catch (error) {
    if (!analysisOptions || config.enabledTables.length > 0 || isScopeFloorDisabled(config)) {
      throw error;
    }
    warnings.push('query_history_scope_floor_disabled:catalog_qualification_failed');
    scopeDisabledByQualificationFailure = true;
    analysis = await input.sqlAnalysis.analyzeBatch(analysisItems, config.dialect, undefined);
  }
  const parsedTemplates: ParsedTemplate[] = [];
  for (const template of snapshot) {
    const parsed = analysis.get(template.templateId);
    if (!parsed || parsed.error) {
      warnings.push(`parse_failed:${template.templateId}`);
      continue;
    }
    const tablesTouched = [...new Map(parsed.tablesTouched.map((ref) => [tableRefKey(ref), ref])).values()]
      .filter((ref) => ref.name.length > 0)
      .sort((left, right) => tableRefKey(left).localeCompare(tableRefKey(right)));
    const includedTables = scopeDisabledByQualificationFailure ? [...tablesTouched] : includedTableRefs(tablesTouched, config);
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

  const byTable = new Map<KtxTableRefKey, TableAccumulator>();
  for (const parsed of parsedTemplates) {
    for (const tableRef of parsed.includedTables) {
      const key = tableRefKey(tableRef);
      const acc = byTable.get(key) ?? accumulatorFor(tableRef);
      addTemplate(acc, parsed);
      byTable.set(key, acc);
    }
  }

  await mkdir(input.stagedDir, { recursive: true });
  for (const [, acc] of [...byTable.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    await writeJson(input.stagedDir, `tables/${acc.table}.json`, toStagedTable(acc, now));
  }
  const patternsInput = toPatternsInput(parsedTemplates);
  const patternInputSplit = splitHistoricSqlPatternInputs(patternsInput);
  const allWarnings = [...new Set([...warnings, ...patternInputSplit.warnings])];
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
