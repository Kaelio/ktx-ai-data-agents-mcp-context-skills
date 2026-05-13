import type { Tool, ToolSet } from 'ai';
import { buildCanonicalPinsPromptBlock, type CanonicalPin } from '../canonical-pins.js';
import {
  createVerificationLedgerState,
  VERIFICATION_LEDGER_PROMPT,
  withVerificationLedger,
} from '../tools/verification-ledger.tool.js';
import type { EvictionUnit } from '../types.js';
import type { StageIndex } from './stage-index.types.js';

export function buildReconcileSystemPrompt(params: {
  baseFraming: string;
  skillsPrompt: string;
  syncId: string;
  sourceKey: string;
  canonicalPins: CanonicalPin[];
}): string {
  return [
    params.baseFraming.trimEnd(),
    VERIFICATION_LEDGER_PROMPT,
    params.skillsPrompt.trimEnd(),
    buildCanonicalPinsPromptBlock(params.canonicalPins),
    `\n<context>\nsyncId: ${params.syncId}\nsource: ${params.sourceKey}\n</context>`,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface ReconcileCandidateSummary {
  total: number;
  pending: number;
  promoted: number;
  merged: number;
  rejected: number;
  conflict: number;
}

export interface ReconcileCandidateForPrompt {
  candidateKey: string;
  topic: string;
  assertion: string;
  rationale: string;
  actionHint: string;
  status: string;
  promotionScore: number;
  suggestedPageKey: string | null;
  evidenceRefs: unknown;
}

export interface WikiPageRef {
  pageKey: string;
  action: 'created' | 'updated';
  summary: string;
}

export interface ReconcilePromptRunState {
  passNumber: number;
  maxPasses: number;
  budgetRemaining: {
    creates: number;
    updates: number;
  };
  previouslyPromotedInRun: WikiPageRef[];
}

const MAX_RECONCILE_EVIDENCE_REFS = 10;

function evidenceRefsSummary(evidenceRefs: unknown): string {
  if (!Array.isArray(evidenceRefs)) {
    return JSON.stringify(evidenceRefs);
  }

  const visible = evidenceRefs.slice(0, MAX_RECONCILE_EVIDENCE_REFS).map((ref) => {
    if (!ref || typeof ref !== 'object') {
      return ref;
    }
    const typed = ref as Record<string, unknown>;
    return {
      stableCitationKey: typed.stableCitationKey,
      rawPath: typed.rawPath,
      title: typed.title,
      path: typed.path,
      syncId: typed.syncId,
    };
  });
  const omitted = evidenceRefs.length - visible.length;
  const suffix = omitted > 0 ? ` (${omitted} more evidence refs omitted; use context_evidence_read for details)` : '';
  return `${JSON.stringify(visible)}${suffix}`;
}

function curatorPassStateSummary(runState?: ReconcilePromptRunState): string {
  if (!runState) {
    return '';
  }

  const previous =
    runState.previouslyPromotedInRun.length === 0
      ? '(none)'
      : runState.previouslyPromotedInRun
          .map((page) => `- ${page.pageKey} (${page.action}): ${page.summary}`)
          .join('\n');

  return [
    '# Curator Pass State',
    `pass: ${runState.passNumber} of ${runState.maxPasses}`,
    `budgetRemaining: creates=${runState.budgetRemaining.creates} updates=${runState.budgetRemaining.updates}`,
    'previouslyPromotedInRun:',
    previous,
    '',
  ].join('\n');
}

function formatStageActionDetail(detail: string): string {
  return detail.trim().replace(/\s+/g, ' ');
}

export function buildReconcileUserPrompt(
  stageIndex: StageIndex,
  ev: EvictionUnit | undefined,
  candidates?: { summary: ReconcileCandidateSummary; items: ReconcileCandidateForPrompt[] },
  sourceNotes: string[] = [],
  runState?: ReconcilePromptRunState,
): string {
  const wuLines =
    stageIndex.workUnits.length === 0
      ? '(no WorkUnits wrote anything)'
      : stageIndex.workUnits
          .map((wu) => {
            const actions =
              wu.actions.length === 0
                ? '  actions: (none)'
                : wu.actions
                    .map((a) => {
                      const detail = formatStageActionDetail(a.detail);
                      return detail.length > 0
                        ? `  - ${a.target}:${a.type} ${a.key}; detail: ${detail}`
                        : `  - ${a.target}:${a.type} ${a.key}`;
                    })
                    .join('\n');
            return `- unitKey: ${wu.unitKey} (status=${wu.status})\n${actions}`;
          })
          .join('\n');
  const evLines =
    !ev || ev.deletedRawPaths.length === 0 ? '(no deletions)' : ev.deletedRawPaths.map((p) => `- ${p}`).join('\n');
  const candidateLines =
    !candidates || candidates.items.length === 0
      ? '(no context knowledge candidates)'
      : [
          `summary: total=${candidates.summary.total} pending=${candidates.summary.pending} promoted=${candidates.summary.promoted} merged=${candidates.summary.merged} rejected=${candidates.summary.rejected} conflict=${candidates.summary.conflict}`,
          ...candidates.items.map(
            (candidate) =>
              `- candidateKey: ${candidate.candidateKey}\n` +
              `  topic: ${candidate.topic}\n` +
              `  status: ${candidate.status}\n` +
              `  actionHint: ${candidate.actionHint}\n` +
              `  promotionScore: ${candidate.promotionScore}\n` +
              `  suggestedPageKey: ${candidate.suggestedPageKey ?? '(none)'}\n` +
              `  assertion: ${candidate.assertion}\n` +
              `  rationale: ${candidate.rationale}\n` +
              `  evidenceRefs: ${evidenceRefsSummary(candidate.evidenceRefs)}`,
          ),
        ].join('\n');
  const sourceNoteLines =
    sourceNotes.length === 0
      ? '(no source-specific reconciliation notes)'
      : sourceNotes.map((note) => `- ${note}`).join('\n');
  return [
    '# Stage Index',
    wuLines,
    '',
    '# Eviction Set (deleted raw paths — look up artifacts via eviction_list)',
    evLines,
    '',
    curatorPassStateSummary(runState),
    '# Context Knowledge Candidates',
    candidateLines,
    '',
    '# Source Reconciliation Notes',
    sourceNoteLines,
  ].join('\n');
}

export interface ReconcileToolSetInput {
  loadSkillTool: Record<string, Tool>;
  stageListTool: Record<string, Tool>;
  stageDiffTool: Record<string, Tool>;
  evictionListTool: Record<string, Tool>;
  emitConflictResolutionTool: Record<string, Tool>;
  emitEvictionDecisionTool: Record<string, Tool>;
  emitArtifactResolutionTool: Record<string, Tool>;
  emitUnmappedFallbackTool: Record<string, Tool>;
  readRawSpanTool: Record<string, Tool>;
  toolsetTools: ToolSet;
}

export function buildReconcileToolSet(input: ReconcileToolSetInput): ToolSet {
  const state = createVerificationLedgerState();
  return withVerificationLedger(
    {
      ...input.toolsetTools,
      ...input.loadSkillTool,
      ...input.stageListTool,
      ...input.stageDiffTool,
      ...input.evictionListTool,
      ...input.emitConflictResolutionTool,
      ...input.emitEvictionDecisionTool,
      ...input.emitArtifactResolutionTool,
      ...input.emitUnmappedFallbackTool,
      ...input.readRawSpanTool,
    },
    state,
  );
}
