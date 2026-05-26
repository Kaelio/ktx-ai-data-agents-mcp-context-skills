import { describe, expect, it } from 'vitest';
import {
  buildInitialState,
  buildPickerTree,
  canToggle,
  clearExpiredTransientHint,
  filterTree,
  flattenSelection,
  hasPartialChildren,
  moveCursor,
  reducer,
  selectAllVisible,
  selectNone,
  toggleChecked,
  visibleNodeIds,
  type TreePickerNodeInput,
} from '../src/tree-picker-state.js';

const IDS = {
  engineering: '11111111-1111-1111-1111-111111111111',
  architecture: '22222222-2222-2222-2222-222222222222',
  onboarding: '33333333-3333-3333-3333-333333333333',
  marketing: '44444444-4444-4444-4444-444444444444',
  journal: '55555555-5555-5555-5555-555555555555',
  orphan: '66666666-6666-6666-6666-666666666666',
  duplicate: '77777777-7777-7777-7777-777777777777',
  cycleA: '88888888-8888-8888-8888-888888888888',
  cycleB: '99999999-9999-9999-9999-999999999999',
};

function pages(): TreePickerNodeInput[] {
  return [
    { id: IDS.marketing, title: 'Marketing', archived: false, parentId: null },
    { id: IDS.onboarding, title: 'Onboarding', archived: false, parentId: IDS.engineering },
    { id: IDS.engineering, title: 'Engineering Docs', archived: false, parentId: null },
    { id: IDS.architecture, title: 'Architecture', archived: false, parentId: IDS.engineering },
    { id: IDS.journal, title: 'Daily journal', archived: true, parentId: IDS.marketing },
    { id: IDS.orphan, title: '', archived: false, parentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    { id: IDS.duplicate, title: 'Original duplicate', archived: false, parentId: null },
    { id: IDS.duplicate, title: 'Ignored duplicate', archived: true, parentId: IDS.marketing },
    { id: IDS.cycleA, title: 'Cycle A', archived: false, parentId: IDS.cycleB },
    { id: IDS.cycleB, title: 'Cycle B', archived: false, parentId: IDS.cycleA },
  ];
}

describe('buildPickerTree', () => {
  it('deduplicates nodes, sorts siblings, preserves archived flags, roots orphans, and breaks cycles', () => {
    const tree = buildPickerTree(pages());
    const byId = new Map(tree.map((node) => [node.id, node]));

    expect(tree.map((node) => node.title)).toEqual([
      'Cycle A',
      'Cycle B',
      'Engineering Docs',
      'Architecture',
      'Onboarding',
      'Marketing',
      'Daily journal',
      'Original duplicate',
      'Untitled',
    ]);
    expect(byId.get(IDS.engineering)?.childIds).toEqual([IDS.architecture, IDS.onboarding]);
    expect(byId.get(IDS.architecture)).toMatchObject({
      depth: 1,
      parentId: IDS.engineering,
      path: 'Engineering Docs / Architecture',
    });
    expect(byId.get(IDS.journal)).toMatchObject({
      archived: true,
      depth: 1,
      path: 'Marketing / Daily journal',
    });
    expect(byId.get(IDS.orphan)).toMatchObject({
      title: 'Untitled',
      parentId: null,
      depth: 0,
      path: 'Untitled',
    });
    expect(byId.get(IDS.duplicate)).toMatchObject({
      title: 'Original duplicate',
      archived: false,
      parentId: null,
    });
    expect(byId.get(IDS.cycleA)?.parentId).toBeNull();
    expect(byId.get(IDS.cycleB)?.parentId).toBe(IDS.cycleA);
  });
});

describe('selection invariants', () => {
  it('checking a parent locks descendants and keeps checked ids minimal', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [],
    });

    const checkedParent = toggleChecked(state, IDS.engineering, 1000);
    expect([...checkedParent.checked]).toEqual([IDS.engineering]);
    expect(canToggle(IDS.architecture, checkedParent)).toEqual({
      ok: false,
      reason: "Locked by 'Engineering Docs' - uncheck parent first",
    });

    const lockedChildAttempt = toggleChecked(checkedParent, IDS.architecture, 2000);
    expect([...lockedChildAttempt.checked]).toEqual([IDS.engineering]);
    expect(lockedChildAttempt.transientHint).toEqual({
      text: "Locked by 'Engineering Docs' - uncheck parent first",
      expiresAt: 4500,
    });

    const uncheckedParent = toggleChecked(lockedChildAttempt, IDS.engineering, 3000);
    expect([...uncheckedParent.checked]).toEqual([]);
    expect(canToggle(IDS.architecture, uncheckedParent)).toEqual({ ok: true });
  });

  it('reports stale stored ids via the caller-supplied warning, expands checked ancestors, and flattens descendants', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [IDS.engineering, IDS.architecture, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
      staleWarning: (staleCount) => `${staleCount} stored root_page_ids no longer visible`,
    });

    expect([...state.checked]).toEqual([IDS.engineering]);
    expect([...state.expanded]).toEqual([]);
    expect(state.cursorId).toBe(IDS.cycleA);
    expect(state.preLoadWarnings).toEqual(['1 stored root_page_ids no longer visible']);
    expect(flattenSelection(new Set([IDS.engineering, IDS.architecture]), state.byId)).toEqual([IDS.engineering]);
  });

  it('falls back to a generic stale warning when no warning factory is supplied', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
    });
    expect(state.preLoadWarnings).toEqual(['1 stored selections no longer visible']);
  });
});

