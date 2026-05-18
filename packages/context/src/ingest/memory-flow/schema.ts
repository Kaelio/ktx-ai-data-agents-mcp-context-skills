import * as z from 'zod';
import type { MemoryFlowReplayInput } from './types.js';

export const memoryFlowRunStatusSchema = z.enum(['running', 'done', 'error']);

const memoryFlowEventTimestampShape = {
  emittedAt: z.string().datetime().optional(),
};

function eventSchema<T extends z.ZodRawShape>(shape: T): z.ZodObject<T & typeof memoryFlowEventTimestampShape> {
  return z.object({ ...shape, ...memoryFlowEventTimestampShape });
}

const memoryFlowReplayMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(['full', 'deterministic', 'replay', 'seeded']),
  origin: z.enum(['captured', 'packaged', 'synthetic-report']),
  timing: z.enum(['captured', 'synthetic', 'not-captured', 'prebuilt']),
  capturedAt: z.string().datetime().nullable(),
  sourceReportId: z.string().min(1).nullable(),
  sourceReportPath: z.string().min(1).nullable(),
  fallbackReason: z.string().min(1).nullable(),
});

export const memoryFlowEventSchema = z.discriminatedUnion('type', [
  eventSchema({
    type: z.literal('source_acquired'),
    adapter: z.string().min(1),
    trigger: z.string().min(1),
    fileCount: z.number().int().min(0),
  }),
  eventSchema({ type: z.literal('scope_detected'), fingerprint: z.string().nullable() }),
  eventSchema({
    type: z.literal('raw_snapshot_written'),
    syncId: z.string().min(1),
    rawFileCount: z.number().int().min(0),
  }),
  eventSchema({
    type: z.literal('diff_computed'),
    added: z.number().int().min(0),
    modified: z.number().int().min(0),
    deleted: z.number().int().min(0),
    unchanged: z.number().int().min(0),
  }),
  eventSchema({
    type: z.literal('chunks_planned'),
    chunkCount: z.number().int().min(0),
    workUnitCount: z.number().int().min(0),
    evictionCount: z.number().int().min(0),
  }),
  eventSchema({
    type: z.literal('stage_skipped'),
    stage: z.enum(['source', 'chunks', 'workUnits', 'actions', 'gates', 'saved']),
    reason: z.string().min(1),
  }),
  eventSchema({
    type: z.literal('stage_progress'),
    stage: z.enum([
      'source',
      'integration',
      'reconciliation',
      'post_processor',
      'wiki_sl_ref_repair',
      'final_gates',
      'save',
      'provenance',
      'report',
    ]),
    percent: z.number().min(0).max(100),
    message: z.string().min(1),
    transient: z.boolean().optional(),
  }),
  eventSchema({
    type: z.literal('work_unit_started'),
    unitKey: z.string().min(1),
    skills: z.array(z.string().min(1)),
    stepBudget: z.number().int().min(0),
  }),
  eventSchema({
    type: z.literal('work_unit_step'),
    unitKey: z.string().min(1),
    stepIndex: z.number().int().min(0),
    stepBudget: z.number().int().min(0),
  }),
  eventSchema({
    type: z.literal('candidate_action'),
    unitKey: z.string().min(1),
    target: z.enum(['wiki', 'sl']),
    action: z.string().min(1),
    key: z.string().min(1),
  }),
  eventSchema({
    type: z.literal('work_unit_finished'),
    unitKey: z.string().min(1),
    status: z.enum(['success', 'failed']),
    reason: z.string().optional(),
  }),
  eventSchema({
    type: z.literal('reconciliation_finished'),
    conflictCount: z.number().int().min(0),
    fallbackCount: z.number().int().min(0),
  }),
  eventSchema({
    type: z.literal('saved'),
    commitSha: z.string().nullable(),
    wikiCount: z.number().int().min(0),
    slCount: z.number().int().min(0),
  }),
  eventSchema({ type: z.literal('provenance_recorded'), rowCount: z.number().int().min(0) }),
  eventSchema({
    type: z.literal('report_created'),
    runId: z.string().min(1),
    reportPath: z.string().min(1).optional(),
  }),
]);

export const memoryFlowPlannedWorkUnitSchema = z.object({
  unitKey: z.string().min(1),
  rawFiles: z.array(z.string()),
  peerFileCount: z.number().int().min(0),
  dependencyCount: z.number().int().min(0),
});

export const memoryFlowActionDetailSchema = z.object({
  unitKey: z.string().min(1),
  target: z.enum(['wiki', 'sl']),
  action: z.enum(['created', 'updated', 'removed']),
  key: z.string().min(1),
  summary: z.string(),
  rawFiles: z.array(z.string()),
  status: z.enum(['success', 'failed']),
});

const memoryFlowProvenanceDetailSchema = z.object({
  rawPath: z.string(),
  artifactKind: z.enum(['sl', 'wiki']).nullable(),
  artifactKey: z.string().nullable(),
  actionType: z.string().min(1),
});

const memoryFlowTranscriptDetailSchema = z.object({
  unitKey: z.string().min(1),
  path: z.string().min(1),
  toolCallCount: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  toolNames: z.array(z.string()),
});

export const memoryFlowDetailSectionsSchema = z.object({
  actions: z.array(memoryFlowActionDetailSchema),
  provenance: z.array(memoryFlowProvenanceDetailSchema),
  transcripts: z.array(memoryFlowTranscriptDetailSchema),
});

export const memoryFlowReplayInputSchema: z.ZodType<MemoryFlowReplayInput> = z.object({
  metadata: memoryFlowReplayMetadataSchema.optional(),
  runId: z.string().min(1),
  connectionId: z.string().min(1),
  adapter: z.string().min(1),
  status: memoryFlowRunStatusSchema,
  sourceDir: z.string().nullable(),
  syncId: z.string().min(1),
  reportId: z.string().min(1).optional(),
  reportPath: z.string().min(1).optional(),
  errors: z.array(z.string()),
  events: z.array(memoryFlowEventSchema),
  plannedWorkUnits: z.array(memoryFlowPlannedWorkUnitSchema),
  details: memoryFlowDetailSectionsSchema,
});

export const memoryFlowStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: memoryFlowReplayInputSchema }),
  z.object({
    type: z.literal('closed'),
    status: memoryFlowRunStatusSchema,
    errors: z.array(z.string()),
  }),
]);

export type MemoryFlowStreamEvent = z.infer<typeof memoryFlowStreamEventSchema>;

export function parseMemoryFlowReplayInput(value: unknown): MemoryFlowReplayInput {
  const result = memoryFlowReplayInputSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid memory-flow replay input: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
