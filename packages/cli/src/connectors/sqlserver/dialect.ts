import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type SqlServerTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export class KtxSqlServerDialect {
  readonly type = 'sqlserver';

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    datetime: 'time',
    datetime2: 'time',
    date: 'time',
    time: 'time',
    datetimeoffset: 'time',
    smalldatetime: 'time',
    timestamp: 'time',
    int: 'number',
    bigint: 'number',
    smallint: 'number',
    tinyint: 'number',
    decimal: 'number',
    numeric: 'number',
    float: 'number',
    real: 'number',
    money: 'number',
    smallmoney: 'number',
    varchar: 'string',
    nvarchar: 'string',
    char: 'string',
    nchar: 'string',
    text: 'string',
    ntext: 'string',
    uniqueidentifier: 'string',
    xml: 'string',
    bit: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `[${identifier.replace(/\]/g, ']]')}]`;
  }

  formatTableName(table: SqlServerTableNameRef): string {
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
    const normalized = lower.includes('(') ? lower.split('(')[0]! : lower;
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
      normalized.includes('money')
    ) {
      return 'number';
    }
    if (normalized.includes('bit')) {
      return 'boolean';
    }
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT TOP ${limit} ${columnList} FROM ${tableName}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT TOP ${limit} ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND LTRIM(RTRIM(CAST(${quotedColumn} AS NVARCHAR(MAX)))) != ''`;
  }

  prepareQuery(sql: string, params?: Record<string, unknown>): { sql: string; params?: Record<string, unknown> } {
    if (!params) {
      return { sql, params: undefined };
    }
    let parameterizedQuery = sql;
    for (const key of Object.keys(params)) {
      parameterizedQuery = parameterizedQuery.replace(new RegExp(`:${key}\\b`, 'g'), `@${key}`);
    }
    return { sql: parameterizedQuery, params };
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `ABS(CHECKSUM(NEWID())) % 100 < ${Math.round(samplePct * 100)}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `TABLESAMPLE (${samplePct * 100} PERCENT)`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return offset !== undefined && offset > 0 ? `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : '';
  }

  getTopClause(limit: number): string {
    return `TOP ${limit}`;
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
        SELECT TOP ${sampleSize} ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT TOP ${limit} val
      FROM (
        SELECT DISTINCT CAST(${columnName} AS NVARCHAR(MAX)) AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      ) AS distinct_vals
      ORDER BY val
    `;
  }

  generateColumnStatisticsQuery(_schemaName: string, _tableName: string): string | null {
    return null;
  }

  generateRandomizedCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      WITH sampled AS (
        SELECT TOP ${sampleSize} ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        ORDER BY NEWID()
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
    const col = timezone ? `${column} AT TIME ZONE 'UTC' AT TIME ZONE '${timezone}'` : column;
    switch (granularity) {
      case 'day':
        return `CAST(${col} AS DATE)`;
      case 'week':
        return `DATEADD(WEEK, DATEDIFF(WEEK, 0, ${col}), 0)`;
      case 'month':
        return `DATEFROMPARTS(YEAR(${col}), MONTH(${col}), 1)`;
      case 'quarter':
        return `DATEFROMPARTS(YEAR(${col}), (DATEPART(QUARTER, ${col}) - 1) * 3 + 1, 1)`;
      case 'year':
        return `DATEFROMPARTS(YEAR(${col}), 1, 1)`;
    }
  }

  getCustomTimeTruncExpression(column: string, interval: string, origin?: string, timezone?: string): string {
    const col = timezone ? `${column} AT TIME ZONE 'UTC' AT TIME ZONE '${timezone}'` : column;
    const [amount, unit] = interval.split(' ');
    const originExpr = origin ? `'${origin}'` : `'1970-01-01'`;
    return `DATEADD(${unit}, (DATEDIFF(${unit}, ${originExpr}, ${col}) / ${amount}) * ${amount}, ${originExpr})`;
  }

  parseIntervalToSql(interval: string): string {
    return `'${interval}'`;
  }
}
