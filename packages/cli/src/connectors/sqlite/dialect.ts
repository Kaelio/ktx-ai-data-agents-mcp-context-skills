import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/index.js';

type SqliteTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export class KtxSqliteDialect {
  readonly type = 'sqlite';

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    DATETIME: 'time',
    DATE: 'time',
    TIMESTAMP: 'time',
    TIME: 'time',
    INTEGER: 'number',
    INT: 'number',
    REAL: 'number',
    NUMERIC: 'number',
    FLOAT: 'number',
    DOUBLE: 'number',
    TEXT: 'string',
    VARCHAR: 'string',
    CHAR: 'string',
    BLOB: 'string',
    BOOLEAN: 'boolean',
    BOOL: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: SqliteTableNameRef): string {
    return this.quoteIdentifier(table.name);
  }

  mapDataType(nativeType: string): string {
    return nativeType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    let normalized = nativeType.toUpperCase().trim();
    if (normalized.includes('(')) {
      normalized = normalized.split('(')[0];
    }
    if (this.typeMappings[normalized]) {
      return this.typeMappings[normalized];
    }
    if (normalized.includes('TIME') || normalized.includes('DATE')) {
      return 'time';
    }
    if (
      normalized.includes('INT') ||
      normalized.includes('NUM') ||
      normalized.includes('REAL') ||
      normalized.includes('FLOAT') ||
      normalized.includes('DOUBLE')
    ) {
      return 'number';
    }
    if (normalized.includes('BOOL')) {
      return 'boolean';
    }
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT ${columnList} FROM ${tableName} LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quoted = this.quoteIdentifier(columnName);
    return `SELECT ${quoted} FROM ${tableName} WHERE ${quoted} IS NOT NULL AND TRIM(CAST(${quoted} AS TEXT)) != '' LIMIT ${limit}`;
  }

  prepareQuery(sql: string, params?: Record<string, unknown>): { sql: string; params?: unknown } {
    return params ? { sql, params } : { sql };
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `(RANDOM() % 100) < ${Math.round(samplePct * 100)}`;
  }

  getTableSampleClause(_samplePct: number): string {
    return '';
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return offset !== undefined && offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  }

  getNullCountExpression(column: string): string {
    return `SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END)`;
  }

  getDistinctCountExpression(column: string): string {
    return `COUNT(DISTINCT ${column})`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      WITH sampled AS (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${sampleSize}
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT CAST(${columnName} AS TEXT) AS val
      FROM ${tableName}
      WHERE ${columnName} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }

  generateColumnStatisticsQuery(_schemaName: string, _tableName: string): string | null {
    return null;
  }

  generateRandomizedCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      WITH sampled AS (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        ORDER BY RANDOM()
        LIMIT ${sampleSize}
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }

  getTimeTruncExpression(
    column: string,
    granularity: 'day' | 'week' | 'month' | 'quarter' | 'year',
    _timezone?: string,
  ): string {
    switch (granularity) {
      case 'day':
        return `DATE(${column})`;
      case 'week':
        return `DATE(${column}, 'weekday 0', '-6 days')`;
      case 'month':
        return `DATE(${column}, 'start of month')`;
      case 'quarter':
        return `DATE(${column}, 'start of month', '-' || ((CAST(STRFTIME('%m', ${column}) AS INTEGER) - 1) % 3) || ' months')`;
      case 'year':
        return `DATE(${column}, 'start of year')`;
    }
  }

  getCustomTimeTruncExpression(column: string, interval: string, origin?: string, _timezone?: string): string {
    const [amount, unit] = interval.split(' ');
    const originExpr = origin ? `julianday('${origin}')` : `julianday('1970-01-01')`;
    const unitDays = unit === 'day' ? 1 : unit === 'week' ? 7 : 30;
    const intervalDays = Number(amount) * unitDays;
    return `DATE(julianday('1970-01-01') + (CAST((julianday(${column}) - ${originExpr}) / ${intervalDays} AS INTEGER) * ${intervalDays}))`;
  }

  parseIntervalToSql(interval: string): string {
    return `'${interval}'`;
  }
}
