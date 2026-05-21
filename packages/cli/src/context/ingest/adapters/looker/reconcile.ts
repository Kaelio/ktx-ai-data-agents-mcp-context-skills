export function buildLookerReconcileNotes(): string[] {
  return [
    [
      'Looker runtime API-derived SL sources use looker__<model>__<explore>.',
      'If the unprefixed file-adapter source <model>__<explore> exists, prefer it in wiki sl_refs, delete or avoid the API-derived source, and call emit_artifact_resolution with actionType="subsumed" for the API raw explore path.',
    ].join(' '),
  ];
}
