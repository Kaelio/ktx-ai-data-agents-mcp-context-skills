import { tool } from 'ai';
import { z } from 'zod';
import type { ToolOutput } from '../../../../tools/index.js';
import type { ParsedTargetTable } from '../../../parsed-target-table.js';
import { stagedLookerQuerySchema } from '../types.js';

const lookerUsageInputSchema = z.object({
  queryCount30d: z.number().int().nonnegative().default(0),
  uniqueUsers30d: z.number().int().nonnegative().default(0),
});

export const lookerQueryToSlInputSchema = z.object({
  query: stagedLookerQuerySchema,
  contentTitle: z.string().min(1).optional(),
  contentType: z.enum(['look', 'dashboard_tile']).default('look'),
  usage: lookerUsageInputSchema.optional(),
});

export type LookerQueryToSlInput = z.input<typeof lookerQueryToSlInputSchema>;

type LookerTargetStatus = 'mapped' | 'unmapped' | 'unparseable' | 'missing_target_table';

export interface LookerSlFieldProposal {
  name: string;
  lookerField: string;
}

export interface LookerSlMeasureProposal extends LookerSlFieldProposal {
  expr: string;
  description: string;
}

export interface LookerSlSegmentProposal {
  name: string;
  filters: Record<string, unknown>;
  suggestedPredicate: string;
  description: string;
}

export interface LookerSlProposal {
  sourceName: string;
  targetWarehouseConnectionId: string | null;
  targetTable: ParsedTargetTable | null;
  targetStatus: LookerTargetStatus;
  sourceTable: string | null;
  canWriteStandaloneSource: boolean;
  triageLane: 'skip' | 'light' | 'full';
  decision: 'wiki_only' | 'measure_added' | 'source_created';
  dimensions: LookerSlFieldProposal[];
  measures: LookerSlMeasureProposal[];
  segments: LookerSlSegmentProposal[];
  notes: string[];
}

const MEASURE_FIELD_RE =
  /\b(count|sum|total|revenue|arr|mrr|amount|avg|average|rate|ratio|percent|pct|margin|profit|value|score)\b/i;

function targetStatus(
  targetWarehouseConnectionId: string | null,
  targetTable: ParsedTargetTable | null,
): LookerTargetStatus {
  if (targetTable?.ok === true && targetWarehouseConnectionId) {
    return 'mapped';
  }
  if (targetTable?.ok === false && targetTable.reason === 'no_connection_mapping') {
    return 'unmapped';
  }
  if (targetTable?.ok === false) {
    return 'unparseable';
  }
  return 'missing_target_table';
}

function targetNotes(status: LookerTargetStatus, targetTable: ParsedTargetTable | null): string[] {
  if (status === 'mapped') {
    return [
      'targetTable.ok is true: write or edit SL on targetWarehouseConnectionId using targetTable.canonicalTable as source.table.',
      'Use targetTable.catalog, targetTable.schema, and targetTable.name only for source_tables preflight matching.',
      'Never use rawSqlTableName as source.table; it may contain aliases, templates, or derived-table SQL.',
    ];
  }
  if (targetTable?.ok === false) {
    return [
      `targetTable.ok is false (${targetTable.reason}): keep this query wiki-only and pass the reason through emit_unmapped_fallback.`,
    ];
  }
  return [
    'No targetTable was staged for this query; read the parent explore dependency before attempting any SL write.',
  ];
}

export function buildLookerSlProposal(raw: LookerQueryToSlInput): LookerSlProposal {
  const input = lookerQueryToSlInputSchema.parse(raw);
  const sourceName = `looker__${toSlName(input.query.model)}__${toSlName(input.query.view)}`;
  const usage = input.usage;
  const targetWarehouseConnectionId = input.query.targetWarehouseConnectionId ?? null;
  const targetTable = input.query.targetTable ?? null;
  const status = targetStatus(targetWarehouseConnectionId, targetTable);
  const sourceTable = targetTable?.ok === true ? targetTable.canonicalTable : null;
  const canWriteStandaloneSource = status === 'mapped';
  const triageLane =
    usage && usage.queryCount30d === 0 && usage.uniqueUsers30d === 0 ? 'skip' : isHighUsage(usage) ? 'full' : 'light';
  const dimensions: LookerSlFieldProposal[] = [];
  const measures: LookerSlMeasureProposal[] = [];

  for (const field of input.query.fields) {
    const proposal = { name: toSlName(fieldLeaf(field)), lookerField: field };
    if (isMeasureLikeField(field)) {
      measures.push({
        ...proposal,
        expr: suggestedMeasureExpr(field),
        description: `Suggested from Looker ${contentLabel(input)}; verify against explore field SQL before writing.`,
      });
    } else {
      dimensions.push(proposal);
    }
  }

  const filters = nonEmptyFilters(input.query.filters);
  const segments =
    Object.keys(filters).length === 0
      ? []
      : [
          {
            name: toSlName(input.contentTitle ?? Object.keys(filters).map(fieldLeaf).join('_')),
            filters,
            suggestedPredicate: Object.entries(filters)
              .map(([field, value]) => filterValueToPredicate(field, value))
              .join(' AND '),
            description: `Reusable filter candidate from Looker ${contentLabel(input)}.`,
          },
        ];

  const decision =
    measures.length > 0 ? 'measure_added' : segments.length > 0 && isHighUsage(usage) ? 'source_created' : 'wiki_only';

  const notes = [
    ...targetNotes(status, targetTable),
    'Treat this as a proposal, not an instruction to write SL blindly.',
    'Verify field SQL, source shape, and existing SL overlap with sl_discover/sl_read_source before sl_write_source or sl_edit_source.',
    'Usage signals can raise priority, but query counts, users, owners, and folders must not be written as wiki narrative.',
  ];
  if (triageLane === 'skip') {
    notes.push('Zero recent usage is a skip signal unless the raw content clearly defines durable business semantics.');
  }

  return {
    sourceName,
    targetWarehouseConnectionId,
    targetTable,
    targetStatus: status,
    sourceTable,
    canWriteStandaloneSource,
    triageLane,
    decision,
    dimensions,
    measures,
    segments,
    notes,
  };
}

