import { z } from 'zod';

const projectDirSchema = z.string().min(1);
const stringArraySchema = z.array(z.string());

const orderBySchema = z.union([
  z.string().min(1),
  z.object({
    field: z.string().min(1),
    direction: z.enum(['asc', 'desc']).optional(),
  }),
]);

export const slQueryCommandSchema = z.object({
  command: z.literal('query'),
  projectDir: projectDirSchema,
  connectionId: z.string().min(1).optional(),
  query: z
    .object({
      measures: z.array(z.string().min(1)).min(1),
      dimensions: stringArraySchema,
      filters: stringArraySchema.optional(),
      segments: stringArraySchema.optional(),
      order_by: z.array(orderBySchema).optional(),
      limit: z.number().int().positive().optional(),
      include_empty: z.literal(true).optional(),
    })
    .optional(),
  queryFile: z.string().min(1).optional(),
  format: z.enum(['json', 'sql']),
  execute: z.boolean(),
  cliVersion: z.string().min(1),
  runtimeInstallPolicy: z.enum(['prompt', 'auto', 'never']),
  maxRows: z.number().int().positive().optional(),
});
