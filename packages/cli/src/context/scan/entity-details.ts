import type { KtxLocalProject } from '../../context/project/project.js';
import { getDialectForDriver, type KtxDialect } from '../connections/dialects.js';
import { readLocalScanStructuralSnapshot } from './local-structural-artifacts.js';
import type {
  KtxScanReport,
  KtxSchemaColumn,
  KtxSchemaSnapshot,
  KtxSchemaTable,
  KtxTableRef,
} from './types.js';

export type KtxEntityDetailsTableInput = string | KtxTableRef;

export interface KtxEntityDetailsInput {
  connectionId: string;
  entities: Array<{
    table: KtxEntityDetailsTableInput;
    columns?: string[];
  }>;
}

export interface KtxEntityDetailsSnapshotInfo {
  syncId: string;
  extractedAt: string;
  scanRunId: string | null;
}

interface KtxEntityDetailsColumn {
  name: string;
  nativeType: string;
  normalizedType: string;
  dimensionType: KtxSchemaColumn['dimensionType'];
  nullable: boolean;
  primaryKey: boolean;
  comment: string | null;
}

interface KtxEntityDetailsRecord {
  ok: true;
  connectionId: string;
  tableRef: KtxTableRef;
  display: string;
  kind: KtxSchemaTable['kind'];
  comment: string | null;
  estimatedRows: number | null;
  columns: KtxEntityDetailsColumn[];
  foreignKeys: KtxSchemaTable['foreignKeys'];
  snapshot: KtxEntityDetailsSnapshotInfo;
}

type KtxEntityDetailsErrorCode = 'scan_missing' | 'table_not_found' | 'ambiguous_table' | 'column_not_found';

interface KtxEntityDetailsErrorResult {
  ok: false;
  connectionId: string;
  table: KtxEntityDetailsTableInput;
  snapshot?: KtxEntityDetailsSnapshotInfo;
  error: {
    code: KtxEntityDetailsErrorCode;
    message: string;
    candidates?: Array<{ tableRef: KtxTableRef; display: string }> | string[];
  };
}

export interface KtxEntityDetailsResponse {
  results: Array<KtxEntityDetailsRecord | KtxEntityDetailsErrorResult>;
}

interface LatestScan {
  report: KtxScanReport;
  snapshot: KtxSchemaSnapshot;
}

interface ResolveResult {
  table: KtxSchemaTable | null;
  error?: Omit<KtxEntityDetailsErrorResult['error'], 'message'> & { message: string };
}

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

function tableRef(table: KtxSchemaTable): KtxTableRef {
  return { catalog: table.catalog, db: table.db, name: table.name };
}

function candidateList(
  dialect: KtxDialect,
  tables: KtxSchemaTable[],
): Array<{ tableRef: KtxTableRef; display: string }> {
  return tables
    .map((table) => ({
      tableRef: tableRef(table),
      display: dialect.formatDisplayRef(table),
    }))
    .sort((left, right) => left.display.localeCompare(right.display));
}

function resolveTable(snapshot: KtxSchemaSnapshot, input: KtxEntityDetailsTableInput, dialect: KtxDialect): ResolveResult {
  if (typeof input !== 'string') {
    const table = snapshot.tables.find((candidate) => refsEqual(candidate, input)) ?? null;
    return table
      ? { table }
      : {
          table: null,
          error: {
            code: 'table_not_found',
            message: `Table not found in latest scan: ${dialect.formatDisplayRef(input)}`,
            candidates: candidateList(dialect, snapshot.tables),
          },
        };
  }

  const parsed = dialect.parseDisplayRef(input);
  if (parsed) {
    const table = snapshot.tables.find((candidate) => refsEqual(candidate, parsed)) ?? null;
    return table
      ? { table }
      : {
          table: null,
          error: {
            code: 'table_not_found',
            message: `Table not found in latest scan: ${input}`,
            candidates: candidateList(dialect, snapshot.tables),
          },
        };
  }

  const byName = snapshot.tables.filter((candidate) => normalize(candidate.name) === normalize(input));
  if (byName.length === 1) {
    return { table: byName[0]! };
  }
  if (byName.length > 1) {
    return {
      table: null,
      error: {
        code: 'ambiguous_table',
        message: `Table name "${input}" is ambiguous across schemas/catalogs; pass a structured table ref.`,
        candidates: candidateList(dialect, byName),
      },
    };
  }
  return {
    table: null,
    error: {
      code: 'table_not_found',
      message: `Table not found in latest scan: ${input}`,
      candidates: candidateList(dialect, snapshot.tables),
    },
  };
}

