export function lookerRuntimeSourceToFileAdapterSource(sourceName: string): string | null {
  if (!sourceName.startsWith('looker__')) {
    return null;
  }
  const stripped = sourceName.slice('looker__'.length);
  const parts = stripped.split('__');
  if (parts.length < 2 || parts.some((part) => part.length === 0)) {
    return null;
  }
  const [model, ...exploreParts] = parts;
  return `${model}__${exploreParts.join('__')}`;
}

export function buildLookerReconcileNotes(): string[] {
  return [
    [
      'Looker runtime API-derived SL sources use looker__<model>__<explore>.',
      'If the unprefixed file-adapter source <model>__<explore> exists, prefer it in wiki sl_refs, delete or avoid the API-derived source, and call emit_artifact_resolution with actionType="subsumed" for the API raw explore path.',
    ].join(' '),
  ];
}
