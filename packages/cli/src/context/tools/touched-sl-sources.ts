export interface TouchedSlSource {
  connectionId: string;
  sourceName: string;
}

export type TouchedSlSourceSet = Map<string, Set<string>>;

export function createTouchedSlSources(entries: TouchedSlSource[] = []): TouchedSlSourceSet {
  const touched: TouchedSlSourceSet = new Map();
  for (const entry of entries) {
    addTouchedSlSource(touched, entry.connectionId, entry.sourceName);
  }
  return touched;
}

export function addTouchedSlSource(touched: TouchedSlSourceSet, connectionId: string, sourceName: string): void {
  const bucket = touched.get(connectionId) ?? new Set<string>();
  bucket.add(sourceName);
  touched.set(connectionId, bucket);
}

export function deleteTouchedSlSource(touched: TouchedSlSourceSet, connectionId: string, sourceName: string): void {
  const bucket = touched.get(connectionId);
  if (!bucket) {
    return;
  }
  bucket.delete(sourceName);
  if (bucket.size === 0) {
    touched.delete(connectionId);
  }
}

export function hasTouchedSlSource(touched: TouchedSlSourceSet, connectionId: string, sourceName: string): boolean {
  return touched.get(connectionId)?.has(sourceName) ?? false;
}

export function listTouchedSlSources(touched: TouchedSlSourceSet): TouchedSlSource[] {
  const out: TouchedSlSource[] = [];
  for (const [connectionId, sources] of touched) {
    for (const sourceName of sources) {
      out.push({ connectionId, sourceName });
    }
  }
  return out.sort((left, right) => {
    const byConnection = left.connectionId.localeCompare(right.connectionId);
    return byConnection === 0 ? left.sourceName.localeCompare(right.sourceName) : byConnection;
  });
}

export function touchedSlSourceCount(touched: TouchedSlSourceSet): number {
  let total = 0;
  for (const sources of touched.values()) {
    total += sources.size;
  }
  return total;
}

export function touchedSlSourceNamesForConnection(touched: TouchedSlSourceSet, connectionId: string): string[] {
  return [...(touched.get(connectionId) ?? [])].sort();
}