describe('hasPartialChildren', () => {
  const ROOT = 'r0000000-0000-0000-0000-000000000000';
  const CHILD_A = 'a0000000-0000-0000-0000-000000000000';
  const CHILD_B = 'b0000000-0000-0000-0000-000000000000';
  const GRANDCHILD = 'g0000000-0000-0000-0000-000000000000';
  const LEAF = 'l0000000-0000-0000-0000-000000000000';

  function tree() {
    return buildPickerTree([
      { id: ROOT, title: 'Root', parentId: null },
      { id: CHILD_A, title: 'Child A', parentId: ROOT },
      { id: CHILD_B, title: 'Child B', parentId: ROOT },
      { id: GRANDCHILD, title: 'Grandchild', parentId: CHILD_A },
      { id: LEAF, title: 'Leaf', parentId: null },
    ]);
  }

  function byId() {
    return new Map(tree().map((node) => [node.id, node]));
  }

  it('returns false for a leaf node with no children', () => {
    expect(hasPartialChildren(LEAF, new Set(), byId())).toBe(false);
    expect(hasPartialChildren(LEAF, new Set([LEAF]), byId())).toBe(false);
  });

  it('returns false when the node itself is checked', () => {
    expect(hasPartialChildren(ROOT, new Set([ROOT]), byId())).toBe(false);
  });

  it('returns false when an ancestor is checked (node is locked)', () => {
    expect(hasPartialChildren(CHILD_A, new Set([ROOT]), byId())).toBe(false);
  });

  it('returns true when a direct child is checked', () => {
    expect(hasPartialChildren(ROOT, new Set([CHILD_A]), byId())).toBe(true);
  });

  it('returns true when a deep descendant is checked', () => {
    expect(hasPartialChildren(ROOT, new Set([GRANDCHILD]), byId())).toBe(true);
  });

  it('returns false when no descendant is checked', () => {
    expect(hasPartialChildren(ROOT, new Set([LEAF]), byId())).toBe(false);
    expect(hasPartialChildren(ROOT, new Set(), byId())).toBe(false);
  });
});

describe('search and cursor movement', () => {
  it('filters by title and path while deriving auto-expanded ancestors', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [],
    });
    const searching = {
      ...state,
      search: { query: 'architecture' },
    };

    expect(filterTree(searching)).toEqual({
      visibleIds: new Set([IDS.engineering, IDS.architecture]),
      autoExpand: new Set([IDS.engineering]),
    });
    expect(visibleNodeIds(searching)).toEqual([IDS.engineering, IDS.architecture]);
  });

  it('moves the cursor through visible nodes and implements left/right tree semantics', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [],
    });

    const atEngineering = {
      ...state,
      cursorId: IDS.engineering,
      expanded: new Set([IDS.engineering]),
    };
    expect(moveCursor(atEngineering, 'down').cursorId).toBe(IDS.architecture);
    expect(moveCursor({ ...atEngineering, cursorId: IDS.architecture }, 'up').cursorId).toBe(IDS.engineering);
    expect(moveCursor(atEngineering, 'right').cursorId).toBe(IDS.architecture);
    expect(moveCursor({ ...atEngineering, cursorId: IDS.architecture }, 'left').cursorId).toBe(IDS.engineering);
    expect([...moveCursor(atEngineering, 'left').expanded]).toEqual([]);
    expect([...moveCursor({ ...state, cursorId: IDS.marketing }, 'right').expanded]).toContain(IDS.marketing);
  });
});

