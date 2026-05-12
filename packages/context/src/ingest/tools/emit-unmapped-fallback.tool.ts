import { tool } from 'ai';
import { z } from 'zod';
import type { StageIndex, UnmappedFallbackRecord, UnmappedFallbackReason } from '../stages/stage-index.types.js';

interface EmitUnmappedFallbackDeps {
  stageIndex: StageIndex;
  allowedPaths: ReadonlySet<string>;
}

const unmappedFallbackReasonSchema = z.enum([
  'no_connection_mapping',
  'looker_template_unresolved',
  'derived_table_not_supported',
  'no_physical_table',
  'multiple_table_references',
  'unsupported_dialect',
  'parse_error',
  'missing_target_table',
]);

function sameUnmappedFallback(left: UnmappedFallbackRecord, right: UnmappedFallbackRecord): boolean {
  return left.rawPath === right.rawPath && left.reason === right.reason && left.fallback === right.fallback;
}

// Generates a canonical description for each reason so the recorded `detail`
// is always consistent with the reason code. Free-form text from the LLM
// previously caused contradictions like "no_physical_table" being explained
// as "no mapped connection exists" — the tool now owns the core sentence and
// the LLM may add optional clarification context.
function canonicalDetail(reason: UnmappedFallbackReason, tableRef: string | undefined): string {
  const tableClause = tableRef ? `'${tableRef}'` : 'the referenced object';
  switch (reason) {
    case 'no_physical_table':
      return `${tableClause} is described but is not present as a source in any mapped warehouse/dbt connection.`;
    case 'no_connection_mapping':
      return `${tableClause} has no non-Notion warehouse/dbt connection to map against.`;
    case 'missing_target_table':
      return `${tableClause} is referenced but the target table could not be located.`;
    case 'looker_template_unresolved':
      return `${tableClause} uses LookML templating that could not be resolved.`;
    case 'derived_table_not_supported':
      return `${tableClause} is a derived/inline definition that is not yet supported as a semantic-layer source.`;
    case 'multiple_table_references':
      return `${tableClause} references multiple tables; cannot map to a single source.`;
    case 'unsupported_dialect':
      return `${tableClause} uses a SQL dialect that is not yet supported.`;
    case 'parse_error':
      return `${tableClause} could not be parsed.`;
  }
}

export function createEmitUnmappedFallbackTool(deps: EmitUnmappedFallbackDeps) {
  return tool({
    description:
      'Record one unmapped fallback decision for the final IngestReport. The rawPath must be available to the current ingest stage. The tool generates the canonical detail from the structured reason and optional tableRef; use clarification only to add context that does not contradict the reason code.',
    inputSchema: z.object({
      rawPath: z.string().min(1),
      reason: unmappedFallbackReasonSchema,
      tableRef: z
        .string()
        .optional()
        .describe('The fully-qualified table or source reference that triggered the fallback (e.g. "orbit_analytics.customer"). Used to generate canonical detail text.'),
      clarification: z
        .string()
        .optional()
        .describe('Optional extra context appended to the canonical detail. Must not contradict the reason code.'),
      fallback: z.enum(['sql_standalone', 'wiki_only', 'flagged']),
    }),
    execute: async (input): Promise<string> => {
      if (!deps.allowedPaths.has(input.rawPath)) {
        return `Error: rawPath "${input.rawPath}" is not available to this ingest stage`;
      }

      const base = canonicalDetail(input.reason, input.tableRef);
      const detail = input.clarification ? `${base} ${input.clarification.trim()}`.trim() : base;

      const record: UnmappedFallbackRecord = {
        rawPath: input.rawPath,
        reason: input.reason,
        detail,
        fallback: input.fallback,
      };
      if (!deps.stageIndex.unmappedFallbacks.some((candidate) => sameUnmappedFallback(candidate, record))) {
        deps.stageIndex.unmappedFallbacks.push(record);
      }
      return `recorded unmapped fallback for ${record.rawPath} (${record.fallback}): ${detail}`;
    },
  });
}
