import type { KtxTableListEntry } from './context/scan/types.js';
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

interface ScopeSuggestion {
  excluded: Set<string>;
  suggested: Set<string>;
}

/** @internal */
export interface DatabaseScopePromptAdapter {
  autocompleteMultiselect(options: {
    message: string;
    options: Array<{ value: string; label: string; hint?: string; disabled?: boolean }>;
    placeholder?: string;
    required?: boolean;
    maxItems?: number;
    initialValues?: string[];
  }): Promise<string[]>;
  select(options: {
    message: string;
    options: Array<{ value: string; label: string; hint?: string; disabled?: boolean }>;
  }): Promise<string>;
}

export interface PickDatabaseScopeArgs {
  connectionId: string;
  schemaNoun: string;
  schemaNounPlural: string;
  schemas: readonly string[];
  schemaSuggestion: ScopeSuggestion;
  existing: { enabledTables: readonly string[] };
  supportsSchemaScope: boolean;
  listTablesForSchemas: (schemas: string[]) => Promise<KtxTableListEntry[]>;
  initialSchemas?: readonly string[];
  prompts: DatabaseScopePromptAdapter;
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

function schemaOptions(args: PickDatabaseScopeArgs): Array<{ value: string; label: string; hint?: string }> {
  return args.schemas
    .filter((schema) => !args.schemaSuggestion.excluded.has(schema))
    .slice()
    .sort((left, right) => {
      const leftSuggested = args.schemaSuggestion.suggested.has(left);
      const rightSuggested = args.schemaSuggestion.suggested.has(right);
      if (leftSuggested !== rightSuggested) return leftSuggested ? -1 : 1;
      return left.localeCompare(right);
    })
    .map((schema) => ({
      value: schema,
      label: schema,
      ...(args.schemaSuggestion.suggested.has(schema) ? { hint: 'suggested' } : {}),
    }));
}

function initialStageOneSchemas(args: PickDatabaseScopeArgs): string[] {
  if (args.existing.enabledTables.length > 0) {
    return schemasFromEnabledTables(args.existing.enabledTables);
  }
  return [...(args.initialSchemas ?? [])];
}

async function runStageTwoTreePicker(input: {
  args: PickDatabaseScopeArgs;
  discovered: readonly KtxTableListEntry[];
  selectedSchemas: readonly string[];
  io: KtxCliIo;
  render: DatabaseTreePickerRenderer;
}): Promise<DatabaseScopePickResult> {
  const { args, discovered, selectedSchemas, io, render } = input;
  const { inputs, schemaIds, allTables } = buildTreeInputs(discovered);
  const tree = buildPickerTree(inputs);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const tableCount = allTables.length;
  const schemaCount = schemaIds.length;

  const initialSelection =
    args.existing.enabledTables.length > 0
      ? initialSelectionForExisting(args.existing.enabledTables, byId)
      : initialSelectionFromDefaults(selectedSchemas, schemaIds);

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

export async function pickDatabaseScope(
  args: PickDatabaseScopeArgs,
  io: KtxCliIo,
  render: DatabaseTreePickerRenderer = defaultRenderer,
): Promise<DatabaseScopePickResult> {
  let selectedSchemas = initialStageOneSchemas(args);
  while (true) {
    const pickedSchemas = await args.prompts.autocompleteMultiselect({
      message: `Choose ${args.schemaNounPlural} to enable for ${args.connectionId}\nType to filter. Space to select. Enter when done.`,
      placeholder: `Search ${args.schemaNounPlural}`,
      options: schemaOptions(args),
      initialValues: selectedSchemas,
      required: false,
    });
    if (pickedSchemas.includes('back')) {
      return { kind: 'back' };
    }
    selectedSchemas = pickedSchemas;
    if (selectedSchemas.length === 0) {
      io.stderr.write(`Nothing selected - type to filter, or Escape to skip ${args.schemaNoun} scope.\n`);
      continue;
    }

    const action = await args.prompts.select({
      message: `Save ${selectedSchemas.length} ${selectedSchemas.length === 1 ? args.schemaNoun : args.schemaNounPlural} or refine tables?`,
      options: [
        { value: 'save', label: 'Save selection' },
        { value: 'refine', label: 'Refine: choose individual tables' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (action === 'back') {
      continue;
    }

    const discovered = await args.listTablesForSchemas(selectedSchemas);
    if (action === 'save' && args.existing.enabledTables.length === 0) {
      return {
        kind: 'selected',
        activeSchemas: args.supportsSchemaScope ? selectedSchemas : [],
        enabledTables: discovered.map(qualifiedTableId),
      };
    }

    const refined = await runStageTwoTreePicker({
      args,
      discovered,
      selectedSchemas,
      io,
      render,
    });
    if (refined.kind === 'back') {
      continue;
    }
    return refined;
  }
}
