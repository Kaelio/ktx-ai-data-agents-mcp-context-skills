import { z } from 'zod';
import { createAgentTool } from '../../../agent/index.js';
import { historicSqlEvidencePath, serializeHistoricSqlEvidence } from './evidence.js';
import { patternOutputSchema, tableUsageOutputSchema } from './skill-schemas.js';

const SYSTEM_AUTHOR = 'System User';
const SYSTEM_EMAIL = 'system@example.com';

const emitHistoricSqlEvidenceInputSchema = z
  .object({
    kind: z.enum(['table_usage', 'pattern']),
    table: z.string().min(1).optional(),
    rawPath: z.string().min(1),
    usage: tableUsageOutputSchema.optional(),
    pattern: patternOutputSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.kind === 'table_usage') {
      if (!input.table) {
        ctx.addIssue({
          code: 'custom',
          path: ['table'],
          message: 'table is required when kind is table_usage',
        });
      }
      if (!input.usage) {
        ctx.addIssue({
          code: 'custom',
          path: ['usage'],
          message: 'usage is required when kind is table_usage',
        });
      }
    }
    if (input.kind === 'pattern' && !input.pattern) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: 'pattern is required when kind is pattern',
      });
    }
  });

type EmitHistoricSqlEvidenceInput = z.infer<typeof emitHistoricSqlEvidenceInputSchema>;

interface EmitHistoricSqlEvidenceToolContext {
  connectionId?: string | null;
  session?: {
    ingest?: { runId: string; sourceKey: string };
    configService?: {
      writeFile(
        path: string,
        content: string,
        author: string,
        authorEmail: string,
        commitMessage: string,
        options?: { skipLock?: boolean },
      ): Promise<unknown>;
    };
  };
}

function unitKeyForEvidence(input: EmitHistoricSqlEvidenceInput): string {
  if (input.kind === 'table_usage') {
    return `historic-sql-table-${String(input.table).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
  }
  return `historic-sql-pattern-${String(input.pattern?.slug).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

function evidenceEnvelope(input: EmitHistoricSqlEvidenceInput, connectionId: string) {
  if (input.kind === 'table_usage') {
    if (!input.table || !input.usage) {
      throw new Error('Invalid historic-SQL table usage evidence input.');
    }
    return {
      kind: 'table_usage' as const,
      connectionId,
      table: input.table,
      rawPath: input.rawPath,
      usage: input.usage,
    };
  }
  if (!input.pattern) {
    throw new Error('Invalid historic-SQL pattern evidence input.');
  }
  return {
    kind: 'pattern' as const,
    connectionId,
    rawPath: input.rawPath,
    pattern: input.pattern,
  };
}

export function createEmitHistoricSqlEvidenceTool(defaultContext?: EmitHistoricSqlEvidenceToolContext) {
  return createAgentTool({
    name: 'emit_historic_sql_evidence',
    description:
      'Record typed historic-SQL evidence for deterministic projection. Use this instead of wiki_write, sl_write_source, sl_edit_source, or context_candidate_write during historic-SQL WorkUnits.',
    inputSchema: emitHistoricSqlEvidenceInputSchema,
    execute: async (input, options): Promise<string> => {
      const context =
        ((options as { experimental_context?: EmitHistoricSqlEvidenceToolContext }).experimental_context ??
          defaultContext);
      const ingest = context?.session?.ingest;
      const configService = context?.session?.configService;
      if (!ingest || ingest.sourceKey !== 'historic-sql' || !configService || !context?.connectionId) {
        return 'Error: emit_historic_sql_evidence is only available during historic-sql ingest.';
      }

      const unitKey = unitKeyForEvidence(input);
      const evidence = evidenceEnvelope(input, context.connectionId);
      const content = serializeHistoricSqlEvidence(evidence);
      await configService.writeFile(
        historicSqlEvidencePath(ingest.runId, unitKey),
        content,
        SYSTEM_AUTHOR,
        SYSTEM_EMAIL,
        `Record historic-SQL evidence: ${unitKey}`,
        { skipLock: true },
      );
      const label = evidence.kind === 'table_usage' ? evidence.table : evidence.pattern.slug;
      return `Recorded historic-SQL ${input.kind} evidence for ${label}.`;
    },
  });
}
