import { describe, expect, it } from 'vitest';

import { normalizeSemanticLayerDescriptions } from '../../../src/context/sl/description-normalization.js';

/**
 * Build an overlay-shaped source (no `table`/`sql`) so the overlay fallback
 * branch is exercised. Measure/segment counts are derived from array length, so
 * the element contents are irrelevant to the summary.
 */
function overlaySource(measureCount: number, segmentCount = 0): Record<string, unknown> {
  return {
    name: 'mart_customer_health',
    measures: Array.from({ length: measureCount }, (_, i) => ({ name: `m${i}`, expr: 'count(*)' })),
    segments: Array.from({ length: segmentCount }, (_, i) => ({ name: `s${i}`, expr: 'true' })),
  };
}

function ktxSummary(source: Record<string, unknown>): string | undefined {
  const descriptions = source.descriptions;
  if (descriptions && typeof descriptions === 'object' && !Array.isArray(descriptions)) {
    const ktx = (descriptions as Record<string, unknown>).ktx;
    return typeof ktx === 'string' ? ktx : undefined;
  }
  return undefined;
}

describe('normalizeSemanticLayerDescriptions', () => {
  it('stores a count-free overlay summary so the count cannot drift', () => {
    const normalized = normalizeSemanticLayerDescriptions(overlaySource(4, 3), { fillMissing: true });
    // The live count is rendered from the body at list/read time; it must not be
    // frozen into the stored prose, where it would silently go stale.
    expect(ktxSummary(normalized)).toBe('Semantic-layer overlay for mart_customer_health.');
  });

  it('does not keep a stale measure count after measures are appended', () => {
    // First ingest pass writes the auto summary for a 4-measure overlay.
    const first = normalizeSemanticLayerDescriptions(overlaySource(4, 3), { fillMissing: true });

    // A later ingest/reconcile pass appends 2 measures to the same source (now 6)
    // and re-normalizes — exactly what sl_edit_source does with fillMissing.
    (first.measures as unknown[]).push({ name: 'm4', expr: 'count(*)' }, { name: 'm5', expr: 'count(*)' });
    const second = normalizeSemanticLayerDescriptions(first, { fillMissing: true });

    expect(ktxSummary(second)).not.toMatch(/4 measures/);
  });

  it('never overwrites a human-authored user description across re-normalization', () => {
    const input: Record<string, unknown> = {
      ...overlaySource(4),
      descriptions: { user: 'Health score per account, owned by RevOps.' },
    };
    const authored = normalizeSemanticLayerDescriptions(input, { fillMissing: true });
    expect(authored.descriptions).toEqual({ user: 'Health score per account, owned by RevOps.' });

    (authored.measures as unknown[]).push({ name: 'm4', expr: 'count(*)' });
    const again = normalizeSemanticLayerDescriptions(authored, { fillMissing: true });
    expect(again.descriptions).toEqual({ user: 'Health score per account, owned by RevOps.' });
  });

  it('never overwrites an authored ktx description even when it resembles the auto summary', () => {
    const input: Record<string, unknown> = {
      ...overlaySource(2),
      descriptions: { ktx: 'Curated overlay notes for the health mart.' },
    };
    const authored = normalizeSemanticLayerDescriptions(input, { fillMissing: true });
    expect(ktxSummary(authored)).toBe('Curated overlay notes for the health mart.');
  });

  it('still produces a sensible fallback for a source with no measures', () => {
    const normalized = normalizeSemanticLayerDescriptions({ name: 'mart_empty' }, { fillMissing: true });
    expect(ktxSummary(normalized)).toBe('Semantic-layer overlay for mart_empty.');
  });
});
