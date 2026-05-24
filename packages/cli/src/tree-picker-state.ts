export interface TreePickerNodeInput {
  id: string;
  title?: string | null;
  archived?: boolean;
  parentId?: string | null;
}

export interface TreePickerNode {
  id: string;
  title: string;
  archived: boolean;
  parentId: string | null;
  depth: number;
  childIds: string[];
  path: string;
}

type PendingConfirmKind = 'save-confirm' | 'skip-empty';

export type SkipEmptyAction = 'quit' | 'save-empty';

export interface PickerState {
  tree: TreePickerNode[];
  byId: Map<string, TreePickerNode>;
  expanded: Set<string>;
  checked: Set<string>;
  cursorId: string;
  search: { query: string };
  isNavigating: boolean;
  pendingConfirm: PendingConfirmKind | null;
  preLoadWarnings: string[];
  transientHint: { text: string; expiresAt: number } | null;
  requireConfirmOnSave: boolean;
  skipEmptyAction: SkipEmptyAction;
}

export type PickerCommand =
  | 'cursor-up'
  | 'cursor-down'
  | 'cursor-left'
  | 'cursor-right'
  | 'expand'
  | 'collapse'
  | 'expand-all'
  | 'collapse-all'
  | 'toggle-check'
  | 'select-all-visible'
  | 'toggle-select-all-visible'
  | 'select-none'
  | 'clear-transient-hint'
  | 'search-clear'
  | 'search-backspace'
  | { type: 'search-input'; value: string }
  | 'save-request'
  | 'save-confirm'
  | 'save-cancel'
  | 'quit';

type PickerEffect = null | 'save' | 'quit-without-save';

interface MutableNode {
  id: string;
  title: string;
  archived: boolean;
  parentId: string | null;
  childIds: string[];
}

const TRANSIENT_HINT_DURATION_MS = 2500;

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function titleValue(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : 'Untitled';
}

function sortedNodeIds(ids: string[], nodes: Map<string, MutableNode | TreePickerNode>): string[] {
  return [...ids].sort((leftId, rightId) => {
    const left = nodes.get(leftId);
    const right = nodes.get(rightId);
    const byTitle = collator.compare(left?.title ?? '', right?.title ?? '');
    return byTitle === 0 ? leftId.localeCompare(rightId) : byTitle;
  });
}

function cloneState(state: PickerState, patch: Partial<PickerState>): PickerState {
  return { ...state, ...patch };
}

function transientHint(text: string, now: number): PickerState['transientHint'] {
  return { text, expiresAt: now + TRANSIENT_HINT_DURATION_MS };
}

/** @internal */
export function clearExpiredTransientHint(state: PickerState, now = Date.now()): PickerState {
  if (!state.transientHint || state.transientHint.expiresAt > now) {
    return state;
  }
  return cloneState(state, { transientHint: null });
}

function ancestorsOf(nodeId: string, byId: Map<string, TreePickerNode>): string[] {
  const ancestors: string[] = [];
  let parentId = byId.get(nodeId)?.parentId ?? null;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    ancestors.push(parentId);
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return ancestors;
}

function descendantsOf(nodeId: string, byId: Map<string, TreePickerNode>): string[] {
  const result: string[] = [];
  const stack = [...(byId.get(nodeId)?.childIds ?? [])].reverse();
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) {
      continue;
    }
    result.push(id);
    const node = byId.get(id);
    if (node) {
      stack.push(...[...node.childIds].reverse());
    }
  }
  return result;
}

function matchingIds(state: PickerState): Set<string> {
  const query = state.search.query.trim().toLocaleLowerCase();
  if (!query) {
    return new Set(state.tree.map((node) => node.id));
  }
  return new Set(
    state.tree
      .filter((node) => {
        const title = node.title.toLocaleLowerCase();
        const path = node.path.toLocaleLowerCase();
        return title.includes(query) || path.includes(query);
      })
      .map((node) => node.id),
  );
}

