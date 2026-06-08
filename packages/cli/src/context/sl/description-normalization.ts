type DescriptionMap = Record<string, string>;

interface NormalizeDescriptionOptions {
  fillMissing?: boolean;
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function cleanDescriptionMap(value: unknown): DescriptionMap {
  const result: DescriptionMap = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }
  for (const [key, text] of Object.entries(value)) {
    const cleaned = cleanText(text);
    if (cleaned) {
      result[key] = cleaned;
    }
  }
  return result;
}

function hasDescriptions(descriptions: DescriptionMap): boolean {
  return Object.keys(descriptions).length > 0;
}

function withDescriptionMap(record: Record<string, unknown>, fallback: string | null): Record<string, unknown> {
  const descriptions = cleanDescriptionMap(record.descriptions);
  if (!hasDescriptions(descriptions) && fallback) {
    descriptions.ktx = fallback;
  }

  const next = { ...record };
  if (hasDescriptions(descriptions)) {
    next.descriptions = descriptions;
  } else {
    delete next.descriptions;
  }
  return next;
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sourceFallback(source: Record<string, unknown>, sourceName: string): string {
  const table = cleanText(source.table);
  const sql = cleanText(source.sql);
  if (table) {
    return `Semantic-layer source for ${sourceName} backed by ${table}.`;
  }
  if (sql) {
    return `Semantic-layer source for ${sourceName} backed by curated SQL.`;
  }
  // Measure/segment/column counts are rendered live from the body at list/read
  // time, so baking them into stored prose freezes a derived value that drifts
  // as the source later gains measures. Keep the auto fallback count-free.
  return `Semantic-layer overlay for ${sourceName}.`;
}

function columnFallback(column: Record<string, unknown>, sourceName: string): string {
  const columnName = cleanText(column.name) ?? 'column';
  const label = humanizeIdentifier(columnName) || columnName;
  const expr = cleanText(column.expr);

  if (expr) {
    return `Computed ${label} value for ${sourceName}.`;
  }

  if (columnName.toLowerCase() === 'id') {
    return `Identifier column for ${sourceName}.`;
  }

  const idMatch = columnName.match(/^(.+)_id$/i);
  if (idMatch) {
    const entity = humanizeIdentifier(idMatch[1] ?? '');
    return entity ? `Identifier for the related ${entity} on ${sourceName}.` : `Identifier column for ${sourceName}.`;
  }

  if (/(^|_)(date|time|timestamp|created_at|updated_at|week_start|month_start)($|_)/i.test(columnName)) {
    return `Date or time value for ${label} on ${sourceName}.`;
  }

  return `Column ${label} from ${sourceName}.`;
}

export function normalizeSemanticLayerDescriptions<T extends object>(
  source: T,
  options: NormalizeDescriptionOptions = {},
): T {
  const sourceRecord = source as Record<string, unknown>;
  const sourceName = cleanText(sourceRecord.name) ?? 'source';
  const normalized = withDescriptionMap(
    sourceRecord,
    options.fillMissing ? sourceFallback(sourceRecord, sourceName) : null,
  );

  if (Array.isArray(sourceRecord.columns)) {
    normalized.columns = sourceRecord.columns.map((column) => {
      if (!column || typeof column !== 'object' || Array.isArray(column)) {
        return column;
      }
      const columnRecord = column as Record<string, unknown>;
      return withDescriptionMap(
        columnRecord,
        options.fillMissing ? columnFallback(columnRecord, sourceName) : null,
      );
    });
  }

  return normalized as T;
}
