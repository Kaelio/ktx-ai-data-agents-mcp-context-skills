import { describe, expect, it, vi } from 'vitest';
import {
  pickDatabaseScope,
  type DatabaseScopePromptAdapter,
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
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
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

function promptAdapter(overrides: Partial<DatabaseScopePromptAdapter> = {}): DatabaseScopePromptAdapter {
  return {
    autocompleteMultiselect: vi.fn(async () => ['analytics']),
    select: vi.fn(async () => 'refine'),
    ...overrides,
  };
}

function baseArgs(overrides: Partial<PickDatabaseScopeArgs> = {}): PickDatabaseScopeArgs {
  return {
    connectionId: 'warehouse',
    schemaNoun: 'schema',
    schemaNounPlural: 'schemas',
    schemas: ['analytics', 'public'],
    schemaSuggestion: { excluded: new Set(), suggested: new Set(['analytics']) },
    existing: { enabledTables: [] },
    supportsSchemaScope: true,
    listTablesForSchemas: vi.fn(async () => discovered),
    prompts: promptAdapter(),
    ...overrides,
  };
}

describe('pickDatabaseScope', () => {
  it('starts Stage 1 with no checked schemas and does not enumerate tables before schema selection', async () => {
    const prompts = promptAdapter({
      autocompleteMultiselect: vi.fn(async () => ['analytics']),
      select: vi.fn(async () => 'save'),
    });
    const listTablesForSchemas = vi.fn(async () => [
      { schema: 'analytics', name: 'orders', kind: 'table' as const },
    ]);

    const result = await pickDatabaseScope(
      baseArgs({
        connectionId: 'warehouse',
        schemaNoun: 'dataset',
        schemaNounPlural: 'datasets',
        schemas: ['analytics', 'raw'],
        schemaSuggestion: { excluded: new Set(['raw']), suggested: new Set(['analytics']) },
        listTablesForSchemas,
        prompts,
      }),
      makeIo().io,
      captureRenderer().renderer,
    );

    expect(listTablesForSchemas).toHaveBeenCalledTimes(1);
    expect(listTablesForSchemas).toHaveBeenCalledWith(['analytics']);
    expect(result).toEqual({
      kind: 'selected',
      activeSchemas: ['analytics'],
      enabledTables: ['analytics.orders'],
    });
  });

  it('routes partial existing allowlists through Stage 2 so save preserves table selections', async () => {
    const { renderer, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: ['analytics.customers'] });
    const prompts = promptAdapter({
      autocompleteMultiselect: vi.fn(async () => ['analytics']),
      select: vi.fn(async () => 'save'),
    });
    const listTablesForSchemas = vi.fn(async () => [
      { schema: 'analytics', name: 'customers', kind: 'table' as const },
      { schema: 'analytics', name: 'orders', kind: 'table' as const },
    ]);

    const result = await pickDatabaseScope(
      baseArgs({
        schemas: ['analytics'],
        schemaSuggestion: { excluded: new Set(), suggested: new Set(['analytics']) },
        existing: { enabledTables: ['analytics.customers'] },
        listTablesForSchemas,
        prompts,
      }),
      makeIo().io,
      renderer,
    );

    expect(result).toEqual({
      kind: 'selected',
      activeSchemas: ['analytics'],
      enabledTables: ['analytics.customers'],
    });
  });

  it('builds a 2-level tree (schemas as parents, tables as children) and uses save-empty action', async () => {
    const { renderer, capture, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: ['analytics'] });

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

  it('pre-checks selected schemas at the parent level when no existing selection reaches Stage 2', async () => {
    const { renderer, capture, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: ['analytics'] });

    await pickDatabaseScope(baseArgs(), makeIo().io, renderer);

    expect([...(capture.state?.checked ?? [])]).toEqual(['analytics']);
  });

  it('collapses an existing full-schema selection back into the parent check', async () => {
    const { renderer, capture, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: ['analytics'] });

    await pickDatabaseScope(
      baseArgs({ existing: { enabledTables: ['analytics.customers', 'analytics.orders'] } }),
      makeIo().io,
      renderer,
    );

    expect([...(capture.state?.checked ?? [])]).toEqual(['analytics']);
  });

  it('keeps a partial existing selection at the leaf level', async () => {
    const { renderer, capture, setResult } = captureRenderer();
    setResult({ kind: 'save', selectedIds: ['analytics.customers'] });

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

  it('returns back when Stage 1 is cancelled', async () => {
    const prompts = promptAdapter({
      autocompleteMultiselect: vi.fn(async () => ['back']),
    });

    const result = await pickDatabaseScope(baseArgs({ prompts }), makeIo().io, captureRenderer().renderer);

    expect(result).toEqual({ kind: 'back' });
  });
});
