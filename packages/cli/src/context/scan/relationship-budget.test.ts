import { describe, expect, it } from 'vitest';
import { applyKtxRelationshipValidationBudget, defaultKtxRelationshipValidationBudget } from './relationship-budget.js';

interface Candidate {
  id: string;
  confidence: number;
}

describe('relationship validation budget', () => {
  it('computes the default validation budget from table count', () => {
    expect(defaultKtxRelationshipValidationBudget(0)).toBe(0);
    expect(defaultKtxRelationshipValidationBudget(3)).toBe(6);
    expect(defaultKtxRelationshipValidationBudget(400)).toBe(800);
    expect(defaultKtxRelationshipValidationBudget(900)).toBe(1000);
    expect(defaultKtxRelationshipValidationBudget(-4)).toBe(0);
    expect(defaultKtxRelationshipValidationBudget(3.8)).toBe(6);
  });

  it('splits candidates by descending score with stable tie ordering', () => {
    const result = applyKtxRelationshipValidationBudget<Candidate>({
      candidates: [
        { id: 'first', confidence: 0.8 },
        { id: 'second', confidence: 0.9 },
        { id: 'third', confidence: 0.9 },
        { id: 'fourth', confidence: 0.2 },
      ],
      tableCount: 100,
      budget: 2,
      score: (candidate) => candidate.confidence,
    });

    expect(result.effectiveBudget).toBe(2);
    expect(result.toValidate.map((entry) => entry.candidate.id)).toEqual(['second', 'third']);
    expect(result.deferred.map((entry) => entry.candidate.id)).toEqual(['first', 'fourth']);
    expect(result.toValidate.map((entry) => entry.originalIndex)).toEqual([1, 2]);
  });

  it('uses the default budget when the budget is omitted', () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      id: `candidate-${index}`,
      confidence: 1 - index / 10,
    }));

    const result = applyKtxRelationshipValidationBudget<Candidate>({
      candidates,
      tableCount: 2,
      score: (candidate) => candidate.confidence,
    });

    expect(result.effectiveBudget).toBe(4);
    expect(result.toValidate).toHaveLength(4);
    expect(result.deferred).toHaveLength(4);
  });

  it('treats budget zero as disabling SQL validation', () => {
    const result = applyKtxRelationshipValidationBudget<Candidate>({
      candidates: [
        { id: 'first', confidence: 1 },
        { id: 'second', confidence: 0.5 },
      ],
      tableCount: 10,
      budget: 0,
      score: (candidate) => candidate.confidence,
    });

    expect(result.effectiveBudget).toBe(0);
    expect(result.toValidate).toEqual([]);
    expect(result.deferred.map((entry) => entry.candidate.id)).toEqual(['first', 'second']);
  });

  it('treats budget all as validating every candidate', () => {
    const result = applyKtxRelationshipValidationBudget<Candidate>({
      candidates: [
        { id: 'first', confidence: 0.1 },
        { id: 'second', confidence: 0.9 },
      ],
      tableCount: 1,
      budget: 'all',
      score: (candidate) => candidate.confidence,
    });

    expect(result.effectiveBudget).toBe('all');
    expect(result.toValidate.map((entry) => entry.candidate.id)).toEqual(['first', 'second']);
    expect(result.deferred).toEqual([]);
  });
});
