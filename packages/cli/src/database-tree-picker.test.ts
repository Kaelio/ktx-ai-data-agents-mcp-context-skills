import { describe, expect, it, vi } from 'vitest';
import {
  pickDatabaseScope,
  type DatabaseTreePickerRenderer,
  type PickDatabaseScopeArgs,
} from './database-tree-picker.js';
import type { TreePickerChrome, TreePickerResult } from './tree-picker-tui.js';
import type { PickerState } from './tree-picker-state.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { isTTY: true, write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function captureRenderer(): {
  renderer: DatabaseTreePickerRenderer;
  capture: { chrome?: TreePickerChrome; state?: PickerState };
  setResult: (result: TreePickerResult) => void;
} {
  const capture: { chrome?: TreePickerChrome; state?: PickerState } = {};
  let nextResult: TreePickerResult = { kind: 'quit' };
  const renderer: DatabaseTreePickerRenderer = vi.fn(async (chrome, state) => {
    capture.chrome = chrome;
    capture.state = state;
    return nextResult;
  });
  return {
    renderer,
    capture,
    setResult: (result) => {
      nextResult = result;
    },
  };
}

const discovered = [
  { schema: 'analytics', name: 'customers', kind: 'table' as const },
  { schema: 'analytics', name: 'orders', kind: 'table' as const },
  { schema: 'public', name: 'events', kind: 'view' as const },
  { schema: 'public', name: 'sessions', kind: 'table' as const },
];

function baseArgs(overrides: Partial<PickDatabaseScopeArgs> = {}): PickDatabaseScopeArgs {
  return {
    connectionId: 'warehouse',
    schemaNoun: 'schema',
    schemaNounPlural: 'schemas',
    discovered,
    existing: { enabledTables: [] },
    defaultSchemas: ['analytics'],
    supportsSchemaScope: true,
    ...overrides,
  };
}

describe('pickDatabaseScope', () => {
  it('builds a 2-level tree (schemas as parents, tables as children) and uses save-empty action', async () => {
    const { renderer, capture, setResult } = captureRenderer();
    setResult({ kind: 'quit' });

    await pickDatabaseScope(baseArgs(), makeIo().io, renderer);

    expect(capture.state?.skipEmptyAction).toBe('save-empty');
    const schemaIds = capture.state?.tree.filter((n) => n.parentId === null).map((n) => n.id);
    const tableIds = capture.state?.tree.filter((n) => n.parentId !== null).map((n) => n.id);
    expect((schemaIds ?? []).sort()).toEqual(['analytics', 'public']);
    expect((tableIds ?? []).sort()).toEqual([
      'analytics.customers',
      'analytics.orders',
      'public.events',
      'public.sessions',
    ]);
    expect(capture.state?.byId.get('public.events')?.title).toBe('events (view)');
  });

  it('pre-checks default schemas at the parent level when no existing selection', async () => {
    const { renderer, capture, setResult } = captureRenderer();
    setResult({ kind: 'quit' });

    await pickDatabaseScope(baseArgs({ defaultSchemas: ['analytics'] }), makeIo().io, renderer);

    expect([...(capture.state?.checked ?? [])]).toEqual(['analytics']);
  });

  it('collapses an existing full-schema selection back into the parent check', async () => {
    const { renderer, capture, setResult } = captureRenderer();
    setResult({ kind: 'quit' });

    await pickDatabaseScope(
      baseArgs({ existing: { enabledTables: ['analytics.customers', 'analytics.orders'] } }),
      makeIo().io,
      renderer,
    );

    expect([...(capture.state?.checked ?? [])]).toEqual(['analytics']);
  });

  it('keeps a partial existing selection at the leaf level', async () => {
    const { renderer, capture, setResult } = captureRenderer();
    setResult({ kind: 'quit' });

    await pickDatabaseScope(
      baseArgs({ existing: { enabledTables: ['analytics.customers'] } }),
      makeIo().io,
      renderer,
    );

    expect([...(capture.state?.checked ?? [])]).toEqual(['analytics.customers']);
  });

  it('expands a selected schema parent into all its tables and derives activeSchemas', async () => {
    const { renderer, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: ['analytics'] });

    const result = await pickDatabaseScope(baseArgs(), makeIo().io, renderer);

    expect(result).toEqual({
      kind: 'selected',
      activeSchemas: ['analytics'],
      enabledTables: ['analytics.customers', 'analytics.orders'],
    });
  });

  it('combines parent and individual leaf selections without duplicate tables', async () => {
    const { renderer, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: ['analytics', 'public.events'] });

    const result = await pickDatabaseScope(baseArgs(), makeIo().io, renderer);

    expect(result).toEqual({
      kind: 'selected',
      activeSchemas: ['analytics', 'public'],
      enabledTables: ['analytics.customers', 'analytics.orders', 'public.events'],
    });
  });

  it('treats empty save as enable-all', async () => {
    const { renderer, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: [] });

    const result = await pickDatabaseScope(baseArgs(), makeIo().io, renderer);

    expect(result).toEqual({
      kind: 'selected',
      activeSchemas: ['analytics', 'public'],
      enabledTables: [
        'analytics.customers',
        'analytics.orders',
        'public.events',
        'public.sessions',
      ],
    });
  });

  it('omits activeSchemas when the driver does not support a schema scope', async () => {
    const { renderer, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: ['analytics'] });

    const result = await pickDatabaseScope(
      baseArgs({ supportsSchemaScope: false }),
      makeIo().io,
      renderer,
    );

    expect(result).toEqual({
      kind: 'selected',
      activeSchemas: [],
      enabledTables: ['analytics.customers', 'analytics.orders'],
    });
  });

  it('returns back when the picker quits', async () => {
    const { renderer, setResult } = captureRenderer();
    setResult({ kind: 'quit' });

    const result = await pickDatabaseScope(baseArgs(), makeIo().io, renderer);

    expect(result).toEqual({ kind: 'back' });
  });
});
