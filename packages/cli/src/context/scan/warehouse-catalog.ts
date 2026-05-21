import { getDialectForDriver } from '../../context/connections/dialects.js';
import type { KtxFileStorePort } from '../../context/core/file-store.js';
import type {
  KtxConnectionDriver,
  KtxSchemaColumn,
  KtxSchemaForeignKey,
  KtxSchemaTable,
  KtxTableRef,
} from './types.js';

type CatalogDriver = KtxConnectionDriver | 'sqlite3';

export interface WarehouseCatalogServiceDeps {
  fileStore: KtxFileStorePort;
}

interface WarehouseColumnDetail extends KtxSchemaColumn {
  descriptions: Record<string, string>;
  rowCount: number | null;
  nullCount: number | null;
  distinctCount: number | null;
  nullRate: number | null;
  sampleValues: string[];
}

export interface TableDetail {
  connectionId: string;
  catalog: string | null;
  db: string | null;
  name: string;
  display: string;
  kind: string;
  comment: string | null;
  description: string | null;
  rowCount: number | null;
  columns: WarehouseColumnDetail[];
  foreignKeys: KtxSchemaForeignKey[];
}

export type RawSchemaHit =
  | {
      kind: 'table';
      connectionId: string;
      ref: KtxTableRef;
      display: string;
      matchedOn: 'name' | 'db' | 'comment' | 'description';
    }
  | {
      kind: 'column';
      connectionId: string;
      ref: KtxTableRef & { column: string };
      display: string;
      matchedOn: 'name' | 'comment' | 'description';
    };

export interface DisplayTargetResolution {
  resolved: (KtxTableRef & { column?: string }) | null;
  candidates: KtxTableRef[];
  dialect: string;
}

interface ConnectionArtifact {
  driver?: CatalogDriver;
}

interface RelationshipProfileColumn {
  table?: KtxTableRef;
  column?: string;
  rowCount?: number;
  nullCount?: number;
  distinctCount?: number;
  nullRate?: number;
  sampleValues?: unknown[];
}

interface RelationshipProfileArtifact {
  driver?: CatalogDriver;
  tables?: Array<{ table?: KtxTableRef; rowCount?: number }>;
  columns?: Record<string, RelationshipProfileColumn>;
}

interface ConnectionCatalog {
  connectionId: string;
  syncId: string;
  driver: CatalogDriver;
  tables: KtxSchemaTable[];
  profile: RelationshipProfileArtifact | null;
}

type TableWithDescriptions = KtxSchemaTable & {
  descriptions?: Record<string, string>;
  columns: Array<KtxSchemaColumn & { descriptions?: Record<string, string> }>;
};

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

function refsEqual(left: KtxTableRef, right: KtxTableRef): boolean {
  return (
    normalize(left.catalog) === normalize(right.catalog) &&
    normalize(left.db) === normalize(right.db) &&
    normalize(left.name) === normalize(right.name)
  );
}

function refKey(ref: KtxTableRef): string {
  return [ref.catalog, ref.db, ref.name].map((part) => normalize(part)).join('.');
}

function columnKey(ref: KtxTableRef, column: string): string {
  return `${refKey(ref)}.${normalize(column)}`;
}

function readJson<T>(content: string): T {
  return JSON.parse(content) as T;
}

