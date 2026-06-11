import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentRunnerPort, KtxRuntimeToolSet } from '../../../context/llm/runtime-port.js';
import type {
  ConstrainedRepairResult,
  ConstrainedRepairToolContext,
  RepairVerification,
} from '../constrained-repair.js';
import { buildDeleteRepairFileTool, runConstrainedRepairLoop } from '../constrained-repair.js';
import type { IngestTraceWriter } from '../ingest-trace.js';

export type TextualConflictResolutionResult = ConstrainedRepairResult;

export interface ResolveTextualConflictInput {
  agentRunner: AgentRunnerPort;
  workdir: string;
  unitKey: string;
  patchPath: string;
  touchedPaths: string[];
  trace: IngestTraceWriter;
  reason: string;
  /**
   * Re-runs the artifact gates against the current worktree. A resolution —
   * including an explicit no-change declaration for a redundant patch —
   * counts as successful only when this passes.
   */
  verify(changedPaths: string[]): Promise<RepairVerification>;
  maxAttempts?: number;
  stepBudget?: number;
  abortSignal?: AbortSignal;
}

function buildResolverSystemPrompt(): string {
  return `<role>
You repair one failed KTX isolated-diff patch inside the integration worktree.
</role>

<rules>
- Preserve accepted integration content that is unrelated to the failed patch.
- Incorporate the failed patch only when the patch evidence is compatible with the current file.
- If the current file already represents everything the failed patch contributes (for example a
  duplicate page created by another work unit), call declare_patch_redundant instead of editing.
- Edit only paths exposed by the resolver tools.
- Prefer the smallest text edit that makes the composed artifact coherent.
- Do not create new facts that are absent from the current file or failed patch.
- Stop after writing the repaired file content or declaring the patch redundant.
</rules>`;
}

function buildResolverUserPrompt(input: {
  unitKey: string;
  patchPath: string;
  touchedPaths: string[];
  reason: string;
  attempt: number;
  maxAttempts: number;
  previousFailure: string | null;
}): string {
  const previousFailureBlock = input.previousFailure
    ? `\nPrevious attempt did not pass the artifact gates:\n${input.previousFailure}\n`
    : '';
  return `Repair isolated-diff textual conflict.

WorkUnit: ${input.unitKey}
Attempt: ${input.attempt} of ${input.maxAttempts}
Patch path: ${input.patchPath}
Touched paths:
${input.touchedPaths.map((path) => `- ${path}`).join('\n')}

Git apply failure:
${input.reason}
${previousFailureBlock}
Use read_failed_patch first. Then read the touched integration files and either
write the repaired content or, when the patch adds nothing the current files do
not already cover, call declare_patch_redundant. Then stop.`;
}

function buildResolverExtraTools(input: {
  patchPath: string;
  context: ConstrainedRepairToolContext;
}): KtxRuntimeToolSet {
  const declareSchema = z.object({
    reason: z
      .string()
      .min(1)
      .describe('Why the integration tree already represents everything this patch contributes.'),
  });
  return {
    read_failed_patch: {
      name: 'read_failed_patch',
      description: 'Read the failed Git patch that could not be applied to the integration worktree.',
      inputSchema: z.object({}),
      execute: async () => {
        const patch = await readFile(input.patchPath, 'utf-8');
        return {
          markdown: patch,
          structured: { patchPath: input.patchPath, bytes: Buffer.byteLength(patch) },
        };
      },
    },
    ...buildDeleteRepairFileTool(input.context),
    declare_patch_redundant: {
      name: 'declare_patch_redundant',
      description:
        'Declare that the failed patch needs no integration because the current worktree already ' +
        'represents its content (for example a duplicate page created by another work unit).',
      inputSchema: declareSchema,
      execute: async ({ reason }: z.infer<typeof declareSchema>) => {
        input.context.declareNoChange(reason);
        return {
          markdown: `Declared patch redundant: ${reason}`,
          structured: { reason },
        };
      },
    },
  };
}

export async function resolveTextualConflict(
  input: ResolveTextualConflictInput,
): Promise<TextualConflictResolutionResult> {
  const sortedTouchedPaths = [...input.touchedPaths].sort();
  return runConstrainedRepairLoop({
    agentRunner: input.agentRunner,
    workdir: input.workdir,
    allowedPaths: input.touchedPaths,
    trace: input.trace,
    tracePhase: 'resolver',
    traceEventName: 'textual_conflict_resolver',
    traceData: {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths: sortedTouchedPaths,
      reason: input.reason,
    },
    systemPrompt: buildResolverSystemPrompt(),
    buildUserPrompt: ({ attempt, maxAttempts, previousFailure }) =>
      buildResolverUserPrompt({
        unitKey: input.unitKey,
        patchPath: input.patchPath,
        touchedPaths: sortedTouchedPaths,
        reason: input.reason,
        attempt,
        maxAttempts,
        previousFailure,
      }),
    buildExtraTools: (context) => buildResolverExtraTools({ patchPath: input.patchPath, context }),
    verify: input.verify,
    noChangeFailureReason: 'resolver completed without editing an allowed path or declaring the patch redundant',
    telemetryTags: {
      operationName: 'ingest-isolated-diff-textual-resolver',
      source: input.trace.context.sourceKey,
      jobId: input.trace.context.jobId,
      unitKey: input.unitKey,
    },
    maxAttempts: input.maxAttempts,
    stepBudget: input.stepBudget ?? 12,
    abortSignal: input.abortSignal,
  });
}
