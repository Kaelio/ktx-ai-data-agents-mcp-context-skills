import { z } from 'zod';
import type { AgentRunnerPort, KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import type { ConstrainedRepairResult, RepairVerification } from './constrained-repair.js';
import { runConstrainedRepairLoop } from './constrained-repair.js';
import type { IngestTraceWriter } from './ingest-trace.js';

type FinalGateRepairKind = 'patch_semantic_gate' | 'final_artifact_gate';

export type FinalGateRepairResult = ConstrainedRepairResult;

export interface RepairFinalGateFailureInput {
  agentRunner: AgentRunnerPort;
  workdir: string;
  gateError: string;
  allowedPaths: string[];
  trace: IngestTraceWriter;
  repairKind: FinalGateRepairKind;
  /**
   * Re-runs the failed gate against the current worktree. The repair counts
   * as successful only when this passes — editing files is not the success
   * signal.
   */
  verify(changedPaths: string[]): Promise<RepairVerification>;
  maxAttempts?: number;
  stepBudget?: number;
  abortSignal?: AbortSignal;
}

function buildGateRepairSystemPrompt(): string {
  return `<role>
You repair one ktx isolated-diff artifact gate failure inside the integration worktree.
</role>

<rules>
- Use read_gate_error first.
- Read only files exposed by read_repair_file.
- Edit only paths exposed by write_repair_file.
- Prefer the smallest text edit that makes the gate pass.
- Preserve accepted work-unit, reconciliation, and deterministic projection content.
- Do not invent warehouse facts, business definitions, or semantic-layer entities.
- If the gate error requires choosing between conflicting facts without evidence, stop without editing.
</rules>`;
}

function buildGateRepairUserPrompt(input: {
  gateError: string;
  allowedPaths: string[];
  repairKind: FinalGateRepairKind;
  attempt: number;
  maxAttempts: number;
  previousFailure: string | null;
}): string {
  const previousFailureBlock = input.previousFailure
    ? `\nPrevious attempt did not pass the gate:\n${input.previousFailure}\n`
    : '';
  return `Repair isolated-diff artifact gates.

Repair kind: ${input.repairKind}
Attempt: ${input.attempt} of ${input.maxAttempts}

Allowed files:
${input.allowedPaths.map((path) => `- ${path}`).join('\n')}

Gate error:
${input.gateError}
${previousFailureBlock}
Use read_gate_error first. Then inspect only the allowed files, write the
minimal repaired content, and stop.`;
}

function buildReadGateErrorTool(gateError: string): KtxRuntimeToolSet {
  return {
    read_gate_error: {
      name: 'read_gate_error',
      description: 'Read the artifact gate failure that must be repaired.',
      inputSchema: z.object({}),
      execute: async () => ({
        markdown: gateError,
        structured: { gateError },
      }),
    },
  };
}

export function finalGateRepairPaths(input: {
  changedWikiPageKeys: string[];
  // Resolved by the caller: SL filenames are derived labels, so the repair
  // allowlist must carry the real on-disk paths, not name-interpolated ones.
  touchedSlSourcePaths: string[];
}): string[] {
  return [
    ...new Set([
      ...input.touchedSlSourcePaths,
      ...input.changedWikiPageKeys.map((pageKey) => `wiki/global/${pageKey}.md`),
    ]),
  ].sort();
}

export async function repairFinalGateFailure(
  input: RepairFinalGateFailureInput,
): Promise<FinalGateRepairResult> {
  return runConstrainedRepairLoop({
    agentRunner: input.agentRunner,
    workdir: input.workdir,
    allowedPaths: input.allowedPaths,
    trace: input.trace,
    tracePhase: 'gate_repair',
    traceEventName: 'gate_repair',
    traceData: {
      repairKind: input.repairKind,
      gateError: input.gateError,
    },
    systemPrompt: buildGateRepairSystemPrompt(),
    buildUserPrompt: ({ attempt, maxAttempts, previousFailure }) =>
      buildGateRepairUserPrompt({
        gateError: input.gateError,
        allowedPaths: [...input.allowedPaths].sort(),
        repairKind: input.repairKind,
        attempt,
        maxAttempts,
        previousFailure,
      }),
    buildExtraTools: () => buildReadGateErrorTool(input.gateError),
    verify: input.verify,
    noChangeFailureReason: 'gate repair completed without editing an allowed path',
    telemetryTags: {
      operationName: 'ingest-isolated-diff-gate-repair',
      source: input.trace.context.sourceKey,
      jobId: input.trace.context.jobId,
      repairKind: input.repairKind,
    },
    maxAttempts: input.maxAttempts,
    stepBudget: input.stepBudget ?? 16,
    abortSignal: input.abortSignal,
  });
}
