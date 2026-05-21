import { z } from 'zod';

const parsedTargetTableReasonSchema = z.enum([
  'no_connection_mapping',
  'looker_template_unresolved',
  'derived_table_not_supported',
  'no_physical_table',
  'multiple_table_references',
  'unsupported_dialect',
  'parse_error',
]);

export const parsedTargetTableSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    catalog: z.string().nullable(),
    schema: z.string().nullable(),
    name: z.string().min(1),
    canonicalTable: z.string().min(1),
  }),
  z.object({
    ok: z.literal(false),
    reason: parsedTargetTableReasonSchema,
    detail: z.string().optional(),
  }),
]);

export type ParsedTargetTable = z.infer<typeof parsedTargetTableSchema>;