describe('bulk actions and reducer effects', () => {
  it('selects only matching visible roots under search and clears selection', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [IDS.marketing],
    });
    const searching = {
      ...state,
      search: { query: 'architecture' },
    };

    const selected = selectAllVisible(searching);
    expect(flattenSelection(selected.checked, selected.byId)).toEqual([IDS.architecture, IDS.marketing]);
    expect([...selectNone(selected).checked]).toEqual([]);
  });

  it('toggle-select-all-visible selects all visible roots, then clears on repeat', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [],
    });

    const firstPress = reducer(state, 'toggle-select-all-visible').next;
    expect(firstPress.checked.size).toBeGreaterThan(0);
    const allSelectedIds = [...firstPress.checked].sort();

    const secondPress = reducer(firstPress, 'toggle-select-all-visible').next;
    expect([...secondPress.checked]).toEqual([]);

    const thirdPress = reducer(secondPress, 'toggle-select-all-visible').next;
    expect([...thirdPress.checked].sort()).toEqual(allSelectedIds);
  });

  it('saves immediately when confirm is not required and prompts confirmation when requireConfirmOnSave is true', () => {
    const noConfirm = toggleChecked(
      buildInitialState({
        tree: buildPickerTree(pages()),
        existingSelectedIds: [],
      }),
      IDS.marketing,
      1000,
    );
    expect(reducer(noConfirm, 'save-request')).toEqual({
      next: noConfirm,
      effect: 'save',
    });

    const confirmRequired = {
      ...noConfirm,
      requireConfirmOnSave: true,
    };
    const confirm = reducer(confirmRequired, 'save-request');
    expect(confirm).toEqual({
      next: { ...confirmRequired, pendingConfirm: 'save-confirm' },
      effect: null,
    });
    expect(reducer(confirm.next, 'save-cancel')).toEqual({
      next: { ...confirmRequired, pendingConfirm: null },
      effect: null,
    });
    expect(reducer(confirm.next, 'save-confirm')).toEqual({
      next: { ...confirmRequired, pendingConfirm: null },
      effect: 'save',
    });
  });

  it('prompts skip-empty confirmation on empty save, updates search state, and quits without saving', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [],
    });

    const emptySave = reducer(state, 'save-request');
    expect(emptySave).toEqual({
      next: { ...state, pendingConfirm: 'skip-empty' },
      effect: null,
    });
    expect(reducer(emptySave.next, 'save-confirm')).toEqual({
      next: { ...state, pendingConfirm: null },
      effect: 'quit-without-save',
    });
    expect(reducer(emptySave.next, 'save-cancel')).toEqual({
      next: { ...state, pendingConfirm: null },
      effect: null,
    });
    expect(reducer(state, { type: 'search-input', value: 'a' }).next.search).toEqual({ query: 'a' });
    expect(reducer({ ...state, isNavigating: true }, { type: 'search-input', value: 'b' }).next.isNavigating).toBe(false);
    expect(
      reducer({ ...state, search: { query: 'foo' }, isNavigating: true }, 'search-clear').next,
    ).toEqual({ ...state, search: { query: '' }, isNavigating: false });
    expect(reducer(state, 'quit')).toEqual({
      next: state,
      effect: 'quit-without-save',
    });
  });

  it('treats skip-empty confirmation as a save with empty selection when skipEmptyAction is save-empty', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [],
      skipEmptyAction: 'save-empty',
    });

    const emptySave = reducer(state, 'save-request');
    expect(emptySave).toEqual({
      next: { ...state, pendingConfirm: 'skip-empty' },
      effect: null,
    });
    expect(reducer(emptySave.next, 'save-confirm')).toEqual({
      next: { ...state, pendingConfirm: null },
      effect: 'save',
    });
  });

  it('navigates cursor commands set isNavigating, typed input clears it, and search refocuses cursor', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [],
    });

    expect(state.isNavigating).toBe(false);
    const afterDown = reducer(state, 'cursor-down').next;
    expect(afterDown.isNavigating).toBe(true);

    const afterType = reducer(afterDown, { type: 'search-input', value: 'a' }).next;
    expect(afterType.isNavigating).toBe(false);
    expect(afterType.search.query).toBe('a');

    const afterBackspace = reducer({ ...afterDown, search: { query: 'foo' } }, 'search-backspace').next;
    expect(afterBackspace.search.query).toBe('fo');
    expect(afterBackspace.isNavigating).toBe(false);

    const withCursorOnHidden = {
      ...state,
      cursorId: IDS.journal,
      search: { query: 'arch' },
    };
    const refocused = reducer(withCursorOnHidden, { type: 'search-input', value: 'i' }).next;
    expect(refocused.search.query).toBe('archi');
    expect(visibleNodeIds(refocused)).toContain(refocused.cursorId);
  });

  it('clears transient hints only when their expiry time has passed', () => {
    const state = buildInitialState({
      tree: buildPickerTree(pages()),
      existingSelectedIds: [],
    });
    const withHint = {
      ...state,
      transientHint: {
        text: 'Select at least one item or press esc to cancel',
        expiresAt: 11500,
      },
    };

    expect(clearExpiredTransientHint(withHint, 11499)).toBe(withHint);
    expect(clearExpiredTransientHint(withHint, 11500)).toEqual({
      ...withHint,
      transientHint: null,
    });
    expect(reducer(withHint, 'clear-transient-hint', 11501)).toEqual({
      next: {
        ...withHint,
        transientHint: null,
      },
      effect: null,
    });
  });
});
