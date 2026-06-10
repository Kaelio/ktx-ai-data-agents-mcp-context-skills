import { isSlYamlPath } from '../../context/sl/source-files.js';
import type { SemanticLayerSource } from '../../context/sl/types.js';
import type { TouchedSlSource } from '../../context/tools/touched-sl-sources.js';
import type { IngestReportFinalizationMismatch } from './reports.js';

interface DeriveTouchedSourcesInput {
  changedPaths: string[];
  beforeSourcesByConnection: Map<string, SemanticLayerSource[]>;
  afterSourcesByConnection: Map<string, SemanticLayerSource[]>;
}

interface DeriveTouchedSourcesResult {
  touchedSources: TouchedSlSource[];
  unresolvedPaths: string[];
}

interface CompareFinalizationDeclarationsInput {
  declaredTouchedSources: TouchedSlSource[];
  derivedTouchedSources: TouchedSlSource[];
  declaredChangedWikiPageKeys: string[];
  derivedChangedWikiPageKeys: string[];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function touchedKey(source: TouchedSlSource): string {
  return `${source.connectionId}:${source.sourceName}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function changedSourceNames(
  beforeSources: SemanticLayerSource[],
  afterSources: SemanticLayerSource[],
): string[] {
  const before = new Map(beforeSources.map((source) => [source.name, stableJson(source)]));
  const after = new Map(afterSources.map((source) => [source.name, stableJson(source)]));
  return uniqueSorted(
    uniqueSorted([...before.keys(), ...after.keys()]).filter(
      (sourceName) => before.get(sourceName) !== after.get(sourceName),
    ),
  );
}

export function deriveFinalizationWikiPageKeys(paths: string[]): string[] {
  return uniqueSorted(
    paths
      .filter((path) => path.startsWith('wiki/global/') && path.endsWith('.md'))
      .filter((path) => !path.slice('wiki/global/'.length, -'.md'.length).includes('/'))
      .map((path) => path.slice('wiki/global/'.length, -'.md'.length)),
  );
}

// Source identity is the in-file `name:`; filenames are derived labels (see
// source-files.ts), so a changed path — manifest shard or standalone file —
// cannot be mapped to a source by parsing its filename. Instead, every changed
// semantic-layer file is attributed through the before/after diff of its
// connection's composed sources. A changed file whose connection diff is empty
// cannot be attributed to any source and is surfaced as unresolved.
export function deriveFinalizationTouchedSources(input: DeriveTouchedSourcesInput): DeriveTouchedSourcesResult {
  const touched = new Map<string, TouchedSlSource>();
  const unresolvedPaths: string[] = [];

  const pathsByConnection = new Map<string, string[]>();
  for (const path of input.changedPaths) {
    if (!path.startsWith('semantic-layer/') || !isSlYamlPath(path)) {
      continue;
    }
    const connectionId = path.split('/')[1] ?? '';
    if (!connectionId) {
      unresolvedPaths.push(path);
      continue;
    }
    pathsByConnection.set(connectionId, [...(pathsByConnection.get(connectionId) ?? []), path]);
  }

  for (const [connectionId, paths] of pathsByConnection) {
    const changedNames = changedSourceNames(
      input.beforeSourcesByConnection.get(connectionId) ?? [],
      input.afterSourcesByConnection.get(connectionId) ?? [],
    );
    if (changedNames.length === 0) {
      unresolvedPaths.push(...paths);
      continue;
    }
    for (const sourceName of changedNames) {
      touched.set(`${connectionId}:${sourceName}`, { connectionId, sourceName });
    }
  }

  return {
    touchedSources: [...touched.values()].sort((left, right) =>
      touchedKey(left).localeCompare(touchedKey(right)),
    ),
    unresolvedPaths: uniqueSorted(unresolvedPaths),
  };
}

export function compareFinalizationDeclarations(
  input: CompareFinalizationDeclarationsInput,
): IngestReportFinalizationMismatch[] {
  const mismatches: IngestReportFinalizationMismatch[] = [];
  const declaredSl = new Set(input.declaredTouchedSources.map(touchedKey));
  const derivedSl = new Set(input.derivedTouchedSources.map(touchedKey));
  const declaredWiki = new Set(input.declaredChangedWikiPageKeys);
  const derivedWiki = new Set(input.derivedChangedWikiPageKeys);

  for (const key of [...derivedSl].sort()) {
    if (!declaredSl.has(key)) {
      mismatches.push({ artifactKind: 'sl', key, direction: 'missing_from_adapter_declaration' });
    }
  }
  for (const key of [...declaredSl].sort()) {
    if (!derivedSl.has(key)) {
      mismatches.push({ artifactKind: 'sl', key, direction: 'extra_in_adapter_declaration' });
    }
  }
  for (const key of [...derivedWiki].sort()) {
    if (!declaredWiki.has(key)) {
      mismatches.push({ artifactKind: 'wiki', key, direction: 'missing_from_adapter_declaration' });
    }
  }
  for (const key of [...declaredWiki].sort()) {
    if (!derivedWiki.has(key)) {
      mismatches.push({ artifactKind: 'wiki', key, direction: 'extra_in_adapter_declaration' });
    }
  }
  return mismatches;
}
