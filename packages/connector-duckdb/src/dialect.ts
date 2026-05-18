import type { KtxSchemaDimensionType, KtxTableRef } from '@ktx/context/scan';

export class KtxDuckDbDialect {
  readonly type = 'duckdb';

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: Pick<KtxTableRef, 'catalog' | 'db' | 'name'>): string {
    return [table.catalog, table.db, table.name]
      .filter((part): part is string => !!part)
      .map((part) => this.quoteIdentifier(part))
      .join('.');
  }

  mapDataType(nativeType: string): string {
    return nativeType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    const normalized = nativeType.toUpperCase().trim();
    if (normalized.includes('DATE') || normalized.includes('TIME')) return 'time';
    if (
      normalized.includes('INT') ||
      normalized.includes('DECIMAL') ||
      normalized.includes('DOUBLE') ||
      normalized.includes('FLOAT') ||
      normalized.includes('NUMERIC') ||
      normalized.includes('REAL')
    ) {
      return 'number';
    }
    if (normalized.includes('BOOL')) return 'boolean';
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT ${columnList} FROM ${tableName} LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quoted = this.quoteIdentifier(columnName);
    return `SELECT ${quoted} FROM ${tableName} WHERE ${quoted} IS NOT NULL AND TRIM(CAST(${quoted} AS VARCHAR)) != '' LIMIT ${limit}`;
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
      SELECT DISTINCT CAST(${columnName} AS VARCHAR) AS val
      FROM ${tableName}
      WHERE ${columnName} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }
}
