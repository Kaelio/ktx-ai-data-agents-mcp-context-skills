import { describe, expect, it } from 'vitest';
import {
  calibrateWeightsFromSyntheticFixtures,
  defaultKtxRelationshipScoreWeights,
  normalizeKtxRelationshipScoreWeights,
  scoreKtxRelationshipCandidate,
  type KtxRelationshipSignalVector,
} from './relationship-scoring.js';

function signals(overrides: Partial<KtxRelationshipSignalVector> = {}): KtxRelationshipSignalVector {
  return {
    nameSimilarity: 0.5,
    typeCompatibility: 1,
    valueOverlap: 0,
    embeddingSimilarity: 0,
    profileUniqueness: 0.5,
    profileNullRate: 0.5,
    structuralPrior: 0.5,
    ...overrides,
  };
}

describe('relationship scoring', () => {
  it('scores stronger evidence higher without hard-gating on names', () => {
    const weakNameStrongProfile = scoreKtxRelationshipCandidate(
      signals({
        nameSimilarity: 0.05,
        typeCompatibility: 1,
        valueOverlap: 0.7,
        profileUniqueness: 1,
        profileNullRate: 1,
        structuralPrior: 0.7,
      }),
    );
    const strongNameWeakProfile = scoreKtxRelationshipCandidate(
      signals({
        nameSimilarity: 0.95,
        typeCompatibility: 1,
        valueOverlap: 0,
        profileUniqueness: 0.3,
        profileNullRate: 0.4,
        structuralPrior: 0.5,
      }),
    );

    expect(weakNameStrongProfile.score).toBeGreaterThan(strongNameWeakProfile.score);
    expect(weakNameStrongProfile.contributions.profileUniqueness).toBeGreaterThan(0);
    expect(weakNameStrongProfile.contributions.nameSimilarity).toBeLessThan(0.02);
  });

  it('normalizes partial and invalid weights into a usable vector', () => {
    const weights = normalizeKtxRelationshipScoreWeights({
      nameSimilarity: 3,
      typeCompatibility: -1,
      valueOverlap: Number.POSITIVE_INFINITY,
      profileUniqueness: 1,
    });

    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(weights.nameSimilarity).toBeGreaterThan(weights.profileUniqueness);
    expect(weights.typeCompatibility).toBe(0);
    expect(weights.valueOverlap).toBe(0);
  });

  it('returns deterministic defaults as a defensive copy', () => {
    const first = defaultKtxRelationshipScoreWeights();
    const second = defaultKtxRelationshipScoreWeights();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.values(first).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
  });

  it('calibrates only from synthetic observations', () => {
    expect(() =>
      calibrateWeightsFromSyntheticFixtures([
        {
          fixtureId: 'chinook_with_declared_metadata',
          origin: 'public',
          expectedRelationship: true,
          signals: signals({ nameSimilarity: 1 }),
        },
      ]),
    ).toThrow(/synthetic/i);
  });

  it('calibrates deterministic weights from positive and negative synthetic observations', () => {
    const weights = calibrateWeightsFromSyntheticFixtures([
      {
        fixtureId: 'synthetic_positive',
        origin: 'synthetic',
        expectedRelationship: true,
        signals: signals({ nameSimilarity: 0.8, valueOverlap: 0.9, profileUniqueness: 1, profileNullRate: 1 }),
      },
      {
        fixtureId: 'synthetic_negative',
        origin: 'synthetic',
        expectedRelationship: false,
        signals: signals({ nameSimilarity: 0.2, valueOverlap: 0.1, profileUniqueness: 0.4, profileNullRate: 0.5 }),
      },
    ]);

    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    expect(weights.valueOverlap).toBeGreaterThan(weights.structuralPrior);
    expect(weights.profileUniqueness).toBeGreaterThan(weights.embeddingSimilarity);
  });
});
