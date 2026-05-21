import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type ClickHouseTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export class KtxClickHouseDialect {
  readonly type = 'clickhouse';

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    date: 'time',
    date32: 'time',
    datetime: 'time',
    datetime64: 'time',
    uint8: 'number',
    uint16: 'number',
    uint32: 'number',
    uint64: 'number',
    uint128: 'number',
    uint256: 'number',
    int8: 'number',
    int16: 'number',
    int32: 'number',
    int64: 'number',
    int128: 'number',
    int256: 'number',
    float32: 'number',
    float64: 'number',
    decimal: 'number',
    decimal32: 'number',
    decimal64: 'number',
    decimal128: 'number',
    decimal256: 'number',
    string: 'string',
    fixedstring: 'string',
    uuid: 'string',
    ipv4: 'string',
    ipv6: 'string',
    enum8: 'string',
    enum16: 'string',
    bool: 'boolean',
    boolean: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  formatTableName(table: ClickHouseTableNameRef): string {
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

    let normalizedType = nativeType.toLowerCase().trim();
    normalizedType = this.unwrapClickHouseType(normalizedType, 'nullable');
    normalizedType = this.unwrapClickHouseType(normalizedType, 'lowcardinality');
    normalizedType = this.unwrapClickHouseType(normalizedType, 'nullable');
    if (normalizedType.includes('(')) {
      normalizedType = normalizedType.split('(')[0] ?? normalizedType;
    }

    if (this.typeMappings[normalizedType]) {
      return this.typeMappings[normalizedType];
    }
    if (normalizedType.includes('date') || normalizedType.includes('time')) {
      return 'time';
    }
    if (
      normalizedType.includes('int') ||
      normalizedType.includes('float') ||
      normalizedType.includes('decimal')
    ) {
      return 'number';
    }
    if (normalizedType === 'bool' || normalizedType === 'boolean') {
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
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND trim(toString(${quotedColumn})) != '' LIMIT ${limit}`;
  }

  prepareQuery(sql: string, params?: Record<string, unknown>): { sql: string; params?: Record<string, unknown> } {
    if (!params) {
      return { sql, params: undefined };
    }

    let parameterizedQuery = sql;
    const queryParams: Record<string, unknown> = {};
    const sortedKeys = Object.keys(params).sort((a, b) => b.length - a.length);

    for (const key of sortedKeys) {
      const placeholder = `:${key}`;
      if (parameterizedQuery.includes(placeholder)) {
        parameterizedQuery = parameterizedQuery.replace(
          new RegExp(`:${key}\\b`, 'g'),
          `{${key}:${this.inferClickHouseType(params[key])}}`,
        );
        queryParams[key] = params[key];
      }
    }

    return { sql: parameterizedQuery, params: queryParams };
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `rand() / 4294967295.0 < ${samplePct}`;
  }

  getTableSampleClause(_samplePct: number): string {
    return '';
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return offset !== undefined && offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  }

  getNullCountExpression(column: string): string {
    return `countIf(${column} IS NULL)`;
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
      )
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT toString(${columnName}) AS val
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
        ORDER BY rand()
        LIMIT ${sampleSize}
      )
    `;
  }

  getTimeTruncExpression(
    column: string,
    granularity: 'day' | 'week' | 'month' | 'quarter' | 'year',
    timezone?: string,
  ): string {
    const tz = timezone ? `, '${timezone}'` : '';
    switch (granularity) {
      case 'day':
        return `toStartOfDay(${column}${tz})`;
      case 'week':
        return `toStartOfWeek(${column}, 1${tz})`;
      case 'month':
        return `toStartOfMonth(${column}${tz})`;
      case 'quarter':
        return `toStartOfQuarter(${column}${tz})`;
      case 'year':
        return `toStartOfYear(${column}${tz})`;
    }
  }

  getCustomTimeTruncExpression(column: string, interval: string, origin?: string, timezone?: string): string {
    const col = timezone ? `toTimezone(${column}, '${timezone}')` : column;
    const [rawAmount, rawUnit] = interval.split(' ');
    const amount = Number(rawAmount);
    const unit = rawUnit!.toLowerCase();
    const originExpr = origin ? `toDateTime('${origin}')` : "toDateTime('1970-01-01')";
    const calendarUnit = this.toClickHouseDateDiffUnit(unit);
    if (calendarUnit) {
      return `dateAdd(${calendarUnit}, intDiv(dateDiff(${calendarUnit}, ${originExpr}, ${col}), ${amount}) * ${amount}, ${originExpr})`;
    }
    const seconds = this.intervalToSeconds(amount, unit);
    return `addSeconds(${originExpr}, intDiv(toUInt64(dateDiff('second', ${originExpr}, ${col})), ${seconds}) * ${seconds})`;
  }

  parseIntervalToSql(interval: string): string {
    const [amount, unit] = interval.split(' ');
    return `INTERVAL ${amount} ${unit!.toUpperCase()}`;
  }

  private unwrapClickHouseType(value: string, wrapper: string): string {
    const prefix = `${wrapper}(`;
    return value.startsWith(prefix) && value.endsWith(')') ? value.slice(prefix.length, -1) : value;
  }

  private inferClickHouseType(value: unknown): string {
    if (value === null || value === undefined) {
      return 'String';
    }
    if (typeof value === 'boolean') {
      return 'Bool';
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'Int64' : 'Float64';
    }
    if (value instanceof Date) {
      return 'DateTime';
    }
    return 'String';
  }

  private toClickHouseDateDiffUnit(unit: string): string | null {
    if (unit === 'month' || unit === 'months') {
      return "'month'";
    }
    if (unit === 'quarter' || unit === 'quarters') {
      return "'quarter'";
    }
    if (unit === 'year' || unit === 'years') {
      return "'year'";
    }
    return null;
  }

  private intervalToSeconds(amount: number, unit: string): number {
    switch (unit) {
      case 'second':
      case 'seconds':
        return amount;
      case 'minute':
      case 'minutes':
        return amount * 60;
      case 'hour':
      case 'hours':
        return amount * 3600;
      case 'day':
      case 'days':
        return amount * 86400;
      case 'week':
      case 'weeks':
        return amount * 604800;
      default:
        return amount * 86400;
    }
  }
}
