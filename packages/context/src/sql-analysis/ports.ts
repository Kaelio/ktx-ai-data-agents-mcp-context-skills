export type SqlAnalysisDialect =
  | 'bigquery'
  | 'snowflake'
  | 'postgres'
  | 'redshift'
  | 'mysql'
  | 'sqlite'
  | 'tsql'
  | 'clickhouse'
  | (string & {});

export type SqlAnalysisLiteralSlotType = 'string' | 'number' | 'timestamp' | 'date' | 'boolean' | 'null' | 'unknown';

export interface SqlAnalysisLiteralSlot {
  position: number;
  type: SqlAnalysisLiteralSlotType;
  exampleValue: string;
}

export interface SqlAnalysisFingerprintResult {
  fingerprint: string;
  normalizedSql: string;
  tablesTouched: string[];
  literalSlots: SqlAnalysisLiteralSlot[];
  error?: string | null;
}

export type SqlAnalysisClause = 'select' | 'where' | 'join' | 'groupBy' | 'having' | 'orderBy' | (string & {});

export interface SqlAnalysisBatchItem {
  id: string;
  sql: string;
}

export interface SqlAnalysisBatchResult {
  tablesTouched: string[];
  columnsByClause: Partial<Record<SqlAnalysisClause, string[]>>;
  error?: string | null;
}

export interface SqlReadOnlyValidationResult {
  ok: boolean;
  error?: string | null;
}

export interface SqlAnalysisPort {
  analyzeForFingerprint(sql: string, dialect: SqlAnalysisDialect): Promise<SqlAnalysisFingerprintResult>;
  analyzeBatch(
    items: SqlAnalysisBatchItem[],
    dialect: SqlAnalysisDialect,
  ): Promise<Map<string, SqlAnalysisBatchResult>>;
  validateReadOnly(sql: string, dialect: SqlAnalysisDialect): Promise<SqlReadOnlyValidationResult>;
}