function toColumn(column: KtxSchemaColumn): KtxEntityDetailsColumn {
  return {
    name: column.name,
    nativeType: column.nativeType,
    normalizedType: column.normalizedType,
    dimensionType: column.dimensionType,
    nullable: column.nullable,
    primaryKey: column.primaryKey,
    comment: column.comment,
  };
}

function snapshotInfo(report: KtxScanReport, snapshot: KtxSchemaSnapshot): KtxEntityDetailsSnapshotInfo {
  return {
    syncId: report.syncId,
    extractedAt: snapshot.extractedAt,
    scanRunId: report.runId ?? null,
  };
}

async function readJson<T>(project: KtxLocalProject, path: string): Promise<T> {
  return JSON.parse((await project.fileStore.readFile(path)).content) as T;
}

async function latestScan(project: KtxLocalProject, connectionId: string): Promise<LatestScan | null> {
  const root = `raw-sources/${connectionId}/live-database`;
  let listed;
  try {
    listed = await project.fileStore.listFiles(root);
  } catch {
    return null;
  }
  const reportPath = listed.files.filter((path) => path.endsWith('/scan-report.json')).sort().at(-1);
  if (!reportPath) {
    return null;
  }
  const report = await readJson<KtxScanReport>(project, reportPath);
  const rawSourcesDir = report.artifactPaths.rawSourcesDir ?? reportPath.slice(0, -'/scan-report.json'.length);
  const snapshot = await readLocalScanStructuralSnapshot({
    project,
    connectionId,
    driver: report.driver,
    rawSourcesDir,
    extractedAtFallback: report.createdAt,
  });
  return { report, snapshot };
}

export function createKtxEntityDetailsService(project: KtxLocalProject) {
  return {
    async read(input: KtxEntityDetailsInput): Promise<KtxEntityDetailsResponse> {
      const scan = await latestScan(project, input.connectionId);
      if (!scan) {
        return {
          results: input.entities.map((entity) => ({
            ok: false,
            connectionId: input.connectionId,
            table: entity.table,
            error: {
              code: 'scan_missing',
              message: `No live-database scan found for connection "${input.connectionId}"; run \`ktx ingest ${input.connectionId}\` or \`ktx scan ${input.connectionId}\`.`,
            },
          })),
        };
      }

      const info = snapshotInfo(scan.report, scan.snapshot);
      const dialect = getDialectForDriver(scan.snapshot.driver);
      const results: KtxEntityDetailsResponse['results'] = [];
      for (const entity of input.entities) {
        const resolved = resolveTable(scan.snapshot, entity.table, dialect);
        if (!resolved.table) {
          results.push({
            ok: false,
            connectionId: input.connectionId,
            table: entity.table,
            snapshot: info,
            error: resolved.error!,
          });
          continue;
        }

        const requested = new Set((entity.columns ?? []).map((column) => normalize(column)));
        const columns = requested.size
          ? resolved.table.columns.filter((column) => requested.has(normalize(column.name)))
          : resolved.table.columns;
        if (requested.size && columns.length !== requested.size) {
          const found = new Set(columns.map((column) => normalize(column.name)));
          const missing = [...requested].filter((column) => !found.has(column));
          results.push({
            ok: false,
            connectionId: input.connectionId,
            table: entity.table,
            snapshot: info,
            error: {
              code: 'column_not_found',
              message: `Column(s) not found on ${dialect.formatDisplayRef(resolved.table)}: ${missing.join(', ')}`,
              candidates: resolved.table.columns.map((column) => column.name),
            },
          });
          continue;
        }

        results.push({
          ok: true,
          connectionId: input.connectionId,
          tableRef: tableRef(resolved.table),
          display: dialect.formatDisplayRef(resolved.table),
          kind: resolved.table.kind,
          comment: resolved.table.comment,
          estimatedRows: resolved.table.estimatedRows,
          columns: columns.map(toColumn),
          foreignKeys: resolved.table.foreignKeys,
          snapshot: info,
        });
      }
      return { results };
    },
  };
}
