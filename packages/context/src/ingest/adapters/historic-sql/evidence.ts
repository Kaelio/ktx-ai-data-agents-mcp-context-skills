import { z } from 'zod';
import { patternOutputSchema, tableUsageOutputSchema } from './skill-schemas.js';

function safeEvidenceSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!segment) {
    throw new Error(`Invalid historic-SQL evidence path segment: ${value}`);
  }
  return segment;
}

export const historicSqlTableUsageEvidenceSchema = z.object({
  kind: z.literal('table_usage'),
  connectionId: z.string().min(1),
  table: z.string().min(1),
  rawPath: z.string().min(1),
  usage: tableUsageOutputSchema,
});
export type HistoricSqlTableUsageEvidence = z.infer<typeof historicSqlTableUsageEvidenceSchema>;

export const historicSqlPatternEvidenceSchema = z.object({
  kind: z.literal('pattern'),
  connectionId: z.string().min(1),
  rawPath: z.string().min(1),
  pattern: patternOutputSchema,
});
export type HistoricSqlPatternEvidence = z.infer<typeof historicSqlPatternEvidenceSchema>;

export const historicSqlEvidenceEnvelopeSchema = z.discriminatedUnion('kind', [
  historicSqlTableUsageEvidenceSchema,
  historicSqlPatternEvidenceSchema,
]);
export type HistoricSqlEvidenceEnvelope = z.infer<typeof historicSqlEvidenceEnvelopeSchema>;

export function historicSqlEvidencePath(runId: string, unitKey: string): string {
  return `.ktx/ingest-evidence/historic-sql/${safeEvidenceSegment(runId)}/${safeEvidenceSegment(unitKey)}.json`;
}

export function serializeHistoricSqlEvidence(evidence: HistoricSqlEvidenceEnvelope): string {
  return `${JSON.stringify(historicSqlEvidenceEnvelopeSchema.parse(evidence), null, 2)}\n`;
}
