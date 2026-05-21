import type { SemanticLayerSource } from '../sl/index.js';
import type { TouchedSlSource } from '../tools/index.js';
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

export async function deriveFinalizationTouchedSources(
  input: DeriveTouchedSourcesInput,
): Promise<DeriveTouchedSourcesResult> {
  const touched = new Map<string, TouchedSlSource>();
  const unresolvedPaths: string[] = [];

  for (const path of input.changedPaths) {
    if (!path.startsWith('semantic-layer/') || !(path.endsWith('.yaml') || path.endsWith('.yml'))) {
      continue;
    }
    const parts = path.split('/');
    const connectionId = parts[1] ?? '';
    if (!connectionId) {
      unresolvedPaths.push(path);
      continue;
    }
    if (parts[2] !== '_schema') {
      const fileName = parts.at(-1) ?? '';
      const sourceName = fileName.replace(/\.ya?ml$/, '');
      if (!sourceName) {
        unresolvedPaths.push(path);
        continue;
      }
      touched.set(`${connectionId}:${sourceName}`, { connectionId, sourceName });
      continue;
    }

    const changedNames = changedSourceNames(
      input.beforeSourcesByConnection.get(connectionId) ?? [],
      input.afterSourcesByConnection.get(connectionId) ?? [],
    );
    if (changedNames.length === 0) {
      unresolvedPaths.push(path);
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
