import type { Dirent } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { getDriverRegistration } from '../../../connections/drivers.js';
import { parseDottedTableEntry } from '../../../scan/enabled-tables.js';
import { tableRefKey, tableRefSet, type KtxTableRefKey } from '../../../scan/table-ref.js';
import type { KtxTableRef } from '../../../scan/types.js';
import { readLiveDatabaseTableFiles } from '../live-database/stage.js';

export interface QueryHistoryScopeFloorInput {
  projectDir: string;
  connectionId: string;
  driver: string;
  connection: Record<string, unknown>;
  storedQueryHistory: Record<string, unknown>;
}

export interface QueryHistoryScopeFloor {
  enabledTables: KtxTableRef[];
  enabledTableKeys: ReadonlySet<KtxTableRefKey> | null;
  enabledSchemas: string[];
  modeledTableCatalog: KtxTableRef[];
  floorDisabled: boolean;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function tableRefsFromValues(values: unknown): KtxTableRef[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (typeof value === 'string') {
      const ref = parseDottedTableEntry(value);
      return ref ? [ref] : [];
    }
    if (isRecord(value) && typeof value.name === 'string' && value.name.length > 0) {
      return [
        {
          catalog: typeof value.catalog === 'string' ? value.catalog : null,
          db: typeof value.db === 'string' ? value.db : null,
          name: value.name,
        },
      ];
    }
    return [];
  });
}

function declaredSchemas(driver: string, connection: Record<string, unknown>): string[] {
  const key = getDriverRegistration(driver)?.scopeConfigKey;
  if (!key) return [];
  return [...new Set(stringArray(connection[key]))].sort();
}

function uniqueSortedTableRefs(refs: readonly KtxTableRef[]): KtxTableRef[] {
  const byKey = new Map<KtxTableRefKey, KtxTableRef>();
  for (const ref of refs) {
    byKey.set(tableRefKey(ref), ref);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, ref]) => ref);
}

async function latestLiveDatabaseScanDir(projectDir: string, connectionId: string): Promise<string | null> {
  const root = join(projectDir, 'raw-sources', connectionId, 'live-database');
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const syncDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const syncDir of syncDirs) {
    const absolute = join(root, syncDir);
    try {
      await access(join(absolute, 'connection.json'));
      return absolute;
    } catch {
      continue;
    }
  }
  return null;
}

async function scannedTableRefs(
  projectDir: string,
  connectionId: string,
): Promise<{ refs: KtxTableRef[]; catalogAvailable: boolean; warnings: string[] }> {
  const scanDir = await latestLiveDatabaseScanDir(projectDir, connectionId);
  if (!scanDir) {
    return { refs: [], catalogAvailable: false, warnings: [] };
  }
  try {
    const tableFiles = await readLiveDatabaseTableFiles(scanDir);
    return {
      refs: uniqueSortedTableRefs(
        tableFiles.map(({ table }) => ({ catalog: table.catalog, db: table.db, name: table.name })),
      ),
      catalogAvailable: true,
      warnings: [],
    };
  } catch (error) {
    return {
      refs: [],
      catalogAvailable: false,
      warnings: [
        `query_history_scope_floor_catalog_read_failed:live_database_scan:${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

async function listYamlFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
      .sort();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function refsFromManifest(content: string): KtxTableRef[] {
  const parsed = YAML.parse(content) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.tables)) return [];
  return Object.values(parsed.tables).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.table !== 'string') return [];
    const ref = parseDottedTableEntry(entry.table);
    return ref ? [ref] : [];
  });
}

function refsFromStandaloneSource(content: string): KtxTableRef[] {
  const parsed = YAML.parse(content) as unknown;
  if (!isRecord(parsed) || typeof parsed.table !== 'string') return [];
  const ref = parseDottedTableEntry(parsed.table);
  return ref ? [ref] : [];
}

async function semanticTableRefs(
  projectDir: string,
  connectionId: string,
): Promise<{ refs: KtxTableRef[]; warnings: string[] }> {
  const root = join(projectDir, 'semantic-layer', connectionId);
  const files = await listYamlFiles(root);
  const refs: KtxTableRef[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(join(root, file), 'utf-8');
      refs.push(...(file.startsWith('_schema/') ? refsFromManifest(content) : refsFromStandaloneSource(content)));
    } catch (error) {
      warnings.push(
        `query_history_scope_floor_catalog_read_failed:${file}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { refs: uniqueSortedTableRefs(refs), warnings };
}

export async function resolveQueryHistoryScopeFloor(input: QueryHistoryScopeFloorInput): Promise<QueryHistoryScopeFloor> {
  const explicitEnabledTables = [
    ...tableRefsFromValues(input.storedQueryHistory.enabledTables),
    ...tableRefsFromValues(input.connection.enabled_tables),
  ];
  const semanticTables = await semanticTableRefs(input.projectDir, input.connectionId);
  const scannedTables = await scannedTableRefs(input.projectDir, input.connectionId);
  const modeledTables = uniqueSortedTableRefs([
    ...semanticTables.refs,
    ...scannedTables.refs,
    ...explicitEnabledTables,
  ]);
  const warnings = [...semanticTables.warnings, ...scannedTables.warnings];

  if (explicitEnabledTables.length > 0) {
    return {
      enabledTables: explicitEnabledTables,
      enabledTableKeys: tableRefSet(explicitEnabledTables),
      enabledSchemas: [],
      modeledTableCatalog: modeledTables,
      floorDisabled: false,
      warnings,
    };
  }

  const explicitSchemas = stringArray(input.storedQueryHistory.enabledSchemas);
  if (explicitSchemas.includes('*')) {
    return {
      enabledTables: [],
      enabledTableKeys: null,
      enabledSchemas: ['*'],
      modeledTableCatalog: modeledTables,
      floorDisabled: true,
      warnings,
    };
  }
  if (explicitSchemas.length > 0) {
    if (!scannedTables.catalogAvailable || modeledTables.length === 0) {
      return {
        enabledTables: [],
        enabledTableKeys: null,
        enabledSchemas: ['*'],
        modeledTableCatalog: modeledTables,
        floorDisabled: true,
        warnings: [...warnings, 'query_history_scope_floor_disabled:catalog_unavailable'],
      };
    }
    return {
      enabledTables: [],
      enabledTableKeys: null,
      enabledSchemas: [...new Set(explicitSchemas)].sort(),
      modeledTableCatalog: modeledTables,
      floorDisabled: false,
      warnings,
    };
  }

  const schemas = new Set(declaredSchemas(input.driver, input.connection));
  for (const ref of semanticTables.refs) {
    if (ref.db) schemas.add(ref.db);
  }
  if (schemas.size > 0 && (!scannedTables.catalogAvailable || modeledTables.length === 0)) {
    return {
      enabledTables: [],
      enabledTableKeys: null,
      enabledSchemas: ['*'],
      modeledTableCatalog: modeledTables,
      floorDisabled: true,
      warnings: [...warnings, 'query_history_scope_floor_disabled:catalog_unavailable'],
    };
  }
  return {
    enabledTables: [],
    enabledTableKeys: null,
    enabledSchemas: [...schemas].sort(),
    modeledTableCatalog: modeledTables,
    floorDisabled: false,
    warnings,
  };
}
