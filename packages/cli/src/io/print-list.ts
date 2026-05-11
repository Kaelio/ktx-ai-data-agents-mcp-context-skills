import type { KtxCliIo } from '../cli-runtime.js';
import type { KtxOutputMode } from './mode.js';
import { bold, dim, SYMBOLS } from './symbols.js';

export interface PrintListColumn<Row> {
  key: keyof Row & string;
  label?: string;
  /**
   * Plain-mode rendering control.
   * - `string` (including `''`): emit `${plain}${value}` as a tab-separated cell.
   * - `false`: omit this column entirely in plain mode.
   * - `undefined`: same as `''`.
   */
  plain?: string | false;
  /** Skip this column when the row's value is null / undefined / empty string. */
  optional?: boolean;
  /** Pretty-mode hint: render this column dim. */
  dim?: boolean;
}

export interface PrintListArgs<Row> {
  rows: ReadonlyArray<Row>;
  columns: ReadonlyArray<PrintListColumn<Row>>;
  groupBy?: keyof Row & string;
  emptyMessage: string;
  command: string;
  mode: KtxOutputMode;
  io: KtxCliIo;
}

export function printList<Row extends object>(args: PrintListArgs<Row>): void {
  switch (args.mode) {
    case 'json':
      printListJson(args);
      return;
    case 'plain':
      printListPlain(args);
      return;
    case 'pretty':
      printListPretty(args);
      return;
  }
}

export interface KtxJsonResultEnvelope<T> {
  kind: string;
  data: T;
  meta?: Record<string, unknown>;
}

export function writeJsonResult<T>(io: KtxCliIo, envelope: KtxJsonResultEnvelope<T>): void {
  io.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function printListPlain<Row extends object>(args: PrintListArgs<Row>): void {
  for (const row of args.rows) {
    const cells: string[] = [];
    for (const col of args.columns) {
      if (col.plain === false) continue;
      const value = row[col.key];
      if (col.optional && isEmpty(value)) continue;
      const prefix = col.plain ?? '';
      cells.push(`${prefix}${value === undefined || value === null ? '' : String(value)}`);
    }
    args.io.stdout.write(`${cells.join('\t')}\n`);
  }
}

function printListJson<Row extends object>(args: PrintListArgs<Row>): void {
  writeJsonResult(args.io, {
    kind: 'list',
    data: { items: args.rows },
    meta: { command: args.command },
  });
}

function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function metricCell(label: string, count: number): string {
  // "5 cols", "3 measures", "1 join" / "2 joins"
  // The label in PrintListColumn is uppercase; pretty mode lowercases it.
  const word = label.toLowerCase();
  return `${count} ${count === 1 ? singularize(word) : word}`;
}

function singularize(word: string): string {
  if (word === 'joins') return 'join';
  if (word === 'measures') return 'measure';
  if (word === 'cols') return 'col';
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function groupRows<Row extends object>(
  rows: ReadonlyArray<Row>,
  key: keyof Row & string,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const value = String(row[key] ?? '');
    const bucket = groups.get(value);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(value, [row]);
    }
  }
  return groups;
}

function printListPretty<Row extends object>(args: PrintListArgs<Row>): void {
  const { io, command, rows, columns, groupBy, emptyMessage } = args;

  io.stdout.write(`${SYMBOLS.barStart}  ${command}\n`);
  io.stdout.write(`${SYMBOLS.bar}\n`);

  if (rows.length === 0) {
    io.stdout.write(`${SYMBOLS.barEnd}  ${emptyMessage}\n`);
    return;
  }

  // Identify role of each column.
  // - First non-grouped, non-metric, non-optional column = "name" column (bolded)
  // - Columns with a `plain` prefix = metric columns (rendered as "N word")
  // - optional columns = trailing suffix (em-dash + value), only when value is present
  const nameCol = columns.find(
    (c) => c.key !== groupBy && !c.plain && !c.optional && c.plain !== false,
  );
  const metricCols = columns.filter((c) => typeof c.plain === 'string' && c.plain.length > 0);
  const optionalCols = columns.filter((c) => c.optional === true);

  const buckets = groupBy ? groupRows(rows, groupBy) : new Map<string, Row[]>([['', [...rows]]]);

  const nameWidth = nameCol
    ? Math.max(...rows.map((r) => String(r[nameCol.key] ?? '').length))
    : 0;

  for (const [groupValue, groupRowList] of buckets) {
    if (groupBy) {
      io.stdout.write(
        `${SYMBOLS.bar}  ${SYMBOLS.group} ${bold(groupValue)} ${dim(`(${pluralize(groupRowList.length, 'source')})`)}\n`,
      );
    }
    for (const row of groupRowList) {
      const segments: string[] = [];
      if (nameCol) {
        segments.push(String(row[nameCol.key] ?? '').padEnd(nameWidth));
      }
      const metrics = metricCols
        .map((c) => metricCell(c.label ?? c.key, Number(row[c.key] ?? 0)))
        .join(` ${SYMBOLS.middot} `);
      if (metrics.length > 0) segments.push(dim(metrics));
      const optionalSuffix = optionalCols
        .map((c) => row[c.key])
        .filter((v) => !isEmpty(v))
        .map((v) => `${SYMBOLS.emDash} ${dim(String(v))}`)
        .join(' ');
      if (optionalSuffix.length > 0) segments.push(optionalSuffix);

      const indent = groupBy ? '    ' : '  ';
      io.stdout.write(`${SYMBOLS.bar}${indent}${SYMBOLS.item} ${segments.join('  ')}\n`);
    }
  }

  io.stdout.write(`${SYMBOLS.bar}\n`);
  io.stdout.write(`${SYMBOLS.barEnd}  ${pluralize(rows.length, 'source')}\n`);
}
