import type { KtxTableRef } from '../scan/types.js';

export type KtxDialectIdentifierShape = 'ansi' | 'sqlite' | 'three-part';

export type KtxDialectTableRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export function safeSqlLimit(limit: number): number {
  return Math.max(1, Math.floor(limit));
}

function safeSqlOffset(offset: number | undefined): number | null {
  if (offset === undefined) {
    return null;
  }
  const normalized = Math.floor(offset);
  return normalized > 0 ? normalized : null;
}

function cleanIdentifierPart(part: string): string {
  return part.trim().replace(/^["'`\[]|["'`\]]$/g, '');
}

function splitDisplay(display: string): string[] {
  return display.trim().split('.').map(cleanIdentifierPart).filter(Boolean);
}

function tableParts(table: KtxDialectTableRef, shape: KtxDialectIdentifierShape): string[] {
  if (shape === 'sqlite') {
    return [table.name];
  }
  return [table.catalog ?? null, table.db ?? null, table.name].filter((part): part is string => Boolean(part));
}

function acceptedDisplayPartCounts(shape: KtxDialectIdentifierShape): readonly number[] {
  if (shape === 'sqlite') {
    return [1];
  }
  if (shape === 'three-part') {
    return [3];
  }
  return [2, 3];
}

export function formatDialectTableName(
  table: KtxDialectTableRef,
  quoteIdentifier: (identifier: string) => string,
  shape: KtxDialectIdentifierShape,
): string {
  return tableParts(table, shape).map(quoteIdentifier).join('.');
}

export function formatDialectDisplayRef(table: KtxDialectTableRef, shape: KtxDialectIdentifierShape): string {
  return tableParts(table, shape).join('.');
}

export function parseDialectDisplayRef(display: string, shape: KtxDialectIdentifierShape): KtxTableRef | null {
  const parts = splitDisplay(display);
  if (!acceptedDisplayPartCounts(shape).includes(parts.length)) {
    return null;
  }
  if (parts.length === 1) {
    return { catalog: null, db: null, name: parts[0]! };
  }
  if (parts.length === 2) {
    return { catalog: null, db: parts[0]!, name: parts[1]! };
  }
  if (parts.length === 3) {
    return { catalog: parts[0]!, db: parts[1]!, name: parts[2]! };
  }
  return null;
}

export function columnDisplayPartCount(shape: KtxDialectIdentifierShape): 1 | 2 | 3 {
  if (shape === 'sqlite') {
    return 1;
  }
  if (shape === 'three-part') {
    return 3;
  }
  return 2;
}

export function limitOffsetClause(limit: number, offset?: number): string {
  const safeLimit = safeSqlLimit(limit);
  const safeOffset = safeSqlOffset(offset);
  return safeOffset === null ? `LIMIT ${safeLimit}` : `LIMIT ${safeLimit} OFFSET ${safeOffset}`;
}
