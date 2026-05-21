import type { KtxModelRole } from '../../../llm/index.js';
import { type KtxLogger, noopLogger } from '../../core/index.js';
import type { AgentRunnerPort, KtxRuntimeToolSet } from '../../llm/index.js';
import type { MemoryAction } from '../../memory/index.js';
import type { ContextCandidateForDedup, CuratorPaginationPort, CuratorPaginationReport } from '../ports.js';
import type {
  ReconcileCandidateForPrompt,
  ReconcileCandidateSummary,
  ReconcilePromptRunState,
  WikiPageRef,
} from '../stages/build-reconcile-context.js';
import { type ReconciliationOutcome, runReconciliationStage4 } from '../stages/stage-4-reconciliation.js';
import type { StageIndex } from '../stages/stage-index.types.js';
import type { EvictionUnit } from '../types.js';
import type { ContextCandidateStorePort } from './store.js';
import type { ContextCandidateVerdictSummary, CuratorPaginationSettings } from './types.js';

interface CuratorPaginationBudget {
  creates: number;
  updates: number;
}

interface CuratorPaginationPromptInput {
  summary: ReconcileCandidateSummary;
  items: ReconcileCandidateForPrompt[];
  runState: ReconcilePromptRunState;
}

export interface CuratorPaginationInput {
  runId: string;
  sourceKey: string;
  jobId: string;
  stageIndex: StageIndex;
  evictionUnit: EvictionUnit | undefined;
  representatives: ContextCandidateForDedup[];
  initialBudget: CuratorPaginationBudget;
  modelRole: KtxModelRole;
  buildSystemPrompt: () => string;
  buildUserPrompt: (input: CuratorPaginationPromptInput) => string;
  buildToolSet: (passNumber: number) => KtxRuntimeToolSet;
  getReconciliationActions: () => MemoryAction[];
  onStepFinish?: (info: { passNumber: number; stepIndex: number; stepBudget: number }) => void;
}

interface CuratorPaginationResult extends ReconciliationOutcome {
  report: CuratorPaginationReport;
  warnings: string[];
}

export interface CuratorPaginationServiceDeps {
  store: ContextCandidateStorePort;
  agentRunner: AgentRunnerPort;
  settings: CuratorPaginationSettings;
  logger?: KtxLogger;
}

export class CuratorPaginationService implements CuratorPaginationPort {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: CuratorPaginationServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async reconcile(input: CuratorPaginationInput): Promise<CuratorPaginationResult> {
    const config = this.deps.settings;
    const representatives = [...input.representatives];
    const allCandidateKeys = representatives.map((candidate) => candidate.candidateKey);
    const budget: CuratorPaginationBudget = {
      creates: Math.max(0, input.initialBudget.creates),
      updates: Math.max(0, input.initialBudget.updates),
    };
    const previouslyPromotedInRun: WikiPageRef[] = [];
    const warnings: string[] = [];
    let passNumber = 0;
    let topicsExamined = 0;
    let budgetExhausted = budget.creates === 0 && budget.updates === 0;
    let stopReason: ReconciliationOutcome['stopReason'];
    let error: Error | undefined;
    let actionCursor = input.getReconciliationActions().length;

    if (representatives.length === 0 && !this.hasNonCandidateReconcileWork(input.stageIndex, input.evictionUnit)) {
      return this.result({
        skipped: true,
        stopReason,
        error,
        report: this.emptyReport(),
        warnings,
      });
    }

    if (representatives.length === 0) {
      passNumber = 1;
      const outcome = await this.runPass({
        input,
        candidates: [],
        passNumber,
        maxPasses: config.maxPasses,
        budget,
        previouslyPromotedInRun,
        forceRun: false,
      });
      stopReason = outcome.stopReason;
      error = outcome.error;
      return this.result({
        skipped: outcome.skipped,
        stopReason,
        error,
        report: this.emptyReport({ passesRun: outcome.skipped ? 0 : 1 }),
        warnings,
      });
    }

    const queue = [...representatives];
    while (queue.length > 0 && passNumber < config.maxPasses) {
      if (budget.creates === 0 && budget.updates === 0) {
        budgetExhausted = true;
        await this.deps.store.markPendingCandidatesByReason({
          runId: input.runId,
          candidateKeys: queue.map((candidate) => candidate.candidateKey),
          rejectionReason: 'exceeded_run_budget',
        });
        queue.length = 0;
        break;
      }

      const batch = queue.splice(0, config.batchSize);
      const batchKeys = batch.map((candidate) => candidate.candidateKey);
      passNumber += 1;
      topicsExamined += batch.length;

      const outcome = await this.runPass({
        input,
        candidates: batch,
        passNumber,
        maxPasses: config.maxPasses,
        budget,
        previouslyPromotedInRun,
        forceRun: true,
      });
      stopReason = outcome.stopReason;
      error = outcome.error;

      const actions = input.getReconciliationActions();
      const newWikiActions = actions
        .slice(actionCursor)
        .filter((action) => action.target === 'wiki' && (action.type === 'created' || action.type === 'updated'));
      actionCursor = actions.length;
      this.consumeBudget(budget, newWikiActions);
      previouslyPromotedInRun.push(...this.toWikiRefs(newWikiActions));

      if (outcome.stopReason === 'error' || outcome.error) {
        const message = `Curator pass ${passNumber} failed: ${outcome.error?.message ?? outcome.stopReason ?? 'unknown error'}`;
        warnings.push(message);
        this.logger.warn(message);
        await this.deps.store.markPendingCandidatesByReason({
          runId: input.runId,
          candidateKeys: batchKeys,
          rejectionReason: 'curator_pass_error',
        });
        continue;
      }

      if (budget.creates === 0 && budget.updates === 0) {
        budgetExhausted = true;
        await this.deps.store.markPendingCandidatesByReason({
          runId: input.runId,
          candidateKeys: [...batchKeys, ...queue.map((candidate) => candidate.candidateKey)],
          rejectionReason: 'exceeded_run_budget',
        });
        queue.length = 0;
        break;
      }
    }

