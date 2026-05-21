import { describe, expect, it } from 'vitest';
import { buildLookerReconcileNotes, lookerRuntimeSourceToFileAdapterSource } from './reconcile.js';

describe('lookerRuntimeSourceToFileAdapterSource', () => {
  it('maps API-derived Looker source names to file-adapter source names', () => {
    expect(lookerRuntimeSourceToFileAdapterSource('looker__b2b__sales_pipeline')).toBe('b2b__sales_pipeline');
    expect(lookerRuntimeSourceToFileAdapterSource('looker__finance__orders')).toBe('finance__orders');
  });

  it('ignores non-Looker and malformed source names', () => {
    expect(lookerRuntimeSourceToFileAdapterSource('b2b__sales_pipeline')).toBeNull();
    expect(lookerRuntimeSourceToFileAdapterSource('looker__missing_explore')).toBeNull();
  });
});

describe('buildLookerReconcileNotes', () => {
  it('instructs reconciliation to record subsumed provenance', () => {
    expect(buildLookerReconcileNotes()).toEqual([
      [
        'Looker runtime API-derived SL sources use looker__<model>__<explore>.',
        'If the unprefixed file-adapter source <model>__<explore> exists, prefer it in wiki sl_refs, delete or avoid the API-derived source, and call emit_artifact_resolution with actionType="subsumed" for the API raw explore path.',
      ].join(' '),
    ]);
  });
});
