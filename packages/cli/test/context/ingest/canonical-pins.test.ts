import { describe, expect, it } from 'vitest';
import { buildCanonicalPinsPromptBlock, type CanonicalPin, selectRelevantCanonicalPins } from '../../../src/context/ingest/canonical-pins.js';
import type { StageIndex } from '../../../src/context/ingest/stages/stage-index.types.js';

function makeStageIndex(): StageIndex {
  return {
    jobId: 'job-1',
    connectionId: 'c1',
    workUnits: [
      {
        unitKey: 'wu-billing',
        rawFiles: ['metrics/billing.yml'],
        status: 'success',
        actions: [
          {
            target: 'sl',
            type: 'created',
            key: 'billing.churn_risk_score',
            detail: 'captured churn risk from billing',
          },
        ],
        touchedSlSources: [{ connectionId: 'c1', sourceName: 'billing' }],
      },
    ],
    conflictsResolved: [],
    evictionsApplied: [],
    unmappedFallbacks: [],
  };
}

const pins: CanonicalPin[] = [
  {
    contestedKey: 'churn_risk_score',
    canonicalArtifactKey: 'billing.churn_risk_score',
    pinnedAt: '2026-04-27T12:00:00.000Z',
    pinnedBy: 'user-1',
    reason: 'billing owns the contractual definition',
  },
  {
    contestedKey: 'gross_margin',
    canonicalArtifactKey: 'finance.gross_margin',
    pinnedAt: '2026-04-27T12:01:00.000Z',
    pinnedBy: 'user-2',
    reason: null,
  },
];

describe('canonical pins', () => {
  it('selects only pins relevant to the current Stage Index', () => {
    expect(selectRelevantCanonicalPins(makeStageIndex(), pins)).toEqual([pins[0]]);
  });

  it('keeps pins whose canonical artifact is mentioned even when contestedKey is absent', () => {
    const stageIndex = makeStageIndex();
    stageIndex.workUnits[0].actions[0].key = 'finance.gross_margin';
    stageIndex.workUnits[0].actions[0].detail = 'refreshed margin';

    expect(selectRelevantCanonicalPins(stageIndex, pins)).toEqual([pins[1]]);
  });

  it('formats a compact canonical_pins block for the reconciliation prompt', () => {
    expect(buildCanonicalPinsPromptBlock([pins[0]])).toBe(
      [
        '<canonical_pins>',
        '- contestedKey: churn_risk_score',
        '  canonicalArtifactKey: billing.churn_risk_score',
        '  reason: billing owns the contractual definition',
        '</canonical_pins>',
      ].join('\n'),
    );
  });

  it('omits the block when no relevant pins exist', () => {
    expect(buildCanonicalPinsPromptBlock([])).toBe('');
  });
});
