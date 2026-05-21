import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type MysqlTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export class KtxMysqlDialect {
  readonly type = 'mysql';

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    datetime: 'time',
    timestamp: 'time',
    date: 'time',
    time: 'time',
    year: 'time',
    tinyint: 'number',
    smallint: 'number',
    mediumint: 'number',
    int: 'number',
    integer: 'number',
    bigint: 'number',
    decimal: 'number',
    numeric: 'number',
    float: 'number',
    double: 'number',
    real: 'number',
    varchar: 'string',
    char: 'string',
    text: 'string',
    tinytext: 'string',
    mediumtext: 'string',
    longtext: 'string',
    enum: 'string',
    set: 'string',
    json: 'string',
    bit: 'boolean',
    bool: 'boolean',
    boolean: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  formatTableName(table: MysqlTableNameRef): string {
    return table.db
      ? `${this.quoteIdentifier(table.db)}.${this.quoteIdentifier(table.name)}`
      : this.quoteIdentifier(table.name);
  }

  mapDataType(nativeType: string): string {
    return nativeType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    const lower = nativeType.toLowerCase().trim();
    if (lower.includes('tinyint(1)')) {
      return 'boolean';
    }
    const normalized = lower.includes('(') ? lower.split('(')[0] : lower;
    if (this.typeMappings[normalized]) {
      return this.typeMappings[normalized];
    }
    if (normalized.includes('time') || normalized.includes('date')) {
      return 'time';
    }
    if (
      normalized.includes('int') ||
      normalized.includes('num') ||
      normalized.includes('dec') ||
      normalized.includes('float') ||
      normalized.includes('double')
    ) {
      return 'number';
    }
    if (normalized.includes('bit') || normalized === 'bool' || normalized === 'boolean') {
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
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS CHAR)) != '' LIMIT ${limit}`;
  }

  prepareQuery(sql: string, params?: Record<string, unknown>): { sql: string; params?: unknown[] } {
    if (!params) {
      return { sql, params: undefined };
    }
    const values: unknown[] = [];
    const parameterizedQuery = sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)\b/g, (placeholder, key: string) => {
      if (!(key in params)) {
        return placeholder;
      }
      values.push(params[key]);
      return '?';
    });
    return { sql: parameterizedQuery, params: values };
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `RAND() < ${samplePct}`;
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
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${sampleSize}
      ) AS sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT CAST(${columnName} AS CHAR) AS val
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
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        ORDER BY RAND()
        LIMIT ${sampleSize}
      ) AS sampled
    `;
  }

  getTimeTruncExpression(
    column: string,
    granularity: 'day' | 'week' | 'month' | 'quarter' | 'year',
    timezone?: string,
  ): string {
    const col = timezone ? `CONVERT_TZ(${column}, '+00:00', '${timezone}')` : column;
    switch (granularity) {
      case 'day':
        return `DATE(${col})`;
      case 'week':
        return `DATE(${col} - INTERVAL WEEKDAY(${col}) DAY)`;
      case 'month':
        return `DATE_FORMAT(${col}, '%Y-%m-01')`;
      case 'quarter':
        return `MAKEDATE(YEAR(${col}), 1) + INTERVAL (QUARTER(${col}) - 1) QUARTER`;
      case 'year':
        return `DATE_FORMAT(${col}, '%Y-01-01')`;
    }
  }

  getCustomTimeTruncExpression(column: string, interval: string, origin?: string, timezone?: string): string {
    const col = timezone ? `CONVERT_TZ(${column}, '+00:00', '${timezone}')` : column;
    const [amount, unit] = interval.split(' ');
    const originExpr = origin ? `'${origin}'` : `'1970-01-01'`;
    return `DATE_ADD(${originExpr}, INTERVAL FLOOR(TIMESTAMPDIFF(${unit!.toUpperCase()}, ${originExpr}, ${col}) / ${amount}) * ${amount} ${unit!.toUpperCase()})`;
  }

  parseIntervalToSql(interval: string): string {
    const [amount, unit] = interval.split(' ');
    return `INTERVAL ${amount} ${unit!.toUpperCase()}`;
  }
}