export function buildPickerTree(inputs: TreePickerNodeInput[]): TreePickerNode[] {
  const nodes = new Map<string, MutableNode>();
  for (const result of inputs) {
    const id = result.id.trim();
    if (id.length === 0 || nodes.has(id)) {
      continue;
    }
    nodes.set(id, {
      id,
      title: titleValue(result.title),
      archived: result.archived === true,
      parentId: result.parentId ? result.parentId.trim() : null,
      childIds: [],
    });
  }

  for (const node of nodes.values()) {
    if (!node.parentId || node.parentId === node.id || !nodes.has(node.parentId)) {
      node.parentId = null;
      continue;
    }

    const seen = new Set([node.id]);
    let cursor: string | null = node.parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        node.parentId = null;
        break;
      }
      seen.add(cursor);
      cursor = nodes.get(cursor)?.parentId ?? null;
    }
  }

  for (const node of nodes.values()) {
    node.childIds = [];
  }
  for (const node of nodes.values()) {
    if (node.parentId) {
      nodes.get(node.parentId)?.childIds.push(node.id);
    }
  }
  for (const node of nodes.values()) {
    node.childIds = sortedNodeIds(node.childIds, nodes);
  }

  const roots = sortedNodeIds(
    [...nodes.values()].filter((node) => node.parentId === null).map((node) => node.id),
    nodes,
  );
  const tree: TreePickerNode[] = [];

  function visit(nodeId: string, depth: number, pathPrefix: string[]): void {
    const raw = nodes.get(nodeId);
    if (!raw) {
      return;
    }
    const path = [...pathPrefix, raw.title].join(' / ');
    const node: TreePickerNode = {
      id: raw.id,
      title: raw.title,
      archived: raw.archived,
      parentId: raw.parentId,
      depth,
      childIds: raw.childIds,
      path,
    };
    tree.push(node);
    for (const childId of raw.childIds) {
      visit(childId, depth + 1, [...pathPrefix, raw.title]);
    }
  }

  for (const rootId of roots) {
    visit(rootId, 0, []);
  }

  return tree;
}

export function isAncestorChecked(nodeId: string, checked: Set<string>, byId: Map<string, TreePickerNode>): boolean {
  return ancestorsOf(nodeId, byId).some((ancestorId) => checked.has(ancestorId));
}

export function hasPartialChildren(
  nodeId: string,
  checked: Set<string>,
  byId: Map<string, TreePickerNode>,
): boolean {
  if (checked.has(nodeId) || isAncestorChecked(nodeId, checked, byId)) {
    return false;
  }
  return descendantsOf(nodeId, byId).some((descendantId) => checked.has(descendantId));
}

function checkedAncestor(nodeId: string, state: PickerState): TreePickerNode | null {
  for (const ancestorId of ancestorsOf(nodeId, state.byId)) {
    if (state.checked.has(ancestorId)) {
      return state.byId.get(ancestorId) ?? null;
    }
  }
  return null;
}

/** @internal */
export function canToggle(nodeId: string, state: PickerState): { ok: true } | { ok: false; reason: string } {
  if (!state.byId.has(nodeId)) {
    return { ok: false, reason: 'Node not found' };
  }
  const ancestor = checkedAncestor(nodeId, state);
  if (ancestor) {
    return { ok: false, reason: `Locked by '${ancestor.title}' - uncheck parent first` };
  }
  return { ok: true };
}

/** @internal */
export function toggleChecked(state: PickerState, nodeId: string, now = Date.now()): PickerState {
  const toggle = canToggle(nodeId, state);
  if (!toggle.ok) {
    return cloneState(state, {
      transientHint: transientHint(toggle.reason, now),
    });
  }

  const checked = new Set(state.checked);
  if (checked.has(nodeId)) {
    checked.delete(nodeId);
  } else {
    checked.add(nodeId);
    for (const descendantId of descendantsOf(nodeId, state.byId)) {
      checked.delete(descendantId);
    }
  }
  return cloneState(state, { checked, transientHint: null });
}

export function flattenSelection(checked: Set<string>, byId: Map<string, TreePickerNode>): string[] {
  const result: string[] = [];
  for (const node of byId.values()) {
    if (checked.has(node.id) && !isAncestorChecked(node.id, checked, byId)) {
      result.push(node.id);
    }
  }
  return result;
}

export function filterTree(state: PickerState): { visibleIds: Set<string>; autoExpand: Set<string> } {
  const matches = matchingIds(state);
  if (state.search.query.trim().length === 0) {
    return { visibleIds: matches, autoExpand: new Set() };
  }

  const visibleIds = new Set<string>();
  const autoExpand = new Set<string>();
  for (const matchId of matches) {
    visibleIds.add(matchId);
    for (const ancestorId of ancestorsOf(matchId, state.byId)) {
      visibleIds.add(ancestorId);
      autoExpand.add(ancestorId);
    }
  }
  return { visibleIds, autoExpand };
}

