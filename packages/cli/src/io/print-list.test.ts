import { describe, expect, it } from 'vitest';
import type { KtxCliIo } from '../cli-runtime.js';
import { createRankBadgeFormatter, printList, type PrintListColumn } from './print-list.js';
import { SYMBOLS } from './symbols.js';

function recorder(): { io: KtxCliIo; out: () => string; err: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

interface SlRow {
  connectionId: string;
  name: string;
  columnCount: number;
  measureCount: number;
  joinCount: number;
  description?: string;
}

const SL_COLUMNS: ReadonlyArray<PrintListColumn<SlRow>> = [
  { key: 'connectionId', label: 'CONNECTION', plain: '' },
  { key: 'name',         label: 'NAME',       plain: '' },
  { key: 'columnCount',  label: 'COLS',       plain: 'columns=',  dim: true },
  { key: 'measureCount', label: 'MEASURES',   plain: 'measures=', dim: true },
  { key: 'joinCount',    label: 'JOINS',      plain: 'joins=',    dim: true },
  { key: 'description',  label: 'DESCRIPTION', plain: false, optional: true, dim: true },
];

const ORDERS: SlRow = { connectionId: 'warehouse', name: 'orders', columnCount: 5, measureCount: 3, joinCount: 1 };
const USERS:  SlRow = { connectionId: 'warehouse', name: 'users',  columnCount: 8, measureCount: 2, joinCount: 2, description: 'User profile + auth' };

describe('printList — plain mode', () => {
  it('emits one tab-separated row per item, skipping plain:false columns', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [ORDERS, USERS],
      columns: SL_COLUMNS,
      mode: 'plain',
      command: 'sl list',
      emptyMessage: 'No sources',
      unit: 'source',
      io: r.io,
    });
    expect(r.out()).toBe(
      'warehouse\torders\tcolumns=5\tmeasures=3\tjoins=1\n' +
      'warehouse\tusers\tcolumns=8\tmeasures=2\tjoins=2\n',
    );
  });

  it('emits nothing on empty list (preserves current sl list zero-row behavior)', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [],
      columns: SL_COLUMNS,
      mode: 'plain',
      command: 'sl list',
      emptyMessage: 'No sources',
      unit: 'source',
      io: r.io,
    });
    expect(r.out()).toBe('');
    expect(r.err()).toBe('');
  });

  it('routes emptyMessage + emptyHint to stderr when no rows and hint is provided', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [],
      columns: SL_COLUMNS,
      mode: 'plain',
      command: 'sl search',
      emptyMessage: 'No sources matched "foo"',
      emptyHint: 'Run `ktx sl list` to see available sources.',
      unit: 'source',
      io: r.io,
    });
    expect(r.out()).toBe('');
    expect(r.err()).toBe(
      'No sources matched "foo"\n' +
      'Run `ktx sl list` to see available sources.\n',
    );
  });
});

describe('printList — json mode', () => {
  it('emits the envelope with kind=list, data.items, and meta.command', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [ORDERS, USERS],
      columns: SL_COLUMNS,
      mode: 'json',
      command: 'sl list',
      emptyMessage: 'No sources',
      unit: 'source',
      io: r.io,
    });
    const written = r.out();
    expect(written.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({
      kind: 'list',
      data: { items: [ORDERS, USERS] },
      meta: { command: 'sl list' },
    });
  });

  it('emits an empty items array when no rows', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [],
      columns: SL_COLUMNS,
      mode: 'json',
      command: 'sl list',
      emptyMessage: 'No sources',
      emptyHint: 'ignored in json mode',
      unit: 'source',
      io: r.io,
    });
    expect(JSON.parse(r.out())).toEqual({
      kind: 'list',
      data: { items: [] },
      meta: { command: 'sl list' },
    });
    expect(r.err()).toBe('');
  });
});

