import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tableRefKey } from '../../../scan/table-ref.js';
import type { ChunkResult, DiffSet, ScopeDescriptor, WorkUnit } from '../../types.js';
import { isHistoricSqlPatternInputShardPath } from './pattern-inputs.js';
import { stagedManifestSchema, stagedPatternsInputSchema, stagedTableInputSchema } from './types.js';

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

async function readJson<T>(stagedDir: string, relPath: string): Promise<T> {
  return JSON.parse(await readFile(join(stagedDir, relPath), 'utf-8')) as T;
}

function safeUnitKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function touchedPath(path: string, touched: Set<string> | null): boolean {
  return !touched || touched.has(path);
}

export async function chunkHistoricSqlUnifiedStagedDir(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
  const files = await walk(stagedDir);
  const manifest = stagedManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
  const touched = diffSet ? new Set([...diffSet.added, ...diffSet.modified]) : null;
  const workUnits: WorkUnit[] = [];

  for (const path of files.filter((file) => /^tables\/.+\.json$/.test(file))) {
    if (!touchedPath(path, touched)) {
      continue;
    }
    const table = stagedTableInputSchema.parse(await readJson(stagedDir, path));
    workUnits.push({
      unitKey: `historic-sql-table-${safeUnitKey(tableRefKey(table.tableRef))}`,
      displayLabel: `Historic SQL usage: ${table.table}`,
      rawFiles: [path],
      dependencyPaths: ['manifest.json'],
      peerFileIndex: files.filter((file) => file !== path && file !== 'manifest.json').sort(),
      notes:
        'Use historic_sql_table_digest. Read this table usage JSON and emit exactly one table_usage object with emit_historic_sql_evidence. Do not call wiki_write or sl_write_source.',
    });
  }

  for (const path of files.filter(isHistoricSqlPatternInputShardPath)) {
    if (!touchedPath(path, touched)) {
      continue;
    }
    stagedPatternsInputSchema.parse(await readJson(stagedDir, path));
    const shardLabel = path.replace(/^patterns-input\//, '').replace(/\.json$/, '');
    workUnits.push({
      unitKey: `historic-sql-patterns-${safeUnitKey(shardLabel)}`,
      displayLabel: `Historic SQL cross-table patterns: ${shardLabel}`,
      rawFiles: [path],
      dependencyPaths: ['manifest.json'],
      peerFileIndex: files.filter((file) => file !== path && file !== 'manifest.json').sort(),
      notes:
        `Use historic_sql_patterns. Read ${path} and emit pattern objects with emit_historic_sql_evidence. Do not call wiki_write or sl_write_source.`,
    });
  }

  const deleted = diffSet?.deleted
    .filter((path) => isHistoricSqlPatternInputShardPath(path) || /^tables\/.+\.json$/.test(path))
    .sort();
  return {
    workUnits,
    eviction: deleted && deleted.length > 0 ? { deletedRawPaths: deleted } : undefined,
    reconcileNotes: [`Historic-SQL touched tables=${manifest.touchedTableCount} parseFailures=${manifest.parseFailures}`],
    contextReport: {
      capped: false,
      warnings: [...manifest.probeWarnings, ...manifest.warnings],
    },
  };
}

export async function describeHistoricSqlUnifiedScope(stagedDir: string): Promise<ScopeDescriptor> {
  const manifest = stagedManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      connectionId: manifest.connectionId,
      dialect: manifest.dialect,
      windowStart: manifest.windowStart,
      windowEnd: manifest.windowEnd,
    }))
    .digest('hex');
  return {
    fingerprint,
    isPathInScope: (rawPath) =>
      rawPath === 'manifest.json' ||
      rawPath === 'patterns-input.json' ||
      isHistoricSqlPatternInputShardPath(rawPath) ||
      /^tables\/.+\.json$/.test(rawPath),
  };
}