export function visibleNodeIds(state: PickerState): string[] {
  const { visibleIds, autoExpand } = filterTree(state);
  const result: string[] = [];
  const roots = state.tree.filter((node) => node.parentId === null).map((node) => node.id);

  function visit(nodeId: string): void {
    if (!visibleIds.has(nodeId)) {
      return;
    }
    result.push(nodeId);
    const node = state.byId.get(nodeId);
    if (!node) {
      return;
    }
    if (state.expanded.has(nodeId) || autoExpand.has(nodeId)) {
      for (const childId of node.childIds) {
        visit(childId);
      }
    }
  }

  for (const rootId of roots) {
    visit(rootId);
  }
  return result;
}

/** @internal */
export function selectAllVisible(state: PickerState): PickerState {
  const candidates = state.search.query.trim().length > 0 ? matchingIds(state) : new Set(visibleNodeIds(state));
  const checked = new Set(state.checked);

  for (const node of state.tree) {
    if (!candidates.has(node.id)) {
      continue;
    }
    const hasCandidateAncestor = ancestorsOf(node.id, state.byId).some((ancestorId) => candidates.has(ancestorId));
    if (!hasCandidateAncestor && !isAncestorChecked(node.id, checked, state.byId)) {
      checked.add(node.id);
      for (const descendantId of descendantsOf(node.id, state.byId)) {
        checked.delete(descendantId);
      }
    }
  }

  return cloneState(state, {
    checked: new Set(flattenSelection(checked, state.byId)),
    transientHint: null,
  });
}

/** @internal */
export function selectNone(state: PickerState): PickerState {
  return cloneState(state, { checked: new Set(), transientHint: null });
}

function toggleSelectAllVisible(state: PickerState): PickerState {
  const next = selectAllVisible(state);
  const unchanged =
    next.checked.size === state.checked.size && [...next.checked].every((id) => state.checked.has(id));
  if (unchanged && state.checked.size > 0) {
    return selectNone(state);
  }
  return next;
}

function setExpanded(state: PickerState, nodeId: string, value: boolean | 'toggle'): PickerState {
  const expanded = new Set(state.expanded);
  const nextValue = value === 'toggle' ? !expanded.has(nodeId) : value;
  if (nextValue) {
    expanded.add(nodeId);
  } else {
    expanded.delete(nodeId);
  }
  return cloneState(state, { expanded });
}

/** @internal */
export function moveCursor(state: PickerState, dir: 'up' | 'down' | 'left' | 'right'): PickerState {
  const node = state.byId.get(state.cursorId);
  if (!node) {
    return state;
  }

  if (dir === 'left') {
    if (node.childIds.length > 0 && state.expanded.has(node.id)) {
      return setExpanded(state, node.id, false);
    }
    return node.parentId ? cloneState(state, { cursorId: node.parentId }) : state;
  }

  if (dir === 'right') {
    if (node.childIds.length === 0) {
      return state;
    }
    if (!state.expanded.has(node.id)) {
      return setExpanded(state, node.id, true);
    }
    return cloneState(state, { cursorId: node.childIds[0] ?? node.id });
  }

  const ids = visibleNodeIds(state);
  const index = ids.indexOf(state.cursorId);
  if (index === -1) {
    return ids[0] ? cloneState(state, { cursorId: ids[0] }) : state;
  }
  const nextIndex = dir === 'up' ? Math.max(0, index - 1) : Math.min(ids.length - 1, index + 1);
  return cloneState(state, { cursorId: ids[nextIndex] ?? state.cursorId });
}

