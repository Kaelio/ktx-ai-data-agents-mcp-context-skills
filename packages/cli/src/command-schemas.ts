import { z } from 'zod';

const projectDirSchema = z.string().min(1);
const safeConnectionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Unsafe connection id');
const stringArraySchema = z.array(z.string());

export const connectionAddCommandSchema = z.object({
  command: z.literal('add'),
  projectDir: projectDirSchema,
  driver: z.string().min(1),
  connectionId: safeConnectionIdSchema,
  url: z.string().optional(),
  schemas: stringArraySchema,
  readonly: z.boolean(),
  force: z.boolean(),
  allowLiteralCredentials: z.boolean(),
  notion: z
    .object({
      authTokenRef: z.string().min(1),
      crawlMode: z.enum(['all_accessible', 'selected_roots']),
      rootPageIds: stringArraySchema,
      rootDatabaseIds: stringArraySchema,
      rootDataSourceIds: stringArraySchema,
      maxPagesPerRun: z.number().int().positive().optional(),
      maxKnowledgeCreatesPerRun: z.number().int().nonnegative().optional(),
      maxKnowledgeUpdatesPerRun: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const wikiWriteCommandSchema = z.object({
  command: z.literal('write'),
  projectDir: projectDirSchema,
  key: z.string().min(1),
  scope: z.enum(['GLOBAL', 'USER']),
  userId: z.string().min(1),
  summary: z.string().min(1),
  content: z.string().min(1),
  tags: stringArraySchema,
  refs: stringArraySchema,
  slRefs: stringArraySchema,
});

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
  query: z.object({
    measures: z.array(z.string().min(1)).min(1),
    dimensions: stringArraySchema,
    filters: stringArraySchema.optional(),
    segments: stringArraySchema.optional(),
    order_by: z.array(orderBySchema).optional(),
    limit: z.number().int().positive().optional(),
    include_empty: z.literal(true).optional(),
  }),
  format: z.enum(['json', 'sql']),
  execute: z.boolean(),
  cliVersion: z.string().min(1),
  runtimeInstallPolicy: z.enum(['prompt', 'auto', 'never']),
  maxRows: z.number().int().positive().optional(),
});

export const publicIngestRunCommandSchema = z.object({
  command: z.literal('run'),
  projectDir: projectDirSchema,
  targetConnectionId: safeConnectionIdSchema.optional(),
  all: z.boolean(),
  json: z.boolean(),
  inputMode: z.enum(['auto', 'disabled']),
});

export const publicIngestReadCommandSchema = z.object({
  command: z.enum(['status', 'watch']),
  projectDir: projectDirSchema,
  runId: z.string().min(1).optional(),
  json: z.boolean(),
  inputMode: z.enum(['auto', 'disabled']),
});
