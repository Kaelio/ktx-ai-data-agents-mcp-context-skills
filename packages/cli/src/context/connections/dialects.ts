import type { KtxSchemaDimensionType, KtxTableRef } from '../scan/types.js';

type SupportedDriver =
  | 'postgres'
  | 'mysql'
  | 'sqlserver'
  | 'snowflake'
  | 'bigquery'
  | 'clickhouse'
  | 'sqlite';

export interface KtxDialect {
  readonly type: SupportedDriver;
  quoteIdentifier(identifier: string): string;
  formatTableName(table: KtxTableRef): string;
  mapToDimensionType(nativeType: string): KtxSchemaDimensionType;
}

const supportedDrivers: SupportedDriver[] = [
  'bigquery',
  'clickhouse',
  'mysql',
  'postgres',
  'sqlite',
  'snowflake',
  'sqlserver',
];

function doubleQuoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function backtickQuoted(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function bigQueryQuoted(identifier: string): string {
  return `\`${identifier.replace(/`/g, '\\`')}\``;
}

function bracketQuoted(identifier: string): string {
  return `[${identifier.replace(/\]/g, ']]')}]`;
}

function inferDimensionType(nativeType: string): KtxSchemaDimensionType {
  const normalized = nativeType.toLowerCase().trim();
  if (normalized.includes('date') || normalized.includes('time')) {
    return 'time';
  }
  if (
    normalized.includes('int') ||
    normalized.includes('num') ||
    normalized.includes('dec') ||
    normalized.includes('float') ||
    normalized.includes('double') ||
    normalized.includes('real')
  ) {
    return 'number';
  }
  if (normalized.includes('bool') || normalized === 'bit') {
    return 'boolean';
  }
  return 'string';
}

function formatWithParts(table: KtxTableRef, quote: (identifier: string) => string, sqlite = false): string {
  const parts = sqlite ? [table.name] : [table.catalog, table.db, table.name].filter((part): part is string => !!part);
  return parts.map(quote).join('.');
}

function createDialect(type: SupportedDriver, quote: (identifier: string) => string, sqlite = false): KtxDialect {
  return {
    type,
    quoteIdentifier: quote,
    formatTableName: (table) => formatWithParts(table, quote, sqlite),
    mapToDimensionType: inferDimensionType,
  };
}

const dialects: Record<SupportedDriver, KtxDialect> = {
  postgres: createDialect('postgres', doubleQuoted),
  mysql: createDialect('mysql', backtickQuoted),
  clickhouse: createDialect('clickhouse', backtickQuoted),
  sqlite: createDialect('sqlite', doubleQuoted, true),
  snowflake: createDialect('snowflake', doubleQuoted),
  bigquery: createDialect('bigquery', bigQueryQuoted),
  sqlserver: createDialect('sqlserver', bracketQuoted),
};

export function getDialectForDriver(driver: string): KtxDialect {
  const normalized = driver.toLowerCase().trim();
  if (normalized in dialects) {
    return dialects[normalized as SupportedDriver];
  }
  throw new Error(`Unsupported warehouse driver "${driver}". Supported drivers: ${supportedDrivers.join(', ')}`);
}
