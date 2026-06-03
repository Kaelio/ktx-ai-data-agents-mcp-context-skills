import { z } from 'zod';
import type { KtxLlmRuntimePort } from '../../../../context/llm/runtime-port.js';
import type { SqlAnalysisPort } from '../../../../context/sql-analysis/ports.js';
import { tableRefKey } from '../../../scan/table-ref.js';
import type { KtxTableRef } from '../../../scan/types.js';
import { bucketDistinctUsers, bucketExecutions, bucketRecency } from './buckets.js';
import {
  compileHistoricSqlRedactionPatterns,
  redactHistoricSqlText,
  type HistoricSqlRedactionPattern,
} from './redaction.js';
import { includedQueryHistoryTableRefs } from './scope-membership.js';
import {
  aggregatedTemplateSchema,
  historicSqlUnifiedPullConfigSchema,
  type AggregatedTemplate,
  type HistoricSqlDialect,
  type HistoricSqlReader,
} from './types.js';

export interface QueryHistoryFilterProposal {
  excludedRoles: Array<{ role: string; reason: string; pattern: string }>;
  consideredRoleCount: number;
  skipped: { reason: 'no-llm' | 'no-daemon' | 'no-in-scope-history' | 'user-block-present' } | null;
  warnings: string[];
}

export interface ProposeQueryHistoryServiceAccountFiltersInput {
  connectionId: string;
  dialect: HistoricSqlDialect;
  queryClient: unknown;
  reader: HistoricSqlReader;
  sqlAnalysis: SqlAnalysisPort;
  llmRuntime: KtxLlmRuntimePort | null;
  pullConfig: unknown;
  now?: Date;
  userServiceAccountsPresent?: boolean;
}

interface ParsedTemplateForPicker {
  template: AggregatedTemplate;
  tablesTouched: KtxTableRef[];
  includedTables: KtxTableRef[];
}

interface RoleAccumulator {
  role: string;
  executions: number;
  distinctUsers: number;
  lastSeen: string;
  tables: Map<string, KtxTableRef>;
  templates: AggregatedTemplate[];
}

interface QueryHistoryRoleRecord {
  role: string;
  inScopeTables: string[];
  executionsBucket: string;
  distinctUsersBucket: string;
  recencyBucket: string;
  representativeTemplates: Array<{ id: string; canonicalSql: string; dialect: HistoricSqlDialect }>;
}

const queryHistoryFilterAdjudicationSchema = z.object({
  roles: z.array(
    z.object({
      role: z.string().min(1),
      exclude: z.boolean(),
      reason: z.string().min(1),
    }).strict(),
  ),
}).strict();

type QueryHistoryFilterAdjudication = z.infer<typeof queryHistoryFilterAdjudicationSchema>;

function emptyProposal(skipped: QueryHistoryFilterProposal['skipped'], warnings: string[] = []): QueryHistoryFilterProposal {
  return { excludedRoles: [], consideredRoleCount: 0, skipped, warnings };
}

function displayTableRef(ref: KtxTableRef): string {
  return [ref.catalog, ref.db, ref.name].filter((part): part is string => !!part && part.length > 0).join('.');
}