function cleanIdentifierPart(part: string): string {
  return part.trim().replace(/^["'`\[]|["'`\]]$/g, '');
}

function splitDisplay(display: string): string[] {
  return display
    .trim()
    .split('.')
    .map(cleanIdentifierPart)
    .filter(Boolean);
}

function formatDisplay(driver: CatalogDriver, table: KtxTableRef): string {
  if (driver === 'sqlite' || driver === 'sqlite3') {
    return table.name;
  }
  return [table.catalog, table.db, table.name].filter((part): part is string => Boolean(part)).join('.');
}

function parseDisplay(driver: CatalogDriver, display: string): KtxTableRef | null {
  const parts = splitDisplay(display);
  if (driver === 'sqlite' || driver === 'sqlite3') {
    return parts.length === 1 ? { catalog: null, db: null, name: parts[0]! } : null;
  }
  if (driver === 'bigquery' || driver === 'snowflake' || driver === 'sqlserver') {
    if (parts.length !== 3) {
      return null;
    }
    return { catalog: parts[0]!, db: parts[1]!, name: parts[2]! };
  }
  if (parts.length === 2) {
    return { catalog: null, db: parts[0]!, name: parts[1]! };
  }
  if (parts.length === 3) {
    return { catalog: parts[0]!, db: parts[1]!, name: parts[2]! };
  }
  return parts.length === 1 ? { catalog: null, db: null, name: parts[0]! } : null;
}

function expectedDisplayPartCount(driver: CatalogDriver): number {
  if (driver === 'sqlite' || driver === 'sqlite3') {
    return 1;
  }
  if (driver === 'bigquery' || driver === 'snowflake' || driver === 'sqlserver') {
    return 3;
  }
  return 2;
}

function parseColumnDisplay(driver: CatalogDriver, display: string): (KtxTableRef & { column: string }) | null {
  const parts = splitDisplay(display);
  const tablePartCount = expectedDisplayPartCount(driver);
  if (parts.length !== tablePartCount + 1) {
    return null;
  }
  const column = parts.at(-1);
  if (!column) {
    return null;
  }
  const table = parseDisplay(driver, parts.slice(0, -1).join('.'));
  return table ? { ...table, column } : null;
}

function bestCandidates(tables: KtxSchemaTable[], display: string, limit = 5): KtxTableRef[] {
  const needle = normalize(splitDisplay(display).at(-1) ?? display);
  return tables
    .map((table) => {
      const name = normalize(table.name);
      let score = 0;
      if (name === needle) {
        score = 100;
      } else if (name.includes(needle) || needle.includes(name)) {
        score = 80;
      } else {
        const samePrefix = [...name].filter((char, index) => needle[index] === char).length;
        score = samePrefix / Math.max(name.length, needle.length, 1);
      }
      return { table, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.table.name.localeCompare(right.table.name))
    .slice(0, limit)
    .map(({ table }) => ({ catalog: table.catalog, db: table.db, name: table.name }));
}

function firstDescription(descriptions: Record<string, string> | undefined): string | null {
  return Object.values(descriptions ?? {}).find((value) => value.trim().length > 0) ?? null;
}

function matchedOnTable(table: TableWithDescriptions, query: string): RawSchemaHit['matchedOn'] | null {
  const q = normalize(query);
  if (!q) {
    return null;
  }
  if (normalize(table.name).includes(q)) {
    return 'name';
  }
  if (normalize(table.db).includes(q)) {
    return 'db';
  }
  if (normalize(table.comment).includes(q)) {
    return 'comment';
  }
  if (normalize(firstDescription(table.descriptions)).includes(q)) {
    return 'description';
  }
  return null;
}

function matchedOnColumn(
  column: KtxSchemaColumn & { descriptions?: Record<string, string> },
  query: string,
): 'name' | 'comment' | 'description' | null {
  const q = normalize(query);
  if (!q) {
    return null;
  }
  if (normalize(column.name).includes(q)) {
    return 'name';
  }
  if (normalize(column.comment).includes(q)) {
    return 'comment';
  }
  if (normalize(firstDescription(column.descriptions)).includes(q)) {
    return 'description';
  }
  return null;
}

export class WarehouseCatalogService {
  private readonly catalogs = new Map<string, Promise<ConnectionCatalog | null>>();

  constructor(private readonly deps: WarehouseCatalogServiceDeps) {}

  async hasScan(connectionId: string): Promise<boolean> {
    return (await this.loadCatalog(connectionId)) !== null;
  }

  async getLatestSyncId(connectionId: string): Promise<string | null> {
    return (await this.loadCatalog(connectionId))?.syncId ?? null;
  }

  async listTables(connectionId: string): Promise<KtxTableRef[]> {
    const catalog = await this.loadCatalog(connectionId);
    return catalog?.tables.map((table) => ({ catalog: table.catalog, db: table.db, name: table.name })) ?? [];
  }

  async getTable(ref: { connectionId: string } & KtxTableRef): Promise<TableDetail | null> {
    const catalog = await this.loadCatalog(ref.connectionId);
    if (!catalog) {
      return null;
    }
    const table = catalog.tables.find((candidate) => refsEqual(candidate, ref)) as TableWithDescriptions | undefined;
    if (!table) {
      return null;
    }
    const profileTables = catalog.profile?.tables ?? [];
    const profileTable = profileTables.find((candidate) => candidate.table && refsEqual(candidate.table, table));
    const profileColumns = catalog.profile?.columns ?? {};

    return {
      connectionId: ref.connectionId,
      catalog: table.catalog,
      db: table.db,
      name: table.name,
      display: formatDisplay(catalog.driver, table),
      kind: table.kind,
      comment: table.comment,
      description: firstDescription(table.descriptions),
      rowCount: profileTable?.rowCount ?? table.estimatedRows ?? null,
      columns: table.columns.map((rawColumn) => {
        const column = rawColumn as KtxSchemaColumn & { descriptions?: Record<string, string> };
        const profileColumn =
          profileColumns[columnKey(table, column.name)] ??
          Object.entries(profileColumns).find(
            ([key, value]) =>
              normalize(key) === `${normalize(table.name)}.${normalize(column.name)}` ||
              (value.table && refsEqual(value.table, table) && normalize(value.column) === normalize(column.name)),
          )?.[1];
        return {
          ...column,
          descriptions: column.descriptions ?? {},
          rowCount: profileColumn?.rowCount ?? null,
          nullCount: profileColumn?.nullCount ?? null,
          distinctCount: profileColumn?.distinctCount ?? null,
          nullRate: profileColumn?.nullRate ?? null,
          sampleValues: (profileColumn?.sampleValues ?? []).map((value) => String(value)),
        };
      }),
      foreignKeys: table.foreignKeys,
    };
  }

  async resolveDisplay(
    connectionId: string,
    display: string,
  ): Promise<{
    resolved: KtxTableRef | null;
    candidates: KtxTableRef[];
    dialect: string;
  }> {
    const catalog = await this.loadCatalog(connectionId);
    if (!catalog) {
      return { resolved: null, candidates: [], dialect: 'unknown' };
    }
    const dialect = getDialectForDriver(catalog.driver).type;
    const parsed = parseDisplay(catalog.driver, display);
    if (!parsed) {
      return { resolved: null, candidates: bestCandidates(catalog.tables, display), dialect };
    }
    const table = catalog.tables.find((candidate) => refsEqual(candidate, parsed));
    if (!table) {
      return { resolved: null, candidates: bestCandidates(catalog.tables, display), dialect };
    }
    return { resolved: { catalog: table.catalog, db: table.db, name: table.name }, candidates: [], dialect };
  }

  async resolveDisplayTarget(connectionId: string, display: string): Promise<DisplayTargetResolution> {
    const catalog = await this.loadCatalog(connectionId);
    if (!catalog) {
      return { resolved: null, candidates: [], dialect: 'unknown' };
    }

    const dialect = getDialectForDriver(catalog.driver).type;
    const tableResolution = await this.resolveDisplay(connectionId, display);
    if (tableResolution.resolved) {
      return tableResolution;
    }

    const parsedColumn = parseColumnDisplay(catalog.driver, display);
    if (!parsedColumn) {
      return { resolved: null, candidates: bestCandidates(catalog.tables, display), dialect };
    }

    const table = catalog.tables.find((candidate) => refsEqual(candidate, parsedColumn));
    if (!table) {
      return { resolved: null, candidates: bestCandidates(catalog.tables, display), dialect };
    }

    return {
      resolved: {
        catalog: table.catalog,
        db: table.db,
        name: table.name,
        column: parsedColumn.column,
      },
      candidates: [],
      dialect,
    };
  }

  async searchByName(connectionId: string, query: string, limit: number): Promise<RawSchemaHit[]> {
    const catalog = await this.loadCatalog(connectionId);
    if (!catalog) {
      return [];
    }
    const hits: RawSchemaHit[] = [];
    for (const table of catalog.tables as TableWithDescriptions[]) {
      const tableMatch = matchedOnTable(table, query);
      if (tableMatch) {
        hits.push({
          kind: 'table',
          connectionId,
          ref: { catalog: table.catalog, db: table.db, name: table.name },
          display: formatDisplay(catalog.driver, table),
          matchedOn: tableMatch,
        });
      }
      for (const column of table.columns) {
        const columnMatch = matchedOnColumn(column, query);
        if (!columnMatch) {
          continue;
        }
        hits.push({
          kind: 'column',
          connectionId,
          ref: { catalog: table.catalog, db: table.db, name: table.name, column: column.name },
          display: `${formatDisplay(catalog.driver, table)}.${column.name}`,
          matchedOn: columnMatch,
        });
      }
    }
    return hits.slice(0, Math.max(0, limit));
  }

  private loadCatalog(connectionId: string): Promise<ConnectionCatalog | null> {
    const existing = this.catalogs.get(connectionId);
    if (existing) {
      return existing;
    }
    const pending = this.readCatalog(connectionId);
    this.catalogs.set(connectionId, pending);
    return pending;
  }

  private async readCatalog(connectionId: string): Promise<ConnectionCatalog | null> {
    const root = `raw-sources/${connectionId}/live-database`;
    const listed = await this.deps.fileStore.listFiles(root);
    const connectionFiles = listed.files.filter((file) => file.endsWith('/connection.json')).sort();
    const latestConnectionPath = connectionFiles.at(-1);
    if (!latestConnectionPath) {
      return null;
    }
    const latestRoot = latestConnectionPath.slice(0, -'/connection.json'.length);
    const syncId = latestRoot.split('/').at(-1) ?? '';
    const connection = readJson<ConnectionArtifact>((await this.deps.fileStore.readFile(latestConnectionPath)).content);
    const tablesListing = await this.deps.fileStore.listFiles(`${latestRoot}/tables`);
    const tables: KtxSchemaTable[] = [];
    for (const tablePath of tablesListing.files.filter((file) => file.endsWith('.json')).sort()) {
      tables.push(readJson<KtxSchemaTable>((await this.deps.fileStore.readFile(tablePath)).content));
    }

    let profile: RelationshipProfileArtifact | null = null;
    try {
      profile = readJson<RelationshipProfileArtifact>(
        (await this.deps.fileStore.readFile(`${latestRoot}/enrichment/relationship-profile.json`)).content,
      );
    } catch {
      profile = null;
    }

    return {
      connectionId,
      syncId,
      driver: connection.driver ?? profile?.driver ?? 'postgres',
      tables,
      profile,
    };
  }
}
