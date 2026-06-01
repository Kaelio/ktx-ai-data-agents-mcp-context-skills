import type { AgentRunnerPort, KtxRuntimeToolSet, RunLoopMetrics } from '../../../context/llm/runtime-port.js';
import type { KtxModelRole } from '../../../llm/types.js';
import type { EvictionUnit } from '../types.js';
import type { StageIndex } from './stage-index.types.js';

export interface ReconciliationContext {
  stageIndex: StageIndex;
  evictionUnit: EvictionUnit | undefined;
  agentRunner: AgentRunnerPort;
  buildSystemPrompt: (idx: StageIndex, ev: EvictionUnit | undefined) => string;
  buildUserPrompt: (idx: StageIndex, ev: EvictionUnit | undefined) => string;
  buildToolSet: () => KtxRuntimeToolSet;
  modelRole: KtxModelRole;
  stepBudget: number;
  sourceKey: string;
  jobId: string;
  force?: boolean;
  onStepFinish?: (info: { stepIndex: number; stepBudget: number }) => void;
  forceRun?: boolean;
}

export interface ReconciliationOutcome {
  skipped: boolean;
  stopReason?: 'budget' | 'natural' | 'error';
  error?: Error;
  metrics?: RunLoopMetrics;
}

export async function runReconciliationStage4(ctx: ReconciliationContext): Promise<ReconciliationOutcome> {
  const hasWrites = ctx.stageIndex.workUnits.some((wu) => wu.actions.length > 0);
  const hasEvictions = !!ctx.evictionUnit && ctx.evictionUnit.deletedRawPaths.length > 0;
  if (!ctx.force && !ctx.forceRun && !hasWrites && !hasEvictions) {
    return { skipped: true };
  }
  const run = await ctx.agentRunner.runLoop({
    modelRole: ctx.modelRole,
    systemPrompt: ctx.buildSystemPrompt(ctx.stageIndex, ctx.evictionUnit),
    userPrompt: ctx.buildUserPrompt(ctx.stageIndex, ctx.evictionUnit),
    toolSet: ctx.buildToolSet(),
    stepBudget: ctx.stepBudget,
    telemetryTags: { operationName: 'ingest-bundle-reconcile', source: ctx.sourceKey, jobId: ctx.jobId },
    onStepFinish: ctx.onStepFinish,
  });
  return { skipped: false, stopReason: run.stopReason, error: run.error, ...(run.metrics ? { metrics: run.metrics } : {}) };
}