function redactTemplateSqlForPicker(
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

/** @internal */
export function regexEscapeForExactRolePattern(role: string): string {
  return `^${role.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`;
}

function recordRole(
  acc: RoleAccumulator,
  template: AggregatedTemplate,
  tables: readonly KtxTableRef[],
  executions: number,
): void {
  acc.executions += executions;
  acc.distinctUsers = Math.max(acc.distinctUsers, template.stats.distinctUsers);
  acc.lastSeen = template.stats.lastSeen > acc.lastSeen ? template.stats.lastSeen : acc.lastSeen;
  for (const table of tables) {
    acc.tables.set(tableRefKey(table), table);
  }
  acc.templates.push(template);
}

function roleRecords(parsedTemplates: readonly ParsedTemplateForPicker[], now: Date): QueryHistoryRoleRecord[] {
  const byRole = new Map<string, RoleAccumulator>();
  for (const parsed of parsedTemplates) {
    for (const entry of parsed.template.topUsers) {
      if (!entry.user || entry.user.trim().length === 0 || entry.executions <= 0) {
        continue;
      }
      const role = entry.user.trim();
      const acc =
        byRole.get(role) ??
        {
          role,
          executions: 0,
          distinctUsers: 0,
          lastSeen: '1970-01-01T00:00:00.000Z',
          tables: new Map<string, KtxTableRef>(),
          templates: [],
        };
      recordRole(acc, parsed.template, parsed.includedTables, entry.executions);
      byRole.set(role, acc);
    }
  }

  return [...byRole.values()]
    .sort((left, right) => right.executions - left.executions || left.role.localeCompare(right.role))
    .map((acc) => ({
      role: acc.role,
      inScopeTables: [...acc.tables.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 25)
        .map(([, ref]) => displayTableRef(ref)),
      executionsBucket: bucketExecutions(acc.executions),
      distinctUsersBucket: bucketDistinctUsers(acc.distinctUsers),
      recencyBucket: bucketRecency(acc.lastSeen, now),
      representativeTemplates: [...acc.templates]
        .sort((left, right) => right.stats.executions - left.stats.executions || left.templateId.localeCompare(right.templateId))
        .slice(0, 3)
        .map((template) => ({
          id: template.templateId,
          canonicalSql: template.canonicalSql,
          dialect: template.dialect,
        })),
    }));
}

function adjudicationSystemPrompt(): string {
  return [
    'You are helping ktx decide whether observed query-history roles are operational service accounts.',
    'Default every role to keep. Mark exclude true only when the aggregate evidence clearly shows loader, ELT, reverse-ETL, export, refresh, or maintenance traffic rather than analyst or BI-dashboard usage.',
    'Use only the observed role records. Do not rely on a hardcoded denylist. Return structured output only.',
  ].join('\n');
}

export async function proposeQueryHistoryServiceAccountFilters(
  input: ProposeQueryHistoryServiceAccountFiltersInput,
): Promise<QueryHistoryFilterProposal> {
  if (!input.llmRuntime) {
    return emptyProposal({ reason: 'no-llm' });
  }

  const config = historicSqlUnifiedPullConfigSchema.parse(input.pullConfig);
  const redactors = compileHistoricSqlRedactionPatterns(config.redactionPatterns);
  const now = input.now ?? new Date();
  const windowDays = 'windowDays' in config ? config.windowDays : 90;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const warnings: string[] = [];
  const snapshot: AggregatedTemplate[] = [];

  try {
    for await (const row of input.reader.fetchAggregated(input.queryClient, { start: windowStart, end: now }, config)) {
      snapshot.push(aggregatedTemplateSchema.parse(row));
    }
  } catch (error) {
    return emptyProposal(null, [
      `query_history_filter_picker_read_failed:${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  if (snapshot.length === 0) {
    return emptyProposal({ reason: 'no-in-scope-history' });
  }

  const analysisItems = snapshot.map((template) => ({ id: template.templateId, sql: template.canonicalSql }));
  const analysisOptions =
    config.modeledTableCatalog.length > 0 ? { catalog: { tables: config.modeledTableCatalog } } : undefined;
  let analysis: Awaited<ReturnType<SqlAnalysisPort['analyzeBatch']>>;
  try {
    analysis = await input.sqlAnalysis.analyzeBatch(analysisItems, input.dialect, analysisOptions);
  } catch (error) {
    return emptyProposal({ reason: 'no-daemon' }, [
      `query_history_filter_picker_analysis_failed:${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const parsedTemplates: ParsedTemplateForPicker[] = [];
  for (const template of snapshot) {
    const parsed = analysis.get(template.templateId);
    if (!parsed || parsed.error) {
      warnings.push(`query_history_filter_picker_parse_failed:${template.templateId}`);
      continue;
    }
    const tablesTouched = [...new Map(parsed.tablesTouched.map((ref) => [tableRefKey(ref), ref])).values()]
      .filter((ref) => ref.name.length > 0)
      .sort((left, right) => tableRefKey(left).localeCompare(tableRefKey(right)));
    const includedTables = includedQueryHistoryTableRefs(tablesTouched, config);
    if (includedTables.length === 0) {
      continue;
    }
    parsedTemplates.push({
      template: redactTemplateSqlForPicker(template, redactors),
      tablesTouched,
      includedTables,
    });
  }

  const records = roleRecords(parsedTemplates, now);
  if (records.length <= 1) {
    return {
      excludedRoles: [],
      consideredRoleCount: records.length,
      skipped: { reason: 'no-in-scope-history' },
      warnings,
    };
  }

  let generated: QueryHistoryFilterAdjudication;
  try {
    generated = await input.llmRuntime.generateObject<QueryHistoryFilterAdjudication, typeof queryHistoryFilterAdjudicationSchema>({
      role: 'candidateExtraction',
      system: adjudicationSystemPrompt(),
      prompt: JSON.stringify({ connectionId: input.connectionId, dialect: input.dialect, roles: records }),
      schema: queryHistoryFilterAdjudicationSchema,
    });
  } catch (error) {
    return {
      excludedRoles: [],
      consideredRoleCount: records.length,
      skipped: { reason: 'no-llm' },
      warnings: [
        ...warnings,
        `query_history_filter_picker_llm_failed:${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const knownRoles = new Set(records.map((record) => record.role));
  const excludedRoles = generated.roles
    .filter((role) => role.exclude && knownRoles.has(role.role))
    .sort((left, right) => left.role.localeCompare(right.role))
    .map((role) => ({
      role: role.role,
      reason: role.reason,
      pattern: regexEscapeForExactRolePattern(role.role),
    }));

  return {
    excludedRoles,
    consideredRoleCount: records.length,
    skipped: input.userServiceAccountsPresent ? { reason: 'user-block-present' } : null,
    warnings,
  };
}
