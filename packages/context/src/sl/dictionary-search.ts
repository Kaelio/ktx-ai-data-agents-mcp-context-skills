import type { KtxLocalProject } from '../project/index.js';
import { loadLatestSlDictionaryEntries, type SlDictionaryEntry } from './sl-dictionary-profile.js';

export type KtxDictionarySearchStatus = 'ready' | 'no_profile_artifact' | 'no_candidate_columns';
export type KtxDictionarySearchMissReason = 'no_profile_artifact' | 'no_candidate_columns' | 'value_not_in_sample';

export interface KtxDictionarySearchInput {
  values: string[];
  connectionId?: string;
}

export interface KtxDictionarySearchCoverage {
  sampledRows: number | null;
  valuesPerColumn: number | null;
  profiledColumns: number;
  syncId: string | null;
  profiledAt: string | null;
}

export interface KtxDictionarySearchSearchedConnection {
  connectionId: string;
  coverage: KtxDictionarySearchCoverage;
  status: KtxDictionarySearchStatus;
}

export interface KtxDictionarySearchMatch {
  connectionId: string;
  sourceName: string;
  columnName: string;
  matchedValue: string;
  cardinality: number | null;
}

export interface KtxDictionarySearchMiss {
  connectionId: string;
  reason: KtxDictionarySearchMissReason;
}

export interface KtxDictionarySearchValueResult {
  value: string;
  matches: KtxDictionarySearchMatch[];
  misses: KtxDictionarySearchMiss[];
}

export interface KtxDictionarySearchResponse {
  searched: KtxDictionarySearchSearchedConnection[];
  results: KtxDictionarySearchValueResult[];
}

interface RelationshipProfileArtifact {
  connectionId?: string;
  profileSampleRows?: unknown;
  sampleValuesPerColumn?: unknown;
  profiledAt?: unknown;
  extractedAt?: unknown;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function latestProfileSyncId(path: string): string | null {
  const parts = path.split('/');
  return parts.at(-3) ?? null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
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

async function readProfile(project: KtxLocalProject, path: string): Promise<RelationshipProfileArtifact> {
  const raw = await project.fileStore.readFile(path);
  const parsed = JSON.parse(raw.content) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as RelationshipProfileArtifact)
    : {};
}

function profiledColumnCount(entries: readonly SlDictionaryEntry[]): number {
  return new Set(entries.map((entry) => `${entry.sourceName}\u001f${entry.columnName}`)).size;
}

async function searchedConnection(
  project: KtxLocalProject,
  connectionId: string,
  entries: readonly SlDictionaryEntry[],
): Promise<KtxDictionarySearchSearchedConnection> {
  const path = await latestProfilePath(project, connectionId);
  if (!path) {
    return {
      connectionId,
      coverage: {
        sampledRows: null,
        valuesPerColumn: null,
        profiledColumns: 0,
        syncId: null,
        profiledAt: null,
      },
      status: 'no_profile_artifact',
    };
  }

  const profile = await readProfile(project, path);
  const count = profiledColumnCount(entries);
  return {
    connectionId,
    coverage: {
      sampledRows: optionalNumber(profile.profileSampleRows),
      valuesPerColumn: optionalNumber(profile.sampleValuesPerColumn),
      profiledColumns: count,
      syncId: latestProfileSyncId(path),
      profiledAt: optionalString(profile.profiledAt) ?? optionalString(profile.extractedAt),
    },
    status: count > 0 ? 'ready' : 'no_candidate_columns',
  };
}

function entryMatchesValue(entry: SlDictionaryEntry, value: string): boolean {
  return entry.value.toLowerCase().includes(value.toLowerCase());
}

function toMatch(entry: SlDictionaryEntry): KtxDictionarySearchMatch {
  return {
    connectionId: entry.connectionId,
    sourceName: entry.sourceName,
    columnName: entry.columnName,
    matchedValue: entry.value,
    cardinality: entry.cardinality,
  };
}

function sortMatches(matches: KtxDictionarySearchMatch[]): KtxDictionarySearchMatch[] {
  return matches.sort(
    (left, right) =>
      left.connectionId.localeCompare(right.connectionId) ||
      left.sourceName.localeCompare(right.sourceName) ||
      left.columnName.localeCompare(right.columnName) ||
      left.matchedValue.localeCompare(right.matchedValue),
  );
}

function missReason(status: KtxDictionarySearchStatus): KtxDictionarySearchMissReason {
  return status === 'ready' ? 'value_not_in_sample' : status;
}

export function createKtxDictionarySearchService(project: KtxLocalProject): {
  search(input: KtxDictionarySearchInput): Promise<KtxDictionarySearchResponse>;
} {
  return {
    async search(input) {
      const connectionIds = input.connectionId
        ? [input.connectionId]
        : uniqueSorted(Object.keys(project.config.connections));
      const entries = await loadLatestSlDictionaryEntries(project, connectionIds);
      const entriesByConnection = new Map<string, SlDictionaryEntry[]>();
      for (const connectionId of connectionIds) {
        entriesByConnection.set(
          connectionId,
          entries.filter((entry) => entry.connectionId === connectionId),
        );
      }

      const searched = (
        await Promise.all(
          connectionIds.map((connectionId) =>
            searchedConnection(project, connectionId, entriesByConnection.get(connectionId) ?? []),
          ),
        )
      ).sort((left, right) => left.connectionId.localeCompare(right.connectionId));
      const searchedByConnection = new Map(searched.map((connection) => [connection.connectionId, connection]));

      return {
        searched,
        results: input.values.map((value) => {
          const matches = sortMatches(entries.filter((entry) => entryMatchesValue(entry, value)).map(toMatch));
          const matchedConnections = new Set(matches.map((match) => match.connectionId));
          return {
            value,
            matches,
            misses: searched
              .filter((connection) => !matchedConnections.has(connection.connectionId))
              .map((connection) => ({
                connectionId: connection.connectionId,
                reason: missReason(searchedByConnection.get(connection.connectionId)?.status ?? 'no_profile_artifact'),
              })),
          };
        }),
      };
    },
  };
}
