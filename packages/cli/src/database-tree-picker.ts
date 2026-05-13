import type { KtxTableListEntry } from '@ktx/context/scan';
import type { KtxCliIo } from './cli-runtime.js';
import { profileMark } from './startup-profile.js';
import {
  buildInitialState,
  buildPickerTree,
  type PickerState,
  type TreePickerNode,
  type TreePickerNodeInput,
} from './tree-picker-state.js';
import {
  renderTreePickerTui,
  type TreePickerChrome,
  type TreePickerResult,
  type TreePickerTuiIo,
} from './tree-picker-tui.js';

profileMark('module:database-tree-picker');

const DATABASE_SCRIPTED_MODE_HINT =
  'Database picker requires a TTY. Use --no-input and the relevant flags for scripted mode.';

export type DatabaseTreePickerRenderer = (
  chrome: TreePickerChrome,
  initialState: PickerState,
  io: TreePickerTuiIo,
) => Promise<TreePickerResult>;

function defaultRenderer(
  chrome: TreePickerChrome,
  initialState: PickerState,
  io: TreePickerTuiIo,
): Promise<TreePickerResult> {
  return renderTreePickerTui({ chrome, initialState }, io, { scriptedModeHint: DATABASE_SCRIPTED_MODE_HINT });
}

export type DatabaseScopePickResult =
  | { kind: 'selected'; activeSchemas: string[]; enabledTables: string[] }
  | { kind: 'back' };

export interface PickDatabaseScopeArgs {
  connectionId: string;
  schemaNoun: string;
  schemaNounPlural: string;
  discovered: readonly KtxTableListEntry[];
  existing: { enabledTables: readonly string[] };
  defaultSchemas: readonly string[];
  supportsSchemaScope: boolean;
}

function qualifiedTableId(entry: KtxTableListEntry): string {
  return `${entry.schema}.${entry.name}`;
}

function tableTitle(entry: KtxTableListEntry): string {
  return entry.kind === 'view' ? `${entry.name} (view)` : entry.name;
}

function buildTreeInputs(discovered: readonly KtxTableListEntry[]): {
  inputs: TreePickerNodeInput[];
  schemaIds: string[];
  allTables: string[];
} {
  const schemaSeen = new Set<string>();
  const schemaIds: string[] = [];
  for (const entry of discovered) {
    if (!schemaSeen.has(entry.schema)) {
      schemaSeen.add(entry.schema);
      schemaIds.push(entry.schema);
    }
  }
  const inputs: TreePickerNodeInput[] = [];
  for (const schema of schemaIds) {
    inputs.push({ id: schema, title: schema, archived: false, parentId: null });
  }
  for (const entry of discovered) {
    inputs.push({
      id: qualifiedTableId(entry),
      title: tableTitle(entry),
      archived: false,
      parentId: entry.schema,
    });
  }
  return { inputs, schemaIds, allTables: discovered.map(qualifiedTableId) };
}

function initialSelectionForExisting(
  existing: readonly string[],
  byId: Map<string, TreePickerNode>,
): string[] {
  const tableIds = new Set(
    [...byId.values()].filter((node) => node.parentId !== null).map((node) => node.id),
  );
  const existingTables = new Set(existing.filter((id) => tableIds.has(id)));
  const schemaChildren = new Map<string, string[]>();
  for (const node of byId.values()) {
    if (node.parentId === null && node.childIds.length > 0) {
      schemaChildren.set(node.id, [...node.childIds]);
    }
  }
  const result: string[] = [];
  for (const [schema, children] of schemaChildren) {
    const allChecked = children.length > 0 && children.every((childId) => existingTables.has(childId));
    if (allChecked) {
      result.push(schema);
      for (const childId of children) {
        existingTables.delete(childId);
      }
    }
  }
  for (const id of existingTables) {
    result.push(id);
  }
  return result;
}

function initialSelectionFromDefaults(
  defaultSchemas: readonly string[],
  schemaIds: readonly string[],
): string[] {
  const valid = new Set(schemaIds);
  const filtered = defaultSchemas.filter((s) => valid.has(s));
  return filtered.length > 0 ? filtered : [...schemaIds];
}

function expandSelectedToTables(
  selectedIds: readonly string[],
  byId: Map<string, TreePickerNode>,
): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    const node = byId.get(id);
    if (!node) continue;
    if (node.childIds.length === 0) {
      if (node.parentId !== null && !seen.has(id)) {
        seen.add(id);
        expanded.push(id);
      }
      continue;
    }
    for (const childId of node.childIds) {
      if (!seen.has(childId)) {
        seen.add(childId);
        expanded.push(childId);
      }
    }
  }
  return expanded;
}

function schemasFromEnabledTables(enabledTables: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const qualified of enabledTables) {
    const schema = qualified.split('.')[0] ?? '';
    if (schema.length === 0 || seen.has(schema)) continue;
    seen.add(schema);
    result.push(schema);
  }
  return result;
}

export async function pickDatabaseScope(
  args: PickDatabaseScopeArgs,
  io: KtxCliIo,
  render: DatabaseTreePickerRenderer = defaultRenderer,
): Promise<DatabaseScopePickResult> {
  const { inputs, schemaIds, allTables } = buildTreeInputs(args.discovered);
  const tree = buildPickerTree(inputs);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const tableCount = allTables.length;
  const schemaCount = schemaIds.length;

  const initialSelection =
    args.existing.enabledTables.length > 0
      ? initialSelectionForExisting(args.existing.enabledTables, byId)
      : initialSelectionFromDefaults(args.defaultSchemas, schemaIds);

  const initialState = buildInitialState({
    tree,
    existingSelectedIds: initialSelection,
    skipEmptyAction: 'save-empty',
  });

  const schemaWordPlural = schemaCount === 1 ? args.schemaNoun : args.schemaNounPlural;
  const subtitleLines = [
    `Connection: ${args.connectionId}`,
    `Found ${tableCount} ${tableCount === 1 ? 'table' : 'tables'} across ${schemaCount} ${schemaWordPlural}.`,
    `Toggle a ${args.schemaNoun} to enable all of its tables, or expand to pick individual tables.`,
  ];

  const chrome: TreePickerChrome = {
    title: `Choose tables to enable for ${args.connectionId}`,
    subtitleLines,
    skipEmptyMessage:
      'Nothing selected. Enable all tables? Press Enter to enable all or Escape to go back.',
  };

  const result = await render(chrome, initialState, io as TreePickerTuiIo);
  if (result.kind === 'quit') {
    return { kind: 'back' };
  }

  const enabledTables =
    result.selectedIds.length === 0 ? allTables : expandSelectedToTables(result.selectedIds, byId);
  const activeSchemas = args.supportsSchemaScope ? schemasFromEnabledTables(enabledTables) : [];

  return { kind: 'selected', activeSchemas, enabledTables };
}
