import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { getDriverRegistration } from '../../../connections/drivers.js';
import { parseDottedTableEntry } from '../../../scan/enabled-tables.js';
import { tableRefKey, tableRefSet, type KtxTableRefKey } from '../../../scan/table-ref.js';
import type { KtxTableRef } from '../../../scan/types.js';

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

async function modeledTableRefs(
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
  const seen = new Set<KtxTableRefKey>();
  const unique: KtxTableRef[] = [];
  for (const ref of refs) {
    const key = tableRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return { refs: unique, warnings };
}

export async function resolveQueryHistoryScopeFloor(input: QueryHistoryScopeFloorInput): Promise<QueryHistoryScopeFloor> {
  const explicitEnabledTables = [
    ...tableRefsFromValues(input.storedQueryHistory.enabledTables),
    ...tableRefsFromValues(input.connection.enabled_tables),
  ];
  const { refs: modeledTables, warnings } = await modeledTableRefs(input.projectDir, input.connectionId);
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
  for (const ref of modeledTables) {
    if (ref.db) schemas.add(ref.db);
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