export function createLookerQueryToSlTool() {
  return tool({
    description:
      'Given one staged Looker query JSON, return a conservative proposal for SL measures, dimensions, reusable filters, and triage priority. The proposal is advisory; verify with SL tools before writing.',
    inputSchema: lookerQueryToSlInputSchema,
    execute: async (input): Promise<ToolOutput<LookerSlProposal>> => {
      const structured = buildLookerSlProposal(input);
      return {
        markdown: formatLookerSlProposal(structured),
        structured,
      };
    },
    toModelOutput: ({ output }) => {
      const markdown =
        output && typeof output === 'object' && 'markdown' in output
          ? String((output as { markdown: unknown }).markdown)
          : String(output);
      return { type: 'content', value: [{ type: 'text', text: markdown }] };
    },
  });
}

export function formatLookerSlProposal(proposal: LookerSlProposal): string {
  const lines = [
    '## Looker query SL proposal',
    '',
    `- sourceName: ${proposal.sourceName}`,
    `- targetStatus: ${proposal.targetStatus}`,
    `- targetWarehouseConnectionId: ${proposal.targetWarehouseConnectionId ?? '(none)'}`,
    `- sourceTable: ${proposal.sourceTable ?? '(none)'}`,
    `- canWriteStandaloneSource: ${proposal.canWriteStandaloneSource}`,
    `- triageLane: ${proposal.triageLane}`,
    `- decision: ${proposal.decision}`,
    '',
    '### Measures',
    ...(proposal.measures.length === 0
      ? ['- (none)']
      : proposal.measures.map((measure) => `- ${measure.name}: ${measure.expr} (${measure.lookerField})`)),
    '',
    '### Dimensions',
    ...(proposal.dimensions.length === 0
      ? ['- (none)']
      : proposal.dimensions.map((dimension) => `- ${dimension.name}: ${dimension.lookerField}`)),
    '',
    '### Segments',
    ...(proposal.segments.length === 0
      ? ['- (none)']
      : proposal.segments.map((segment) => `- ${segment.name}: ${segment.suggestedPredicate}`)),
    '',
    '### Notes',
    ...proposal.notes.map((note) => `- ${note}`),
  ];
  return lines.join('\n');
}

function isHighUsage(usage: z.infer<typeof lookerUsageInputSchema> | undefined): boolean {
  return !!usage && (usage.queryCount30d >= 10 || usage.uniqueUsers30d >= 3);
}

function isMeasureLikeField(field: string): boolean {
  return MEASURE_FIELD_RE.test(fieldLeaf(field).replace(/_/g, ' '));
}

function suggestedMeasureExpr(field: string): string {
  const leaf = fieldLeaf(field);
  if (/\b(count|count_distinct)\b/i.test(leaf.replace(/_/g, ' '))) {
    return `count(${field})`;
  }
  if (/\b(avg|average|rate|ratio|percent|pct|margin|score)\b/i.test(leaf.replace(/_/g, ' '))) {
    return `avg(${field})`;
  }
  return `sum(${field})`;
}

function fieldLeaf(field: string): string {
  const parts = field.split('.');
  return parts[parts.length - 1] || field;
}

function nonEmptyFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => {
      if (value === null || value === undefined) {
        return false;
      }
      if (typeof value === 'string') {
        return value.trim().length > 0;
      }
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return true;
    }),
  );
}

function filterValueToPredicate(field: string, value: unknown): string {
  if (Array.isArray(value)) {
    return `${field} IN (${value.map(sqlLiteral).join(', ')})`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${field} = ${String(value)}`;
  }
  const raw = String(value).trim();
  if (raw.includes(',') && !raw.includes('"') && !raw.includes("'")) {
    return `${field} IN (${raw
      .split(',')
      .map((part) => sqlLiteral(part.trim()))
      .join(', ')})`;
  }
  if (raw.startsWith('-') && raw.length > 1) {
    return `${field} != ${sqlLiteral(raw.slice(1).trim())}`;
  }
  if (raw.includes('%')) {
    return `${field} LIKE ${sqlLiteral(raw)}`;
  }
  return `${field} = ${sqlLiteral(raw)}`;
}

function sqlLiteral(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function contentLabel(input: z.infer<typeof lookerQueryToSlInputSchema>): string {
  const noun = input.contentType === 'dashboard_tile' ? 'dashboard tile' : 'look';
  return input.contentTitle ? `${noun} "${input.contentTitle}"` : noun;
}

function toSlName(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!normalized) {
    throw new Error(`Cannot derive semantic-layer name from empty Looker value`);
  }
  return /^[0-9]/.test(normalized) ? `n_${normalized}` : normalized;
}
