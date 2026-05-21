/** @internal */
export const rawSourcesRoot = 'raw-sources';

export function buildSyncId(now: Date, jobId: string): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}-${hh}${mm}${ss}-${jobId}`;
}

export function rawSourcesDirForSync(connectionId: string, sourceKey: string, syncId: string): string {
  return `${rawSourcesRoot}/${connectionId}/${sourceKey}/${syncId}`;
}

/** @internal */
export function provenanceMarker(rawPath: string, startLine: number, endLine: number): string {
  return `<!-- from: ${rawPath}#L${startLine}-${endLine} -->`;
}
