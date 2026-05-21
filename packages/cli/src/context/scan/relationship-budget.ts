export type KtxRelationshipValidationBudget = number | 'all' | undefined;

interface KtxRelationshipBudgetedCandidate<TCandidate> {
  candidate: TCandidate;
  originalIndex: number;
  score: number;
}

export interface KtxRelationshipValidationBudgetResult<TCandidate> {
  effectiveBudget: number | 'all';
  toValidate: KtxRelationshipBudgetedCandidate<TCandidate>[];
  deferred: KtxRelationshipBudgetedCandidate<TCandidate>[];
}

export interface ApplyKtxRelationshipValidationBudgetInput<TCandidate> {
  candidates: readonly TCandidate[];
  tableCount: number;
  budget?: KtxRelationshipValidationBudget;
  score: (candidate: TCandidate) => number;
}

/** @internal */
export function defaultKtxRelationshipValidationBudget(tableCount: number): number {
  const safeTableCount = Number.isFinite(tableCount) ? Math.max(0, Math.floor(tableCount)) : 0;
  return Math.min(2 * safeTableCount, 1000);
}

export function applyKtxRelationshipValidationBudget<TCandidate>(
  input: ApplyKtxRelationshipValidationBudgetInput<TCandidate>,
): KtxRelationshipValidationBudgetResult<TCandidate> {
  const ranked = input.candidates
    .map((candidate, originalIndex) => ({
      candidate,
      originalIndex,
      score: input.score(candidate),
    }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      return scoreDelta === 0 ? left.originalIndex - right.originalIndex : scoreDelta;
    });

  if (input.budget === 'all') {
    return {
      effectiveBudget: 'all',
      toValidate: input.candidates.map((candidate, originalIndex) => ({
        candidate,
        originalIndex,
        score: input.score(candidate),
      })),
      deferred: [],
    };
  }

  const effectiveBudget = input.budget ?? defaultKtxRelationshipValidationBudget(input.tableCount);
  const safeBudget = Math.max(0, Math.floor(effectiveBudget));
  return {
    effectiveBudget: safeBudget,
    toValidate: ranked.slice(0, safeBudget),
    deferred: ranked.slice(safeBudget),
  };
}
