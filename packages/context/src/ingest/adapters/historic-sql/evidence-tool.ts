import { tool } from 'ai';
import { z } from 'zod';
import { historicSqlEvidencePath, serializeHistoricSqlEvidence } from './evidence.js';
import { patternOutputSchema, tableUsageOutputSchema } from './skill-schemas.js';

const SYSTEM_AUTHOR = 'System User';
const SYSTEM_EMAIL = 'system@example.com';

function unitKeyForEvidence(input: { kind: string; table?: string; pattern?: { slug: string } }): string {
  if (input.kind === 'table_usage') {
    return `historic-sql-table-${String(input.table).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
  }
  return `historic-sql-pattern-${String(input.pattern?.slug).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

export function createEmitHistoricSqlEvidenceTool() {
  return tool({
    description:
      'Record typed historic-SQL evidence for deterministic projection. Use this instead of wiki_write, sl_write_source, sl_edit_source, or context_candidate_write during historic-SQL WorkUnits.',
    inputSchema: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('table_usage'),
        table: z.string().min(1),
        rawPath: z.string().min(1),
        usage: tableUsageOutputSchema,
      }),
      z.object({
        kind: z.literal('pattern'),
        rawPath: z.string().min(1),
        pattern: patternOutputSchema,
      }),
    ]),
    execute: async (input, options): Promise<string> => {
      const context = options.experimental_context as
        | {
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
        | undefined;
      const ingest = context?.session?.ingest;
      const configService = context?.session?.configService;
      if (!ingest || ingest.sourceKey !== 'historic-sql' || !configService || !context?.connectionId) {
        return 'Error: emit_historic_sql_evidence is only available during historic-sql ingest.';
      }

      const unitKey = unitKeyForEvidence(input);
      const content = serializeHistoricSqlEvidence({ ...input, connectionId: context.connectionId });
      await configService.writeFile(
        historicSqlEvidencePath(ingest.runId, unitKey),
        content,
        SYSTEM_AUTHOR,
        SYSTEM_EMAIL,
        `Record historic-SQL evidence: ${unitKey}`,
        { skipLock: true },
      );
      const label = input.kind === 'table_usage' ? input.table : input.pattern.slug;
      return `Recorded historic-SQL ${input.kind} evidence for ${label}.`;
    },
  });
}