    if (queue.length > 0) {
      await this.deps.store.markPendingCandidatesByReason({
        runId: input.runId,
        candidateKeys: queue.map((candidate) => candidate.candidateKey),
        rejectionReason: 'exceeded_curator_passes',
      });
    }

    await this.deps.store.markPendingCandidatesByReason({
      runId: input.runId,
      candidateKeys: allCandidateKeys,
      rejectionReason: 'exceeded_curator_passes',
    });

    const verdicts = await this.deps.store.summarizeCandidateVerdicts(input.runId, allCandidateKeys);
    const report = this.reportFromVerdicts({
      passesRun: passNumber,
      topicsExamined,
      budgetExhausted,
      verdicts,
    });

    this.logger.log(
      `Curator: ${report.passesRun} passes, ${report.topicsExamined} topics examined, ${report.topicsByVerdict.promoted} promoted`,
    );

    return this.result({
      skipped: false,
      stopReason,
      error,
      report,
      warnings,
    });
  }

  private async runPass(params: {
    input: CuratorPaginationInput;
    candidates: ContextCandidateForDedup[];
    passNumber: number;
    maxPasses: number;
    budget: CuratorPaginationBudget;
    previouslyPromotedInRun: WikiPageRef[];
    forceRun: boolean;
  }): Promise<ReconciliationOutcome> {
    const config = this.deps.settings;
    const candidateKeys = params.candidates.map((candidate) => candidate.candidateKey);
    const items = await this.deps.store.listCandidatesForPromptByKeys(params.input.runId, candidateKeys);
    const summary = this.batchSummary(items);

    return runReconciliationStage4({
      stageIndex: params.input.stageIndex,
      evictionUnit: params.input.evictionUnit,
      agentRunner: this.deps.agentRunner,
      buildSystemPrompt: () => params.input.buildSystemPrompt(),
      buildUserPrompt: () =>
        params.input.buildUserPrompt({
          summary,
          items,
          runState: {
            passNumber: params.passNumber,
            maxPasses: params.maxPasses,
            budgetRemaining: { ...params.budget },
            previouslyPromotedInRun: [...params.previouslyPromotedInRun],
          },
        }),
      buildToolSet: () => params.input.buildToolSet(params.passNumber),
      modelRole: params.input.modelRole,
      stepBudget: config.stepBudgetPerPass,
      sourceKey: params.input.sourceKey,
      jobId: params.input.jobId,
      forceRun: params.forceRun,
      onStepFinish: params.input.onStepFinish
        ? ({ stepIndex, stepBudget }) =>
            params.input.onStepFinish?.({ passNumber: params.passNumber, stepIndex, stepBudget })
        : undefined,
    });
  }

  private batchSummary(items: ReconcileCandidateForPrompt[]): ReconcileCandidateSummary {
    return items.reduce<ReconcileCandidateSummary>(
      (summary, item) => {
        summary.total += 1;
        if (item.status === 'pending') {
          summary.pending += 1;
        } else if (item.status === 'promoted') {
          summary.promoted += 1;
        } else if (item.status === 'merged') {
          summary.merged += 1;
        } else if (item.status === 'rejected') {
          summary.rejected += 1;
        } else if (item.status === 'conflict') {
          summary.conflict += 1;
        }
        return summary;
      },
      { total: 0, pending: 0, promoted: 0, merged: 0, rejected: 0, conflict: 0 },
    );
  }

  private hasNonCandidateReconcileWork(stageIndex: StageIndex, evictionUnit: EvictionUnit | undefined): boolean {
    return stageIndex.workUnits.some((wu) => wu.actions.length > 0) || !!evictionUnit?.deletedRawPaths.length;
  }

  private consumeBudget(budget: CuratorPaginationBudget, actions: MemoryAction[]): void {
    const creates = actions.filter((action) => action.type === 'created').length;
    const updates = actions.filter((action) => action.type === 'updated').length;
    budget.creates = Math.max(0, budget.creates - creates);
    budget.updates = Math.max(0, budget.updates - updates);
  }

  private toWikiRefs(actions: MemoryAction[]): WikiPageRef[] {
    return actions.map((action) => ({
      pageKey: action.key,
      action: action.type as 'created' | 'updated',
      summary: action.detail,
    }));
  }

  private reportFromVerdicts(params: {
    passesRun: number;
    topicsExamined: number;
    budgetExhausted: boolean;
    verdicts: ContextCandidateVerdictSummary;
  }): CuratorPaginationReport {
    return {
      passesRun: params.passesRun,
      topicsExamined: params.topicsExamined,
      topicsByVerdict: {
        promoted: params.verdicts.promoted,
        merged: params.verdicts.merged,
        rejected: params.verdicts.rejected,
        conflict: params.verdicts.conflict,
      },
      topicsRejectedByReason: params.verdicts.rejectedByReason,
      budgetExhausted: params.budgetExhausted,
    };
  }

  private emptyReport(overrides: Partial<CuratorPaginationReport> = {}): CuratorPaginationReport {
    return {
      passesRun: 0,
      topicsExamined: 0,
      topicsByVerdict: {
        promoted: 0,
        merged: 0,
        rejected: 0,
        conflict: 0,
      },
      topicsRejectedByReason: {},
      budgetExhausted: false,
      ...overrides,
    };
  }

  private result(result: CuratorPaginationResult): CuratorPaginationResult {
    return result;
  }
}
