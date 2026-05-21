import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/index.js';

type PostgresTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export class KtxPostgresDialect {
  readonly type = 'postgresql';

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    timestamp: 'time',
    'timestamp without time zone': 'time',
    'timestamp with time zone': 'time',
    timestamptz: 'time',
    datetime: 'time',
    date: 'time',
    time: 'time',
    integer: 'number',
    int: 'number',
    int2: 'number',
    int4: 'number',
    int8: 'number',
    bigint: 'number',
    smallint: 'number',
    decimal: 'number',
    numeric: 'number',
    float: 'number',
    float4: 'number',
    float8: 'number',
    'double precision': 'number',
    real: 'number',
    money: 'number',
    text: 'string',
    varchar: 'string',
    'character varying': 'string',
    char: 'string',
    character: 'string',
    uuid: 'string',
    json: 'string',
    jsonb: 'string',
    boolean: 'boolean',
    bool: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: PostgresTableNameRef): string {
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
    const normalized = lower.includes('(') ? lower.split('(')[0]!.trim() : lower;
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
    if (normalized.includes('bool')) {
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
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS TEXT)) != '' LIMIT ${limit}`;
  }

  prepareQuery(sql: string, params?: Record<string, unknown>): { sql: string; params?: unknown[] } {
    if (!params) {
      return { sql, params: undefined };
    }
    const paramNames = Object.keys(params);
    const values: unknown[] = new Array(paramNames.length);
    const paramIndexMap = new Map<string, number>();
    paramNames.forEach((name, index) => {
      paramIndexMap.set(name, index + 1);
      values[index] = params[name];
    });
    const sortedKeys = [...paramNames].sort((a, b) => b.length - a.length);
    let parameterizedQuery = sql;
    for (const name of sortedKeys) {
      parameterizedQuery = parameterizedQuery.replace(new RegExp(`:${name}\\b`, 'g'), `$${paramIndexMap.get(name)}`);
    }
    return { sql: parameterizedQuery, params: values };
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `RANDOM() < ${samplePct}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `TABLESAMPLE SYSTEM (${samplePct * 100})`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return offset !== undefined && offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  }

  getNullCountExpression(column: string): string {
    return `COUNT(*) FILTER (WHERE ${column} IS NULL)`;
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
      SELECT DISTINCT ${columnName}::text AS val
      FROM ${tableName}
      WHERE ${columnName} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }

  generateColumnStatisticsQuery(schemaName: string, tableName: string): string | null {
    return `
      SELECT
        s.attname AS column_name,
        CASE
          WHEN s.n_distinct > 0 THEN s.n_distinct::bigint
          WHEN s.n_distinct < 0 THEN (-s.n_distinct * c.reltuples)::bigint
          ELSE NULL
        END AS estimated_cardinality
      FROM pg_stats s
      JOIN pg_class c ON c.relname = s.tablename
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = s.schemaname
      WHERE s.schemaname = '${schemaName.replace(/'/g, "''")}'
        AND s.tablename = '${tableName.replace(/'/g, "''")}'
        AND s.n_distinct IS NOT NULL
    `;
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
    timezone?: string,
  ): string {
    const col = timezone ? `(${column} AT TIME ZONE '${timezone.replace(/'/g, "''")}')` : column;
    return `DATE_TRUNC('${granularity}', ${col})`;
  }

  getCustomTimeTruncExpression(column: string, interval: string, origin?: string, timezone?: string): string {
    const col = timezone ? `(${column} AT TIME ZONE '${timezone.replace(/'/g, "''")}')` : column;
    const originExpr = origin ? `TIMESTAMP '${origin.replace(/'/g, "''")}'` : "TIMESTAMP '1970-01-01'";
    return `${originExpr} + FLOOR(EXTRACT(EPOCH FROM (${col} - ${originExpr})) / EXTRACT(EPOCH FROM INTERVAL '${interval.replace(/'/g, "''")}')) * INTERVAL '${interval.replace(/'/g, "''")}'`;
  }

  parseIntervalToSql(interval: string): string {
    return `INTERVAL '${interval.replace(/'/g, "''")}'`;
  }
}
