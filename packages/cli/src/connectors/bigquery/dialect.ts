import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type BigQueryTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export class KtxBigQueryDialect {
  readonly type = 'bigquery';

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    TIMESTAMP: 'time',
    DATETIME: 'time',
    DATE: 'time',
    TIME: 'time',
    INT64: 'number',
    INTEGER: 'number',
    FLOAT64: 'number',
    FLOAT: 'number',
    NUMERIC: 'number',
    BIGNUMERIC: 'number',
    STRING: 'string',
    BYTES: 'string',
    BOOL: 'boolean',
    BOOLEAN: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '\\`')}\``;
  }

  formatTableName(table: BigQueryTableNameRef): string {
    if (table.catalog && table.db) {
      return `${this.quoteIdentifier(table.catalog)}.${this.quoteIdentifier(table.db)}.${this.quoteIdentifier(table.name)}`;
    }
    if (table.db) {
      return `${this.quoteIdentifier(table.db)}.${this.quoteIdentifier(table.name)}`;
    }
    return this.quoteIdentifier(table.name);
  }

  mapDataType(nativeType: string): string {
    const fieldType = nativeType.toUpperCase().trim();
    if (fieldType === 'RECORD' || fieldType === 'STRUCT') {
      return 'JSON';
    }
    const typeMapping: Record<string, string> = {
      STRING: 'VARCHAR',
      BYTES: 'VARBINARY',
      INTEGER: 'BIGINT',
      INT64: 'BIGINT',
      FLOAT: 'DOUBLE',
      FLOAT64: 'DOUBLE',
      NUMERIC: 'DECIMAL',
      BIGNUMERIC: 'DECIMAL',
      BOOLEAN: 'BOOLEAN',
      BOOL: 'BOOLEAN',
      TIMESTAMP: 'TIMESTAMP',
      DATE: 'DATE',
      TIME: 'TIME',
      DATETIME: 'DATETIME',
      GEOGRAPHY: 'GEOGRAPHY',
      JSON: 'JSON',
    };
    return typeMapping[fieldType] || fieldType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    const normalizedType = nativeType.toUpperCase().trim();
    if (this.typeMappings[normalizedType]) {
      return this.typeMappings[normalizedType];
    }
    if (normalizedType.includes('TIME') || normalizedType.includes('DATE')) {
      return 'time';
    }
    if (normalizedType.includes('INT') || normalizedType.includes('NUM') || normalizedType.includes('FLOAT')) {
      return 'number';
    }
    if (normalizedType.includes('BOOL')) {
      return 'boolean';
    }
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT ${columnList} FROM ${tableName} ORDER BY RAND() LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS STRING)) != '' ORDER BY RAND() LIMIT ${limit}`;
  }

  prepareQuery(sql: string, params?: Record<string, unknown>): { sql: string; params?: Record<string, unknown> } {
    if (!params) {
      return { sql, params: undefined };
    }
    let processedSql = sql;
    const processedParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      processedSql = processedSql.replace(new RegExp(`:${key}\\b`, 'g'), `@${key}`);
      processedParams[key] = value;
    }
    return { sql: processedSql, params: Object.keys(processedParams).length > 0 ? processedParams : undefined };
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `RAND() < ${samplePct}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `TABLESAMPLE SYSTEM (${samplePct * 100} PERCENT)`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return offset !== undefined && offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  }

  getNullCountExpression(column: string): string {
    return `COUNTIF(${column} IS NULL)`;
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
      SELECT APPROX_COUNT_DISTINCT(val) AS cardinality
      FROM sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT CAST(${columnName} AS STRING) AS val
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
        ORDER BY RAND()
        LIMIT ${sampleSize}
      )
      SELECT APPROX_COUNT_DISTINCT(val) AS cardinality
      FROM sampled
    `;
  }

  getTimeTruncExpression(
    column: string,
    granularity: 'day' | 'week' | 'month' | 'quarter' | 'year',
    timezone?: string,
  ): string {
    const bigQueryGranularity = granularity.toUpperCase();
    if (timezone) {
      return `DATE_TRUNC(DATETIME(${column}, '${timezone}'), ${bigQueryGranularity})`;
    }
    return `DATE_TRUNC(${column}, ${bigQueryGranularity})`;
  }

  getCustomTimeTruncExpression(column: string, interval: string, origin?: string, timezone?: string): string {
    const col = timezone ? `DATETIME(${column}, '${timezone}')` : column;
    const [rawAmount, rawUnit] = interval.split(' ');
    let diffUnit = rawUnit!.toUpperCase();
    let amount = Number(rawAmount);
    let addUnit = diffUnit;
    if (diffUnit === 'WEEK') {
      diffUnit = 'DAY';
      amount = amount * 7;
      addUnit = 'DAY';
    }
    const originExpr = origin ? `TIMESTAMP '${origin}'` : `TIMESTAMP '1970-01-01'`;
    return `TIMESTAMP_ADD(${originExpr}, INTERVAL CAST(FLOOR(TIMESTAMP_DIFF(${col}, ${originExpr}, ${diffUnit}) / ${amount}) * ${amount} AS INT64) ${addUnit})`;
  }

  parseIntervalToSql(interval: string): string {
    const [amount, unit] = interval.split(' ');
    return `INTERVAL ${amount} ${unit!.toUpperCase()}`;
  }
}
