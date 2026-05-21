import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/index.js';

type SnowflakeTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export class KtxSnowflakeDialect {
  readonly type = 'snowflake';

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    TIMESTAMP_NTZ: 'time',
    TIMESTAMP_LTZ: 'time',
    TIMESTAMP_TZ: 'time',
    TIMESTAMP: 'time',
    DATE: 'time',
    TIME: 'time',
    NUMBER: 'number',
    DECIMAL: 'number',
    NUMERIC: 'number',
    INT: 'number',
    INTEGER: 'number',
    BIGINT: 'number',
    SMALLINT: 'number',
    TINYINT: 'number',
    BYTEINT: 'number',
    FLOAT: 'number',
    FLOAT4: 'number',
    FLOAT8: 'number',
    DOUBLE: 'number',
    'DOUBLE PRECISION': 'number',
    REAL: 'number',
    VARCHAR: 'string',
    CHAR: 'string',
    CHARACTER: 'string',
    STRING: 'string',
    TEXT: 'string',
    BINARY: 'string',
    VARBINARY: 'string',
    BOOLEAN: 'boolean',
    VARIANT: 'string',
    OBJECT: 'string',
    ARRAY: 'string',
  };

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: SnowflakeTableNameRef): string {
    if (table.catalog && table.db) {
      return `${this.quoteIdentifier(table.catalog)}.${this.quoteIdentifier(table.db)}.${this.quoteIdentifier(table.name)}`;
    }
    if (table.db) {
      return `${this.quoteIdentifier(table.db)}.${this.quoteIdentifier(table.name)}`;
    }
    return this.quoteIdentifier(table.name);
  }

  mapDataType(nativeType: string): string {
    return nativeType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    const upper = nativeType.toUpperCase().trim();
    const normalized = upper.includes('(') ? upper.split('(')[0]! : upper;
    if (this.typeMappings[normalized]) {
      return this.typeMappings[normalized];
    }
    if (normalized.includes('TIME') || normalized.includes('DATE')) {
      return 'time';
    }
    if (
      normalized.includes('INT') ||
      normalized.includes('NUM') ||
      normalized.includes('DEC') ||
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
    return `SELECT ${columnList} FROM ${tableName} SAMPLE ROW (${limit} ROWS)`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS STRING)) != '' LIMIT ${limit}`;
  }

  prepareQuery(sql: string, params?: Record<string, unknown>): { sql: string; params?: unknown[] } {
    return { sql, params: params ? Object.values(params) : undefined };
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < ${samplePct}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `SAMPLE (${samplePct * 100})`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return offset !== undefined && offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  }

  getNullCountExpression(column: string): string {
    return `COUNT_IF(${column} IS NULL)`;
  }

  getDistinctCountExpression(column: string): string {
    return `APPROX_COUNT_DISTINCT(${column})`;
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
      SELECT DISTINCT ${columnName}::VARCHAR AS val
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
        FROM ${tableName} SAMPLE ROW (${sampleSize} ROWS)
        WHERE ${columnName} IS NOT NULL
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }

  getTimeTruncExpression(
    column: string,
    granularity: 'day' | 'week' | 'month' | 'quarter' | 'year',
    timezone?: string,
  ): string {
    const target = timezone ? `CONVERT_TIMEZONE('UTC', '${timezone}', ${column})` : column;
    return `DATE_TRUNC('${granularity}', ${target})`;
  }

  getCustomTimeTruncExpression(column: string, interval: string, origin?: string, timezone?: string): string {
    const target = timezone ? `CONVERT_TIMEZONE('UTC', '${timezone}', ${column})` : column;
    const [amount, unit] = interval.split(' ');
    const originExpr = origin ? `'${origin}'::TIMESTAMP` : `'1970-01-01'::TIMESTAMP`;
    return `DATEADD(${unit}, FLOOR(DATEDIFF(${unit}, ${originExpr}, ${target}) / ${amount}) * ${amount}, ${originExpr})`;
  }

  parseIntervalToSql(interval: string): string {
    return `INTERVAL '${interval}'`;
  }
}