export function buildInitialState(args: {
  tree: TreePickerNode[];
  existingSelectedIds: string[];
  requireConfirmOnSave?: boolean;
  skipEmptyAction?: SkipEmptyAction;
  staleWarning?: (staleCount: number) => string;
}): PickerState {
  const byId = new Map(args.tree.map((node) => [node.id, node]));
  const checked = new Set<string>();
  let staleCount = 0;

  for (const rawId of args.existingSelectedIds) {
    const id = rawId.trim();
    if (id.length === 0) {
      continue;
    }
    if (byId.has(id)) {
      checked.add(id);
    } else {
      staleCount += 1;
    }
  }

  const minimalChecked = new Set(flattenSelection(checked, byId));
  const expanded = new Set<string>();
  for (const checkedId of minimalChecked) {
    for (const ancestorId of ancestorsOf(checkedId, byId)) {
      expanded.add(ancestorId);
    }
  }

  const preLoadWarnings: string[] = [];
  if (staleCount > 0) {
    const warning = args.staleWarning ? args.staleWarning(staleCount) : `${staleCount} stored selections no longer visible`;
    preLoadWarnings.push(warning);
  }

  return {
    tree: args.tree,
    byId,
    expanded,
    checked: minimalChecked,
    cursorId: args.tree[0]?.id ?? '',
    search: { query: '' },
    isNavigating: false,
    pendingConfirm: null,
    preLoadWarnings,
    transientHint: null,
    requireConfirmOnSave: args.requireConfirmOnSave ?? false,
    skipEmptyAction: args.skipEmptyAction ?? 'quit',
  };
}

function refocusVisibleCursor(state: PickerState): PickerState {
  const ids = visibleNodeIds(state);
  if (ids.length === 0 || ids.includes(state.cursorId)) {
    return state;
  }
  return cloneState(state, { cursorId: ids[0]! });
}

export function reducer(state: PickerState, cmd: PickerCommand, now = Date.now()): { next: PickerState; effect: PickerEffect } {
  if (state.pendingConfirm) {
    if (cmd === 'save-confirm') {
      const effect: PickerEffect =
        state.pendingConfirm === 'skip-empty' ? (state.skipEmptyAction === 'save-empty' ? 'save' : 'quit-without-save') : 'save';
      return { next: cloneState(state, { pendingConfirm: null }), effect };
    }
    if (cmd === 'save-cancel') {
      return { next: cloneState(state, { pendingConfirm: null }), effect: null };
    }
    if (cmd === 'quit') {
      return { next: state, effect: 'quit-without-save' };
    }
    return { next: state, effect: null };
  }

  switch (cmd) {
    case 'cursor-up':
      return { next: cloneState(moveCursor(state, 'up'), { isNavigating: true }), effect: null };
    case 'cursor-down':
      return { next: cloneState(moveCursor(state, 'down'), { isNavigating: true }), effect: null };
    case 'cursor-left':
      return { next: cloneState(moveCursor(state, 'left'), { isNavigating: true }), effect: null };
    case 'cursor-right':
      return { next: cloneState(moveCursor(state, 'right'), { isNavigating: true }), effect: null };
    case 'expand':
      return { next: setExpanded(state, state.cursorId, 'toggle'), effect: null };
    case 'collapse':
      return { next: setExpanded(state, state.cursorId, false), effect: null };
    case 'expand-all':
      return {
        next: cloneState(state, {
          expanded: new Set(state.tree.filter((node) => node.childIds.length > 0).map((node) => node.id)),
        }),
        effect: null,
      };
    case 'collapse-all':
      return { next: cloneState(state, { expanded: new Set() }), effect: null };
    case 'toggle-check':
      return { next: toggleChecked(state, state.cursorId, now), effect: null };
    case 'select-all-visible':
      return { next: selectAllVisible(state), effect: null };
    case 'toggle-select-all-visible':
      return { next: toggleSelectAllVisible(state), effect: null };
    case 'select-none':
      return { next: selectNone(state), effect: null };
    case 'clear-transient-hint':
      return { next: clearExpiredTransientHint(state, now), effect: null };
    case 'search-clear':
      return {
        next: cloneState(state, { search: { query: '' }, isNavigating: false }),
        effect: null,
      };
    case 'search-backspace':
      return {
        next: refocusVisibleCursor(
          cloneState(state, {
            search: { query: state.search.query.slice(0, -1) },
            isNavigating: false,
          }),
        ),
        effect: null,
      };
    case 'save-request':
      if (state.checked.size === 0) {
        return { next: cloneState(state, { pendingConfirm: 'skip-empty' }), effect: null };
      }
      if (state.requireConfirmOnSave) {
        return { next: cloneState(state, { pendingConfirm: 'save-confirm' }), effect: null };
      }
      return { next: state, effect: 'save' };
    case 'save-confirm':
    case 'save-cancel':
      return { next: state, effect: null };
    case 'quit':
      return { next: state, effect: 'quit-without-save' };
    default:
      return {
        next: refocusVisibleCursor(
          cloneState(state, {
            search: { query: state.search.query + cmd.value },
            isNavigating: false,
          }),
        ),
        effect: null,
      };
  }
}
