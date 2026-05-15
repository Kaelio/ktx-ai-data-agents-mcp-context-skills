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
  /**
   * Pretty-mode role override. When omitted, role is auto-detected:
   * - `'badge'`  — leading dim cell before the name column (right-padded across rows).
   * - `'name'`   — name column. Default: first non-grouped, non-metric, non-optional column.
   * - `'metric'` — `"N word"` cell. Default: any column with a non-empty `plain` prefix.
   * - `'suffix'` — trailing em-dash optional value. Default: any column with `optional: true`.
   */
  role?: 'name' | 'metric' | 'badge' | 'suffix';
  /** Custom pretty-mode value formatter (e.g. score → "87%"). Plain/JSON unaffected. */
  prettyFormat?: (value: Row[keyof Row & string], row: Row) => string;
}

export interface PrintListArgs<Row> {
  rows: ReadonlyArray<Row>;
  columns: ReadonlyArray<PrintListColumn<Row>>;
  groupBy?: keyof Row & string;
  emptyMessage: string;
  /** Optional second-line hint shown on empty results.
   *  Plain mode: written to stderr. Pretty mode: dimmed line inside the box. JSON mode: ignored. */
  emptyHint?: string;
  /** Singular noun used in counts (`N {unit}s`, `(N {unit}s)`). Defaults to `'result'`. */
  unit?: string;
  command: string;
  mode: KtxOutputMode;
  io: KtxCliIo;
}

export interface KtxJsonResultEnvelope<T> {
  kind: string;
  data: T;
  meta?: Record<string, unknown>;
}

export function writeJsonResult<T>(io: KtxCliIo, envelope: KtxJsonResultEnvelope<T>): void {
  io.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
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

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function printListPlain<Row extends object>(args: PrintListArgs<Row>): void {
  if (args.rows.length === 0) {
    if (args.emptyHint !== undefined && args.emptyHint !== '') {
      // Plain mode keeps stdout pipe-safe. Send the human-readable empty
      // state to stderr as two lines (message, then hint).
      args.io.stderr.write(`${args.emptyMessage}\n`);
      args.io.stderr.write(`${args.emptyHint}\n`);
    }
    return;
  }
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

interface ResolvedColumns<Row extends object> {
  badge: ReadonlyArray<PrintListColumn<Row>>;
  name?: PrintListColumn<Row>;
  metric: ReadonlyArray<PrintListColumn<Row>>;
  suffix: ReadonlyArray<PrintListColumn<Row>>;
}

function resolveColumns<Row extends object>(
  columns: ReadonlyArray<PrintListColumn<Row>>,
  groupBy: (keyof Row & string) | undefined,
): ResolvedColumns<Row> {
  const badge: PrintListColumn<Row>[] = [];
  const metric: PrintListColumn<Row>[] = [];
  const suffix: PrintListColumn<Row>[] = [];
  let name: PrintListColumn<Row> | undefined;

  for (const col of columns) {
    if (col.role === 'badge') {
      badge.push(col);
      continue;
    }
    if (col.role === 'name') {
      name ??= col;
      continue;
    }
    if (col.role === 'metric') {
      metric.push(col);
      continue;
    }
    if (col.role === 'suffix') {
      suffix.push(col);
      continue;
    }
    // Auto-detect when no explicit role.
    if (col.key === groupBy) continue;
    if (col.optional === true) {
      suffix.push(col);
      continue;
    }
    if (typeof col.plain === 'string' && col.plain.length > 0) {
      metric.push(col);
      continue;
    }
    if (!name && !col.plain && col.plain !== false) {
      name = col;
    }
  }

  return { badge, name, metric, suffix };
}

function formatCellValue<Row extends object>(col: PrintListColumn<Row>, row: Row): string {
  const value = row[col.key];
  if (col.prettyFormat) {
    return col.prettyFormat(value as Row[keyof Row & string], row);
  }
  if (value === undefined || value === null) return '';
  return String(value);
}

function printListPretty<Row extends object>(args: PrintListArgs<Row>): void {
  const { io, command, rows, columns, groupBy, emptyMessage, emptyHint } = args;
  const unit = args.unit ?? 'result';

  io.stdout.write(`${bold(command)}\n`);

  if (rows.length === 0) {
    io.stdout.write(`\n  ${emptyMessage}\n`);
    if (emptyHint !== undefined && emptyHint !== '') {
      io.stdout.write(`  ${dim(emptyHint)}\n`);
    }
    io.stdout.write('\n');
    return;
  }

  io.stdout.write('\n');

  const resolved = resolveColumns(columns, groupBy);

  const buckets = groupBy ? groupRows(rows, groupBy) : new Map<string, Row[]>([['', [...rows]]]);

  const nameWidth = resolved.name
    ? Math.max(...rows.map((r) => String(r[resolved.name!.key] ?? '').length))
    : 0;

  const badgeWidths = resolved.badge.map((col) =>
    Math.max(0, ...rows.map((r) => formatCellValue(col, r).length)),
  );

  for (const [groupValue, groupRowList] of buckets) {
    if (groupBy) {
      io.stdout.write(
        `  ${bold(groupValue)} ${dim(`(${pluralize(groupRowList.length, unit)})`)}\n`,
      );
    }
    for (const row of groupRowList) {
      const segments: string[] = [];

      resolved.badge.forEach((col, idx) => {
        segments.push(formatCellValue(col, row).padStart(badgeWidths[idx] ?? 0));
      });

      if (resolved.name) {
        segments.push(String(row[resolved.name.key] ?? '').padEnd(nameWidth));
      }

      const metrics = resolved.metric
        .map((col) => {
          if (col.prettyFormat) return formatCellValue(col, row);
          return metricCell(col.label ?? col.key, Number(row[col.key] ?? 0));
        })
        .join(` ${SYMBOLS.middot} `);
      if (metrics.length > 0) segments.push(dim(metrics));

      const optionalSuffix = resolved.suffix
        .map((col) => {
          const value = row[col.key];
          if (isEmpty(value)) return null;
          const formatted = col.prettyFormat ? formatCellValue(col, row) : String(value);
          return `${SYMBOLS.emDash} ${dim(formatted)}`;
        })
        .filter((s): s is string => s !== null)
        .join(' ');
      if (optionalSuffix.length > 0) segments.push(optionalSuffix);

      const indent = groupBy ? '    ' : '  ';
      io.stdout.write(`${indent}${segments.join('  ')}\n`);
    }
    io.stdout.write('\n');
  }

  io.stdout.write(`${pluralize(rows.length, unit)}\n`);
}
