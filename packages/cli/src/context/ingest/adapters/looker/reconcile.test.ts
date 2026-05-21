import { describe, expect, it } from 'vitest';
import { buildLookerReconcileNotes } from './reconcile.js';

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
