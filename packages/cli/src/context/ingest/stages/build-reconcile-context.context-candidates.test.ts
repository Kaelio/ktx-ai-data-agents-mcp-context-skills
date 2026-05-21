import { describe, expect, it } from 'vitest';
import { buildReconcileUserPrompt } from './build-reconcile-context.js';

const emptyStageIndex = {
  jobId: 'job-1',
  connectionId: 'c1',
  workUnits: [],
  conflictsResolved: [],
  evictionsApplied: [],
  unmappedFallbacks: [],
};

describe('buildReconcileUserPrompt', () => {
  it('includes context knowledge candidates for curator reconciliation', () => {
    const prompt = buildReconcileUserPrompt(emptyStageIndex, undefined, {
      summary: { total: 1, pending: 1, promoted: 0, merged: 0, rejected: 0, conflict: 0 },
      items: [
        {
          candidateKey: 'revenue-definition',
          topic: 'Revenue',
          assertion: 'Booked revenue excludes refunds.',
          rationale: 'Finance policy is authoritative.',
          actionHint: 'create',
          status: 'pending',
          promotionScore: 10,
          suggestedPageKey: 'revenue-definition',
          evidenceRefs: [{ stableCitationKey: 'notion:page-1:policy:abc' }],
        },
      ],
    });

    expect(prompt).toContain('# Context Knowledge Candidates');
    expect(prompt).toContain('candidateKey: revenue-definition');
    expect(prompt).toContain('promotionScore: 10');
  });

  it('caps serialized candidate evidence refs in the prompt', () => {
    const prompt = buildReconcileUserPrompt(emptyStageIndex, undefined, {
      summary: { total: 1, pending: 1, promoted: 0, merged: 0, rejected: 0, conflict: 0 },
      items: [
        {
          candidateKey: 'large-evidence',
          topic: 'Large Evidence',
          assertion: 'Large evidence refs are summarized.',
          rationale: 'Avoid reconcile prompt bloat.',
          actionHint: 'create',
          status: 'pending',
          promotionScore: 10,
          suggestedPageKey: 'large-evidence',
          evidenceRefs: Array.from({ length: 25 }, (_, index) => ({
            stableCitationKey: `notion:page-${index}:policy`,
            rawPath: `pages/page-${index}/page.md`,
            largeMetadata: 'x'.repeat(500),
          })),
        },
      ],
    });

    expect(prompt).toContain('notion:page-0:policy');
    expect(prompt).toContain('15 more evidence refs omitted');
    expect(prompt).not.toContain('notion:page-24:policy');
    expect(prompt).not.toContain('largeMetadata');
  });

  it('includes source reconciliation notes after context candidates', () => {
    const prompt = buildReconcileUserPrompt(
      emptyStageIndex,
      undefined,
      {
        summary: { total: 0, pending: 0, promoted: 0, merged: 0, rejected: 0, conflict: 0 },
        items: [],
      },
      ['Notion maxKnowledgeCreatesPerRun=5', 'Notion maxKnowledgeUpdatesPerRun=20'],
    );

    expect(prompt).toContain('# Context Knowledge Candidates');
    expect(prompt).toContain('# Source Reconciliation Notes');
    expect(prompt.indexOf('# Source Reconciliation Notes')).toBeGreaterThan(
      prompt.indexOf('# Context Knowledge Candidates'),
    );
    expect(prompt).toContain('- Notion maxKnowledgeCreatesPerRun=5');
    expect(prompt).toContain('- Notion maxKnowledgeUpdatesPerRun=20');
  });

  it('includes curator pass state when supplied', () => {
    const prompt = buildReconcileUserPrompt(
      emptyStageIndex,
      undefined,
      {
        summary: { total: 2, pending: 2, promoted: 0, merged: 0, rejected: 0, conflict: 0 },
        items: [
          {
            candidateKey: 'revenue-definition',
            topic: 'Revenue',
            assertion: 'Booked revenue excludes refunds.',
            rationale: 'Finance policy is authoritative.',
            actionHint: 'create',
            status: 'pending',
            promotionScore: 10,
            suggestedPageKey: 'revenue-definition',
            evidenceRefs: [{ stableCitationKey: 'notion:page-1:policy:abc' }],
          },
        ],
      },
      ['Notion maxKnowledgeCreatesPerRun=5'],
      {
        passNumber: 2,
        maxPasses: 5,
        budgetRemaining: { creates: 3, updates: 18 },
        previouslyPromotedInRun: [
          { pageKey: 'revenue-policy', action: 'created', summary: 'Revenue policy' },
          { pageKey: 'support-handoff', action: 'updated', summary: 'Support handoff owner' },
        ],
      },
    );

    expect(prompt).toContain('# Curator Pass State');
    expect(prompt).toContain('pass: 2 of 5');
    expect(prompt).toContain('budgetRemaining: creates=3 updates=18');
    expect(prompt).toContain('- revenue-policy (created): Revenue policy');
    expect(prompt).toContain('- support-handoff (updated): Support handoff owner');
    expect(prompt.indexOf('# Context Knowledge Candidates')).toBeGreaterThan(prompt.indexOf('# Curator Pass State'));
  });
});