function stripAnsi(s: string): string {
  // Matches ESC [ ... m sequences emitted by node:util.styleText.
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('printList — pretty mode', () => {
  it('renders a bold header, grouped rows, and footer', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [ORDERS, USERS],
      columns: SL_COLUMNS,
      groupBy: 'connectionId',
      mode: 'pretty',
      command: 'sl list',
      emptyMessage: 'No sources',
      unit: 'source',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toContain('sl list');
    expect(out).toContain('warehouse');
    expect(out).toContain('(2 sources)');
    expect(out).toMatch(/orders\s+5 cols/);
    expect(out).toMatch(new RegExp(`3 measures ${escapeRegExp(SYMBOLS.middot)} 1 join\\b`));
    expect(out).toMatch(new RegExp(`2 measures ${escapeRegExp(SYMBOLS.middot)} 2 joins\\b`));
    expect(out).toContain(`${SYMBOLS.emDash} User profile + auth`);
    expect(out).toContain('2 sources');
  });

  it('renders an empty-state message when no rows', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [],
      columns: SL_COLUMNS,
      groupBy: 'connectionId',
      mode: 'pretty',
      command: 'sl list',
      emptyMessage: 'No semantic-layer sources found in /tmp/proj',
      unit: 'source',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toContain('sl list');
    expect(out).toContain('No semantic-layer sources found in /tmp/proj');
  });

  it('renders empty-state with hint when emptyHint is provided', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [],
      columns: SL_COLUMNS,
      groupBy: 'connectionId',
      mode: 'pretty',
      command: 'sl search',
      emptyMessage: 'No sources matched "foo"',
      emptyHint: 'Run `ktx sl list` to see available sources.',
      unit: 'source',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toContain('No sources matched "foo"');
    expect(out).toContain('Run `ktx sl list` to see available sources.');
  });

  it('singularizes the footer when there is one row', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [ORDERS],
      columns: SL_COLUMNS,
      groupBy: 'connectionId',
      mode: 'pretty',
      command: 'sl list',
      emptyMessage: 'No sources',
      unit: 'source',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toContain('1 source');
  });

  it('uses the provided unit in pluralization and group counts', () => {
    const r = recorder();
    interface PageRow { scope: string; key: string; summary: string }
    const PAGE_COLUMNS: ReadonlyArray<PrintListColumn<PageRow>> = [
      { key: 'scope', label: 'SCOPE', plain: '' },
      { key: 'key', label: 'KEY', plain: '' },
      { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
    ];
    printList<PageRow>({
      rows: [
        { scope: 'GLOBAL', key: 'a', summary: 'x' },
        { scope: 'GLOBAL', key: 'b', summary: '' },
      ],
      columns: PAGE_COLUMNS,
      groupBy: 'scope',
      mode: 'pretty',
      command: 'wiki list',
      emptyMessage: 'No pages',
      unit: 'page',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toContain('(2 pages)');
    expect(out).toContain('2 pages');
  });

  it('renders a leading rank badge column in pretty mode', () => {
    const r = recorder();
    interface SearchRow { score: number; scope: string; key: string; summary: string }
    const rows: SearchRow[] = [
      { score: 0.87, scope: 'GLOBAL', key: 'alpha', summary: 'first' },
      { score: 0.04, scope: 'GLOBAL', key: 'beta', summary: 'second' },
    ];
    const SEARCH_COLUMNS: ReadonlyArray<PrintListColumn<SearchRow>> = [
      {
        key: 'score',
        label: 'SCORE',
        plain: 'score=',
        role: 'badge',
        prettyFormat: createRankBadgeFormatter(rows),
        dim: true,
      },
      { key: 'scope', label: 'SCOPE', plain: '' },
      { key: 'key', label: 'KEY', plain: '' },
      { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
    ];
    printList<SearchRow>({
      rows,
      columns: SEARCH_COLUMNS,
      groupBy: 'scope',
      mode: 'pretty',
      command: 'wiki search',
      emptyMessage: 'No matches',
      unit: 'page',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toMatch(/#1\s+alpha\s+/);
    expect(out).toMatch(/#2\s+beta\s+/);
    expect(out).not.toContain('%');
  });

  it('emits the badge column in plain mode using its plain prefix', () => {
    const r = recorder();
    interface SearchRow { score: number; scope: string; key: string; summary: string }
    const rows: SearchRow[] = [{ score: 0.87, scope: 'GLOBAL', key: 'alpha', summary: 'first' }];
    const SEARCH_COLUMNS: ReadonlyArray<PrintListColumn<SearchRow>> = [
      {
        key: 'score',
        label: 'SCORE',
        plain: 'score=',
        role: 'badge',
        prettyFormat: createRankBadgeFormatter(rows),
        dim: true,
      },
      { key: 'scope', label: 'SCOPE', plain: '' },
      { key: 'key', label: 'KEY', plain: '' },
      { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
    ];
    printList<SearchRow>({
      rows,
      columns: SEARCH_COLUMNS,
      groupBy: 'scope',
      mode: 'plain',
      command: 'wiki search',
      emptyMessage: 'No matches',
      unit: 'page',
      io: r.io,
    });
    expect(r.out()).toBe('score=0.87\tGLOBAL\talpha\tfirst\n');
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
