import type { KtxLocalProject } from '../../context/project/project.js';
import { defaultKtxDataDictionarySettings, isKtxDataDictionaryCandidate } from '../../context/scan/data-dictionary.js';

export interface SlDictionaryEntry {
  connectionId: string;
  sourceName: string;
  columnName: string;
  value: string;
  cardinality: number | null;
}

interface RelationshipProfileColumn {
  table?: { name?: string };
  column?: string;
  nativeType?: string;
  normalizedType?: string;
  distinctCount?: number;
  sampleValues?: unknown[];
}

interface RelationshipProfileArtifact {
  connectionId?: string;
  columns?: Record<string, RelationshipProfileColumn>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProfile(raw: string): RelationshipProfileArtifact | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return null;
  }
  return parsed as RelationshipProfileArtifact;
}

function normalizedValues(values: unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const text = String(value).trim();
    const key = text.toLowerCase();
    if (text.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function columnEntries(connectionId: string, column: RelationshipProfileColumn): SlDictionaryEntry[] {
  const sourceName = column.table?.name;
  const columnName = column.column;
  if (!sourceName || !columnName) {
    return [];
  }

  const columnType = column.normalizedType ?? column.nativeType ?? '';
  if (!isKtxDataDictionaryCandidate(columnType, columnName)) {
    return [];
  }

  const cardinality = typeof column.distinctCount === 'number' ? column.distinctCount : null;
  if (cardinality !== null && cardinality > defaultKtxDataDictionarySettings.cardinalityThreshold) {
    return [];
  }

  return normalizedValues(column.sampleValues).map((value) => ({
    connectionId,
    sourceName,
    columnName,
    value,
    cardinality,
  }));
}

async function latestProfilePath(project: KtxLocalProject, connectionId: string): Promise<string | null> {
  const root = `raw-sources/${connectionId}/live-database`;
  let files: string[];
  try {
    files = (await project.fileStore.listFiles(root)).files;
  } catch {
    return null;
  }

  return (
    files
      .filter((path) => path.endsWith('/enrichment/relationship-profile.json'))
      .sort((left, right) => left.localeCompare(right))
      .at(-1) ?? null
  );
}

export async function loadLatestSlDictionaryEntries(
  project: KtxLocalProject,
  connectionIds: readonly string[],
): Promise<SlDictionaryEntry[]> {
  const entries: SlDictionaryEntry[] = [];
  for (const connectionId of [...new Set(connectionIds)].sort()) {
    const path = await latestProfilePath(project, connectionId);
    if (!path) {
      continue;
    }
    const raw = await project.fileStore.readFile(path);
    const profile = parseProfile(raw.content);
    const profileConnectionId = profile?.connectionId ?? connectionId;
    for (const column of Object.values(profile?.columns ?? {})) {
      entries.push(...columnEntries(profileConnectionId, column));
    }
  }
  return entries.sort(
    (left, right) =>
      left.connectionId.localeCompare(right.connectionId) ||
      left.sourceName.localeCompare(right.sourceName) ||
      left.columnName.localeCompare(right.columnName) ||
      left.value.localeCompare(right.value),
  );
}
