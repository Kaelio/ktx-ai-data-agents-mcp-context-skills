import type { ChunkResult, DiffSet, WorkUnit } from '../../types.js';
import type { KtxSchemaTable } from '../../../scan/types.js';
import { LIVE_DATABASE_FOREIGN_KEYS_FILE, LIVE_DATABASE_META_FILE, readLiveDatabaseTableFiles } from './stage.js';

function unitKey(table: KtxSchemaTable): string {
  const parts = [table.catalog, table.db, table.name]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map((part) =>
      part
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean);
  return `live-database-${parts.join('-') || 'table'}`;
}

function displayName(table: KtxSchemaTable): string {
  return [table.catalog, table.db, table.name].filter(Boolean).join('.');
}

function isTablePath(path: string): boolean {
  return path.startsWith('tables/') && path.endsWith('.json');
}

export async function chunkLiveDatabaseStagedDir(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
  const tableFiles = await readLiveDatabaseTableFiles(stagedDir);
  const allTablePaths = tableFiles.map((file) => file.path);
  const globalDeps = [LIVE_DATABASE_META_FILE, LIVE_DATABASE_FOREIGN_KEYS_FILE];
  const touched = diffSet ? new Set([...diffSet.added, ...diffSet.modified]) : null;
  const globalTouched = Boolean(
    touched && (touched.has(LIVE_DATABASE_META_FILE) || touched.has(LIVE_DATABASE_FOREIGN_KEYS_FILE)),
  );

  const workUnits: WorkUnit[] = [];
  for (const file of tableFiles) {
    if (touched && !globalTouched && !touched.has(file.path)) {
      continue;
    }
    const peers = allTablePaths.filter((path) => path !== file.path).sort();
    workUnits.push({
      unitKey: unitKey(file.table),
      displayLabel: `Live database table ${displayName(file.table)}`,
      rawFiles: [file.path],
      peerFileIndex: peers,
      dependencyPaths: globalDeps,
      notes: `Database catalog snapshot for ${displayName(file.table)} with ${file.table.columns.length} column${
        file.table.columns.length === 1 ? '' : 's'
      }.`,
    });
  }

  const deletedRawPaths = diffSet ? diffSet.deleted.filter(isTablePath).sort() : [];
  return {
    workUnits,
    ...(deletedRawPaths.length > 0 ? { eviction: { deletedRawPaths } } : {}),
  };
}
