# Isolated Diff Ingestion V1 Reference and Target Gate Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking isolated-diff correctness gaps by
validating final wiki page references and enforcing allowed semantic-layer
target connections before any isolated-diff run can squash into main.

**Architecture:** Extend the existing validation-only artifact gate rather than
adding a resolver. Wiki reference validation runs in the final composed
integration worktree for changed wiki pages, including frontmatter `refs` and
inline `[[page-key]]` references. Semantic-layer target authorization is
enforced in three places: SL write/edit tools reject out-of-scope connection
IDs, WorkUnit patch policy rejects unauthorized `semantic-layer/<connection>/`
paths, and the runner checks projection, reconciliation, post-processor, and
repair paths before final gates and squash. Target-policy failures emit
persistent JSONL trace events and failed reports with enough path and connection
context for postmortem reconstruction.

**Tech Stack:** TypeScript ESM/NodeNext, Vitest, simple-git, existing
`IngestBundleRunner`, `GitService`, `SlWriteSourceTool`, `SlEditSourceTool`,
`KnowledgeWikiService`, `findMissingWikiRefs`, ingest reports, and persistent
ingest traces.

---

## Audit summary

The implemented plans cover the main v1 isolated-diff flow: integration
worktree creation, child worktrees from the post-projection base, binary
no-rename patches, `git apply --3way --index`, final semantic-layer and wiki
SL/body gates after reconciliation, structured conflict classification, child
cleanup, failed reports, persistent JSONL traces, and pre-squash provenance raw
path validation.

Two concrete v1-blocking gaps remain:

- Final global gates do not validate wiki page references. Existing local
  checks use `findDanglingWikiRefsForActions()`, but
  `validateFinalIngestArtifacts()` validates only wiki `sl_refs` and body
  semantic/table references. A WorkUnit can update a page that references an
  existing page while another accepted WorkUnit deletes that target page. Both
  local gates can pass, and the final tree can squash with a dangling
  frontmatter `refs` or inline `[[page-key]]` reference.
- Allowed semantic-layer target connections are not enforced for SL write/edit
  tools or integration diffs. The runner computes `slConnectionIds` from the
  primary connection plus adapter-declared targets, but `sl_write_source` and
  `sl_edit_source` ignore `session.allowedConnectionNames`, and patch policy
  rejects only `slDisallowed` plus binary/mode violations. A buggy tool call or
  bypassed tool can write `semantic-layer/<unauthorized>/...` and reach main if
  the artifact is otherwise valid.

Non-blocking gaps remain unchanged:

- Migrating Notion, LookML, Looker, dbt, MetricFlow, and historic-SQL direct
  durable writes to the isolated path.
- Promoting isolated diffs as the default for all connectors.
- Removing the old shared-worktree WorkUnit execution path.
- Interactive, CLI, or agent-driven conflict resolution.
- Auto-merging semantic conflicts that cannot be proven correct.
- Transitive SQL-projection dependency expansion beyond direct declared joins.
- Moving provenance rows to worktree files.
- Adding stored failure reports for failures before an ingest run row exists.
  The deterministic trace file is still written for those early failures.

## File structure

- Create `packages/context/src/ingest/semantic-layer-target-policy.ts`.
  Owns semantic-layer path-to-connection parsing and authorization errors.
- Create `packages/context/src/ingest/semantic-layer-target-policy.test.ts`.
  Covers allowed paths, unauthorized paths, non-SL paths, and sorted errors.
- Modify `packages/context/src/ingest/artifact-gates.ts`.
  Adds final wiki page reference validation for changed pages.
- Modify `packages/context/src/ingest/artifact-gates.test.ts`.
  Adds dangling final wiki `refs` and `[[...]]` coverage and updates mocks with
  `listPageKeys()`.
- Create `packages/context/src/tools/action-target-connection.ts`.
  Adds session-level target connection validation shared by SL write/edit
  tools.
- Modify `packages/context/src/tools/index.ts`.
  Exports `validateActionTargetConnection()`.
- Modify `packages/context/src/sl/tools/sl-write-source.tool.ts`.
  Rejects session-scoped writes to connections outside
  `allowedConnectionNames`.
- Modify `packages/context/src/sl/tools/sl-write-source.tool.test.ts`.
  Covers denied session-scoped writes.
- Modify `packages/context/src/sl/tools/sl-edit-source.tool.ts`.
  Rejects session-scoped edits and deletes to connections outside
  `allowedConnectionNames`.
- Modify `packages/context/src/sl/tools/sl-edit-source.tool.test.ts`.
  Covers denied session-scoped edits.
- Modify `packages/context/src/ingest/isolated-diff/git-patch.ts`.
  Adds allowed target connection checks to WorkUnit patch policy.
- Modify `packages/context/src/ingest/isolated-diff/git-patch.test.ts`.
  Covers unauthorized semantic-layer paths in patches.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.ts`.
  Accepts `allowedTargetConnectionIds` and includes it in policy rejection
  traces.
- Modify `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`.
  Covers traced unauthorized target rejection.
- Modify `packages/context/src/ingest/ingest-bundle.runner.ts`.
  Passes allowed target sets to patch integration and runs a traced target
  policy gate over final integration-stage paths before final artifact gates.
- Modify `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`.
  Adds cross-WorkUnit wiki-ref deletion, unauthorized WorkUnit patch, and
  unauthorized reconciliation mutation regressions.
- Modify `packages/context/src/ingest/index.ts`.
  Exports target-policy helpers for tests and future runner checks.

---

### Task 1: Add final wiki reference validation

**Files:**
- Modify: `packages/context/src/ingest/artifact-gates.test.ts`
- Modify: `packages/context/src/ingest/artifact-gates.ts`

- [ ] **Step 1: Write failing final wiki reference tests**

In `packages/context/src/ingest/artifact-gates.test.ts`, add this helper near
the top of the file after the imports:

```ts
function wikiServiceWithPages(pages: Record<string, { refs?: string[]; content?: string; slRefs?: string[] }>) {
  return {
    listPageKeys: vi.fn().mockResolvedValue(Object.keys(pages)),
    readPage: vi.fn().mockImplementation((_scope: string, _scopeId: string | null, pageKey: string) => {
      const page = pages[pageKey];
      if (!page) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        pageKey,
        frontmatter: {
          summary: pageKey,
          usage_mode: 'auto',
          refs: page.refs,
          sl_refs: page.slRefs,
        },
        content: page.content ?? '',
      });
    }),
  };
}
```

Replace the three existing inline `wikiService = { readPage: ... }` mocks with
`wikiServiceWithPages(...)` so those tests expose `listPageKeys()`. Use these
exact replacements:

```ts
const wikiService = wikiServiceWithPages({
  'account-segments': {
    slRefs: ['mart_account_segments'],
    content: 'ARR is `mart_account_segments.total_contract_arr_cents`.',
  },
});
```

```ts
const wikiService = wikiServiceWithPages({
  'account-segments': {
    slRefs: ['mart_account_segments.total_contract_arr_cents'],
    content: 'ARR uses a renamed measure.',
  },
});
```

```ts
const wikiService = wikiServiceWithPages({});
```

Append this test inside `describe('artifact gates', ...)`:

```ts
  it('fails final gates when a changed wiki page references a missing wiki page', async () => {
    const wikiService = wikiServiceWithPages({
      'account-segments': {
        refs: ['missing-frontmatter-page'],
        content: 'See [[missing-inline-page]] for the related process.',
      },
    });
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
    };

    await expect(
      validateFinalIngestArtifacts({
        connectionIds: ['warehouse'],
        changedWikiPageKeys: ['account-segments'],
        touchedSlSources: [],
        wikiService: wikiService as never,
        semanticLayerService: semanticLayerService as never,
        validateTouchedSources: async () => ({ invalidSources: [], validSources: [] }),
        tableExists: async () => true,
      }),
    ).rejects.toThrow(/wiki references target missing page\(s\): account-segments -> missing-frontmatter-page, account-segments -> missing-inline-page/);
  });
```

- [ ] **Step 2: Run the failing artifact-gate test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/artifact-gates.test.ts -t "missing wiki page"
```

Expected: FAIL because `validateFinalIngestArtifacts()` does not validate wiki
frontmatter `refs` or inline `[[...]]` references.

- [ ] **Step 3: Implement final wiki reference validation**

In `packages/context/src/ingest/artifact-gates.ts`, add this import:

```ts
import { findMissingWikiRefs } from '../wiki/wiki-ref-validation.js';
```

Add this helper after `validateWikiSlRefs()`:

```ts
async function validateWikiRefs(input: FinalArtifactGateInput): Promise<string[]> {
  const dangling: string[] = [];
  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    const missingRefs = await findMissingWikiRefs({
      wikiService: input.wikiService,
      scope: 'GLOBAL',
      scopeId: null,
      pageKey,
      refs: page.frontmatter.refs,
      content: page.content,
    });
    for (const missingRef of missingRefs) {
      dangling.push(`${pageKey} -> ${missingRef}`);
    }
  }
  return dangling;
}
```

In `validateFinalIngestArtifacts()`, immediately after this line:

```ts
  errors.push(...(await validateWikiSlRefs(input)));
```

add:

```ts
  const danglingWikiRefs = await validateWikiRefs(input);
  if (danglingWikiRefs.length > 0) {
    errors.push(`wiki references target missing page(s): ${danglingWikiRefs.join(', ')}`);
  }
```

- [ ] **Step 4: Run artifact-gate tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/artifact-gates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit final wiki reference gate**

Run:

```bash
git add packages/context/src/ingest/artifact-gates.ts packages/context/src/ingest/artifact-gates.test.ts
git commit -m "fix(ingest): gate final wiki references"
```

### Task 2: Enforce target connections in SL tools and patch policy

**Files:**
- Create: `packages/context/src/tools/action-target-connection.ts`
- Modify: `packages/context/src/tools/index.ts`
- Modify: `packages/context/src/sl/tools/sl-write-source.tool.ts`
- Modify: `packages/context/src/sl/tools/sl-write-source.tool.test.ts`
- Modify: `packages/context/src/sl/tools/sl-edit-source.tool.ts`
- Modify: `packages/context/src/sl/tools/sl-edit-source.tool.test.ts`
- Create: `packages/context/src/ingest/semantic-layer-target-policy.ts`
- Create: `packages/context/src/ingest/semantic-layer-target-policy.test.ts`
- Modify: `packages/context/src/ingest/isolated-diff/git-patch.ts`
- Modify: `packages/context/src/ingest/isolated-diff/git-patch.test.ts`

- [ ] **Step 1: Write failing session target-connection tests**

In `packages/context/src/sl/tools/sl-write-source.tool.test.ts`, append this
test inside `describe('SlWriteSourceTool — session gating', ...)`:

```ts
  it('rejects session-scoped writes outside allowed target connections', async () => {
    const { tool } = makeTool();
    const session = makeSession({
      allowedConnectionNames: new Set(['warehouse']),
    });
    const context: ToolContext = { ...baseContext, session };

    const result = await tool.call(
      {
        connectionId: 'finance',
        sourceName: 'finance_orders',
        source: {
          name: 'finance_orders',
          table: 'public.orders',
          grain: ['id'],
          columns: [{ name: 'id', type: 'string' }],
          measures: [],
          joins: [],
        } as any,
      } as any,
      context,
    );

    expect(result.structured.success).toBe(false);
    expect(result.markdown).toContain('connectionId "finance" is outside this ingest session');
    expect(session.actions).toEqual([]);
  });
```

In `packages/context/src/sl/tools/sl-edit-source.tool.test.ts`, append this test
inside `describe('SlEditSourceTool — session gating', ...)`:

```ts
  it('rejects session-scoped edits outside allowed target connections', async () => {
    const { tool } = makeTool();
    const session = makeSession({
      allowedConnectionNames: new Set(['warehouse']),
    });
    const context: ToolContext = { ...baseContext, session };

    const result = await tool.call(
      {
        connectionId: 'finance',
        sourceName: 'orders',
        yaml_edits: [{ oldText: 'measures: []', newText: 'measures: []' }],
      } as any,
      context,
    );

    expect(result.structured.success).toBe(false);
    expect(result.markdown).toContain('connectionId "finance" is outside this ingest session');
    expect(session.actions).toEqual([]);
  });
```

- [ ] **Step 2: Run the failing SL tool tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/sl/tools/sl-write-source.tool.test.ts \
  src/sl/tools/sl-edit-source.tool.test.ts \
  -t "outside allowed target connections"
```

Expected: FAIL because the tools do not inspect
`session.allowedConnectionNames`.

- [ ] **Step 3: Add shared session target validation**

Create `packages/context/src/tools/action-target-connection.ts`:

```ts
import type { ToolSession } from './tool-session.js';

type ActionTargetConnectionValidation = { ok: true } | { ok: false; error: string };

export function validateActionTargetConnection(
  session: ToolSession | undefined,
  connectionId: string,
): ActionTargetConnectionValidation {
  const allowed = session?.allowedConnectionNames;
  if (!allowed) {
    return { ok: true };
  }
  if (allowed.has(connectionId)) {
    return { ok: true };
  }
  const allowedList = [...allowed].sort();
  return {
    ok: false,
    error: `connectionId "${connectionId}" is outside this ingest session's allowed target connections: ${
      allowedList.length > 0 ? allowedList.join(', ') : '(none)'
    }`,
  };
}
```

In `packages/context/src/tools/index.ts`, add this export next to
`validateActionRawPaths`:

```ts
export { validateActionTargetConnection } from './action-target-connection.js';
```

- [ ] **Step 4: Wire target validation into SL write/edit tools**

In `packages/context/src/sl/tools/sl-write-source.tool.ts`, replace this import:

```ts
import { addTouchedSlSource, type ToolContext, type ToolOutput, validateActionRawPaths } from '../../tools/index.js';
```

with:

```ts
import {
  addTouchedSlSource,
  type ToolContext,
  type ToolOutput,
  validateActionRawPaths,
  validateActionTargetConnection,
} from '../../tools/index.js';
```

In `SlWriteSourceTool.call()`, immediately after:

```ts
    const semanticLayerService = context.session?.semanticLayerService ?? this.semanticLayerService;
    const skipIndex = context.session?.isWorktreeScoped === true;
```

add:

```ts
    const targetConnectionValidation = validateActionTargetConnection(context.session, connectionId);
    if (!targetConnectionValidation.ok) {
      return this.buildOutput(false, [targetConnectionValidation.error], sourceName);
    }
```

In `packages/context/src/sl/tools/sl-edit-source.tool.ts`, replace this import:

```ts
import { addTouchedSlSource, type ToolContext, type ToolOutput, validateActionRawPaths } from '../../tools/index.js';
```

with:

```ts
import {
  addTouchedSlSource,
  type ToolContext,
  type ToolOutput,
  validateActionRawPaths,
  validateActionTargetConnection,
} from '../../tools/index.js';
```

In `SlEditSourceTool.call()`, immediately after:

```ts
    const semanticLayerService = context.session?.semanticLayerService ?? this.semanticLayerService;
    const skipIndex = context.session?.isWorktreeScoped === true;
```

add:

```ts
    const targetConnectionValidation = validateActionTargetConnection(context.session, connectionId);
    if (!targetConnectionValidation.ok) {
      return this.buildOutput(false, [targetConnectionValidation.error], sourceName);
    }
```

- [ ] **Step 5: Write target-policy unit tests**

Create `packages/context/src/ingest/semantic-layer-target-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertSemanticLayerTargetPathsAllowed,
  findDisallowedSemanticLayerTargetPaths,
  semanticLayerConnectionIdFromPath,
} from './semantic-layer-target-policy.js';

describe('semantic-layer target policy', () => {
  it('extracts connection ids from semantic-layer paths', () => {
    expect(semanticLayerConnectionIdFromPath('semantic-layer/warehouse/orders.yaml')).toBe('warehouse');
    expect(semanticLayerConnectionIdFromPath('a/semantic-layer/finance/orders.yaml')).toBe('finance');
    expect(semanticLayerConnectionIdFromPath('wiki/global/orders.md')).toBeNull();
  });

  it('finds semantic-layer paths outside the allowed target connections', () => {
    expect(
      findDisallowedSemanticLayerTargetPaths({
        paths: [
          'semantic-layer/warehouse/orders.yaml',
          'semantic-layer/finance/orders.yaml',
          'wiki/global/orders.md',
        ],
        allowedConnectionIds: new Set(['warehouse']),
      }),
    ).toEqual([{ path: 'semantic-layer/finance/orders.yaml', connectionId: 'finance' }]);
  });

  it('throws a deterministic error for unauthorized semantic-layer targets', () => {
    expect(() =>
      assertSemanticLayerTargetPathsAllowed({
        paths: ['semantic-layer/finance/orders.yaml', 'semantic-layer/marketing/accounts.yaml'],
        allowedConnectionIds: new Set(['warehouse']),
      }),
    ).toThrow(
      /semantic-layer target connection not allowed: semantic-layer\/finance\/orders\.yaml \(finance\), semantic-layer\/marketing\/accounts\.yaml \(marketing\); allowed: warehouse/,
    );
  });
});
```

- [ ] **Step 6: Implement target-policy helpers**

Create `packages/context/src/ingest/semantic-layer-target-policy.ts`:

```ts
export interface SemanticLayerTargetPolicyInput {
  paths: readonly string[];
  allowedConnectionIds: ReadonlySet<string>;
}

export interface SemanticLayerTargetPolicyViolation {
  path: string;
  connectionId: string;
}

export function semanticLayerConnectionIdFromPath(path: string): string | null {
  const normalized = path.replace(/^[ab]\//, '');
  const match = /^semantic-layer\/([^/]+)\//.exec(normalized);
  return match?.[1] ?? null;
}

export function findDisallowedSemanticLayerTargetPaths(
  input: SemanticLayerTargetPolicyInput,
): SemanticLayerTargetPolicyViolation[] {
  return input.paths
    .map((path) => ({ path, connectionId: semanticLayerConnectionIdFromPath(path) }))
    .filter((entry): entry is SemanticLayerTargetPolicyViolation => {
      return entry.connectionId !== null && !input.allowedConnectionIds.has(entry.connectionId);
    })
    .sort((left, right) => {
      const byConnection = left.connectionId.localeCompare(right.connectionId);
      return byConnection === 0 ? left.path.localeCompare(right.path) : byConnection;
    });
}

export function assertSemanticLayerTargetPathsAllowed(input: SemanticLayerTargetPolicyInput): void {
  const violations = findDisallowedSemanticLayerTargetPaths(input);
  if (violations.length === 0) {
    return;
  }
  const allowed = [...input.allowedConnectionIds].sort();
  throw new Error(
    `semantic-layer target connection not allowed: ${violations
      .map((violation) => `${violation.path} (${violation.connectionId})`)
      .join(', ')}; allowed: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
  );
}
```

- [ ] **Step 7: Add failing patch-policy test**

In `packages/context/src/ingest/isolated-diff/git-patch.test.ts`, append this
test inside `describe('isolated diff patch contract', ...)`:

```ts
  it('rejects semantic-layer paths outside allowed target connections', () => {
    const patch =
      'diff --git a/semantic-layer/finance/orders.yaml b/semantic-layer/finance/orders.yaml\nindex 1..2 100644\n';

    expect(() =>
      assertPatchAllowedForWorkUnit({
        unitKey: 'wu-finance',
        patch,
        slDisallowed: false,
        allowedTargetConnectionIds: new Set(['warehouse']),
      }),
    ).toThrow(/semantic-layer target connection not allowed: semantic-layer\/finance\/orders.yaml \(finance\); allowed: warehouse/);
  });
```

- [ ] **Step 8: Wire target policy into patch parsing**

In `packages/context/src/ingest/isolated-diff/git-patch.ts`, add this import:

```ts
import { assertSemanticLayerTargetPathsAllowed } from '../semantic-layer-target-policy.js';
```

Update `PatchPolicyInput` to include allowed targets:

```ts
export interface PatchPolicyInput {
  unitKey: string;
  patch: string;
  slDisallowed: boolean;
  allowedTargetConnectionIds?: ReadonlySet<string>;
}
```

In `assertPatchAllowedForWorkUnit()`, after `const touched =
parsePatchTouchedPaths(input.patch);`, add:

```ts
  if (input.allowedTargetConnectionIds) {
    assertSemanticLayerTargetPathsAllowed({
      paths: touched.map((entry) => entry.path),
      allowedConnectionIds: input.allowedTargetConnectionIds,
    });
  }
```

- [ ] **Step 9: Run policy and SL tool tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/sl/tools/sl-write-source.tool.test.ts \
  src/sl/tools/sl-edit-source.tool.test.ts \
  src/ingest/semantic-layer-target-policy.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit target tool and patch policy**

Run:

```bash
git add \
  packages/context/src/tools/action-target-connection.ts \
  packages/context/src/tools/index.ts \
  packages/context/src/sl/tools/sl-write-source.tool.ts \
  packages/context/src/sl/tools/sl-write-source.tool.test.ts \
  packages/context/src/sl/tools/sl-edit-source.tool.ts \
  packages/context/src/sl/tools/sl-edit-source.tool.test.ts \
  packages/context/src/ingest/semantic-layer-target-policy.ts \
  packages/context/src/ingest/semantic-layer-target-policy.test.ts \
  packages/context/src/ingest/isolated-diff/git-patch.ts \
  packages/context/src/ingest/isolated-diff/git-patch.test.ts
git commit -m "fix(ingest): enforce SL target connection scope"
```

### Task 3: Wire target policy through integration and final runner gates

**Files:**
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`
- Modify: `packages/context/src/ingest/isolated-diff/patch-integrator.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Add traced patch-integrator target rejection coverage**

In `packages/context/src/ingest/isolated-diff/patch-integrator.test.ts`, add
`allowedTargetConnectionIds: new Set(['c1']),` to every existing
`integrateWorkUnitPatch()` call.

Append this test inside `describe('integrateWorkUnitPatch', ...)`:

```ts
  it('classifies unauthorized semantic-layer targets as traced textual conflicts', async () => {
    const { homeDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-target-policy');
    await git.addWorktree(childDir, 'child-target-policy', baseSha);
    const childGit = git.forWorktree(childDir);
    await mkdir(join(childDir, 'semantic-layer/finance'), { recursive: true });
    await writeFile(
      join(childDir, 'semantic-layer/finance/orders.yaml'),
      'name: orders\ncolumns: []\njoins: []\nmeasures: []\n',
    );
    await childGit.commitFiles(['semantic-layer/finance/orders.yaml'], 'unauthorized sl', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/unauthorized.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-target-policy/trace.jsonl'),
      jobId: 'job-target-policy',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-finance',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'KTX Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['warehouse']),
    });

    expect(result).toMatchObject({
      status: 'textual_conflict',
      touchedPaths: ['semantic-layer/finance/orders.yaml'],
    });
    const rawTrace = await readFile(trace.tracePath, 'utf-8');
    expect(rawTrace).toContain('patch_policy_rejected');
    expect(rawTrace).toContain('semantic-layer target connection not allowed');
    expect(rawTrace).toContain('allowedTargetConnectionIds');
  });
```

- [ ] **Step 2: Run the failing patch-integrator test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts -t "unauthorized semantic-layer targets"
```

Expected: FAIL because `IntegrateWorkUnitPatchInput` does not accept or pass
allowed target connections to patch policy.

- [ ] **Step 3: Implement patch-integrator target policy wiring**

In `packages/context/src/ingest/isolated-diff/patch-integrator.ts`, add this
field to `IntegrateWorkUnitPatchInput`:

```ts
  allowedTargetConnectionIds: ReadonlySet<string>;
```

In the `assertPatchAllowedForWorkUnit()` call, add:

```ts
      allowedTargetConnectionIds: input.allowedTargetConnectionIds,
```

In the `patch_policy_rejected` trace data, add:

```ts
      allowedTargetConnectionIds: [...input.allowedTargetConnectionIds].sort(),
```

- [ ] **Step 4: Wire WorkUnit target sets and final target gate in the runner**

In `packages/context/src/ingest/ingest-bundle.runner.ts`, add this import:

```ts
import { assertSemanticLayerTargetPathsAllowed } from './semantic-layer-target-policy.js';
```

Near the existing projection state:

```ts
      let projectionTouchedSources: TouchedSlSource[] = [];
      let projectionChangedWikiPageKeys: string[] = [];
```

add:

```ts
      let projectionTouchedPaths: string[] = [];
```

Inside the `adapter.project` block, immediately after `const projectionPaths =
[...]`, add:

```ts
          projectionTouchedPaths = projectionPaths;
```

In the `integrateWorkUnitPatch()` call, add:

```ts
            allowedTargetConnectionIds: new Set(slConnectionIds),
```

After `const finalTouchedSlSources = this.uniqueTouchedSlSources([...]);` and
before `activePhase = 'final_gates';`, add this traced policy gate:

```ts
      const finalTargetPolicyPaths = [
        ...projectionTouchedPaths,
        ...workUnitOutcomes.flatMap((outcome) => outcome.patchTouchedPaths ?? []),
        ...postReconciliationPaths,
        ...(postProcessorOutcome?.touchedSources ?? []).map(
          (source) => `semantic-layer/${source.connectionId}/${source.sourceName}.yaml`,
        ),
      ];
      const targetPolicyTraceData = {
        allowedTargetConnectionIds: slConnectionIds,
        touchedPaths: [...new Set(finalTargetPolicyPaths)].sort(),
      };
      activePhase = 'target_policy';
      activeFailureDetails = targetPolicyTraceData;
      await traceTimed(runTrace, 'target_policy', 'semantic_layer_target_policy', targetPolicyTraceData, async () => {
        assertSemanticLayerTargetPathsAllowed({
          paths: finalTargetPolicyPaths,
          allowedConnectionIds: new Set(slConnectionIds),
        });
      });
      activeFailureDetails = undefined;
```

In `packages/context/src/ingest/index.ts`, export the target policy helpers:

```ts
export {
  assertSemanticLayerTargetPathsAllowed,
  findDisallowedSemanticLayerTargetPaths,
  semanticLayerConnectionIdFromPath,
} from './semantic-layer-target-policy.js';
```

- [ ] **Step 5: Run patch-integrator tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/isolated-diff/patch-integrator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit integration target-policy wiring**

Run:

```bash
git add \
  packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/index.ts
git commit -m "fix(ingest): trace isolated SL target policy gates"
```

### Task 4: Add end-to-end isolated-diff regressions

**Files:**
- Modify: `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`

- [ ] **Step 1: Update the runner test wiki helper**

In `packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts`,
replace `makeWikiService()` with this implementation:

```ts
async function listGlobalWikiPageKeys(root: string): Promise<string[]> {
  const dir = join(root, 'wiki/global');
  const entries = await readdir(dir).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.slice(0, -'.md'.length))
    .sort();
}

function frontmatterList(yaml: string, key: string): string[] {
  const pattern = new RegExp(`${key}:\\n((?:  - .+\\n?)*)`);
  return (
    pattern
      .exec(yaml)?.[1]
      ?.split('\n')
      .map((line) => line.trim().replace(/^- /, ''))
      .filter(Boolean) ?? []
  );
}

function makeWikiService(root: string) {
  return {
    listPageKeys: vi.fn(async (scope: string) => (scope === 'GLOBAL' ? listGlobalWikiPageKeys(root) : [])),
    readPage: vi.fn(async (_scope: string, _scopeId: string | null, key: string) => {
      const path = join(root, 'wiki/global', `${key}.md`);
      const raw = await readFile(path, 'utf-8').catch(() => null);
      if (!raw) {
        return null;
      }
      const [, yaml = '', content = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw) ?? [];
      return {
        pageKey: key,
        frontmatter: {
          summary: key,
          usage_mode: 'auto',
          refs: frontmatterList(yaml, 'refs'),
          sl_refs: frontmatterList(yaml, 'sl_refs'),
        },
        content: content.trim(),
      };
    }),
    syncFromCommit: vi.fn(),
  };
}
```

Add `readdir` to the first import from `node:fs/promises`:

```ts
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
```

- [ ] **Step 2: Add failing cross-WorkUnit wiki ref regression**

Append this test inside
`describe('IngestBundleRunner isolated diff path', ...)`:

```ts
  it('rejects final wiki refs broken by another accepted WorkUnit before squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'wiki/global/source-page.md'),
        '---\nsummary: Source page\nusage_mode: auto\n---\n\nSource page\n',
      );
      await runtime.git.commitFiles(['wiki/global/source-page.md'], 'seed source page', 'KTX Test', 'system@ktx.local');
      const preRunHead = await runtime.git.revParseHead();
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'page-ref', rawFiles: ['pages/ref.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'page-delete', rawFiles: ['pages/delete.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.unitKey === 'page-ref') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nrefs:\n  - source-page\n---\n\nSee [[source-page]].\n',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'account-segments',
            detail: 'Page with wiki ref',
            rawPaths: ['pages/ref.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'wu page ref', 'KTX Test', 'system@ktx.local');
        }
        if (params.telemetryTags.unitKey === 'page-delete') {
          await rm(join(root, 'wiki/global/source-page.md'), { force: true });
          currentSession.actions.push({
            target: 'wiki',
            type: 'removed',
            key: 'source-page',
            detail: 'Delete referenced page',
            rawPaths: ['pages/delete.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/source-page.md'], 'wu delete source page', 'KTX Test', 'system@ktx.local');
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['pages/ref.json', 'h1'],
        ['pages/delete.json', 'h2'],
      ]);

      await expect(
        runner.run({
          jobId: 'job-wiki-ref-conflict',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/wiki references target missing page\(s\): account-segments -> source-page/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-wiki-ref-conflict/trace.jsonl'), 'utf-8');
      expect(trace).toContain('final_artifact_gates_failed');
      expect(trace).toContain('account-segments -> source-page');
      expect(trace).toContain('ingest_failed');
      expect(trace).not.toContain('squash_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 3: Add failing unauthorized WorkUnit patch regression**

Append this test inside the same `describe(...)` block:

```ts
  it('rejects WorkUnit patches that touch unauthorized semantic-layer target connections', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'finance-source', rawFiles: ['cards/finance.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/finance'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/finance/orders.yaml'),
          'name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures: []\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'finance', 'orders');
        currentSession.actions.push({
          target: 'sl',
          type: 'created',
          key: 'orders',
          detail: 'Unauthorized target',
          targetConnectionId: 'finance',
          rawPaths: ['cards/finance.json'],
        });
        await currentSession.gitService.commitFiles(['semantic-layer/finance/orders.yaml'], 'wu unauthorized target', 'KTX Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/finance.json', 'h1']]);
      const preRunHead = await runtime.git.revParseHead();

      await expect(
        runner.run({
          jobId: 'job-unauthorized-wu-target',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/isolated diff textual conflict.*semantic-layer target connection not allowed/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-unauthorized-wu-target/trace.jsonl'), 'utf-8');
      expect(trace).toContain('patch_policy_rejected');
      expect(trace).toContain('semantic-layer/finance/orders.yaml');
      expect(trace).toContain('allowedTargetConnectionIds');
      expect(trace).not.toContain('squash_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 4: Add failing unauthorized reconciliation regression**

Append this test inside the same `describe(...)` block:

```ts
  it('rejects reconciliation mutations that touch unauthorized semantic-layer target connections before squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'valid-page', rawFiles: ['pages/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(join(root, 'wiki/global/valid-page.md'), '---\nsummary: Valid page\nusage_mode: auto\n---\n\nValid\n');
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'valid-page',
            detail: 'Valid page',
            rawPaths: ['pages/source.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/valid-page.md'], 'wu valid page', 'KTX Test', 'system@ktx.local');
        } else {
          await mkdir(join(root, 'semantic-layer/finance'), { recursive: true });
          await writeFile(
            join(root, 'semantic-layer/finance/reconcile_orders.yaml'),
            'name: reconcile_orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures: []\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'finance', 'reconcile_orders');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'reconcile_orders',
            detail: 'Unauthorized reconcile target',
            targetConnectionId: 'finance',
            rawPaths: ['pages/source.json'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/finance/reconcile_orders.yaml'],
            'reconcile unauthorized target',
            'KTX Test',
            'system@ktx.local',
          );
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['pages/source.json', 'h1']]);
      const preRunHead = await runtime.git.revParseHead();

      await expect(
        runner.run({
          jobId: 'job-unauthorized-reconcile-target',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/semantic-layer target connection not allowed/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-unauthorized-reconcile-target/trace.jsonl'), 'utf-8');
      expect(trace).toContain('semantic_layer_target_policy_failed');
      expect(trace).toContain('semantic-layer/finance/reconcile_orders.yaml');
      expect(trace).toContain('ingest_failed');
      expect(trace).not.toContain('squash_finished');
      const failureReport = (deps.reports.create as any).mock.calls
        .map((call: any[]) => call[0])
        .find((report: any) => report.body.status === 'failed');
      expect(failureReport.body.failure).toMatchObject({
        phase: 'target_policy',
        message: expect.stringContaining('semantic-layer target connection not allowed'),
      });
      expect(failureReport.body.failure.details).toMatchObject({
        allowedTargetConnectionIds: ['warehouse'],
        touchedPaths: expect.arrayContaining(['semantic-layer/finance/reconcile_orders.yaml']),
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 5: Run failing runner regressions**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  -t "wiki refs broken|unauthorized semantic-layer target"
```

Expected before Tasks 1-3 are complete: FAIL. Expected after Tasks 1-3 are
complete: PASS.

- [ ] **Step 6: Commit runner regressions**

Run:

```bash
git add packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts
git commit -m "test(ingest): cover isolated diff reference and target gates"
```

### Task 5: Verification and trace acceptance

**Files:**
- Verify: `packages/context/src/ingest/*`
- Verify: `packages/context/src/ingest/isolated-diff/*`
- Verify: `packages/context/src/sl/tools/*`
- Verify: `packages/context/src/tools/*`

- [ ] **Step 1: Run the focused isolated-diff and tool suite**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-trace.test.ts \
  src/ingest/wiki-body-refs.test.ts \
  src/ingest/artifact-gates.test.ts \
  src/ingest/semantic-layer-target-policy.test.ts \
  src/ingest/isolated-diff/git-patch.test.ts \
  src/ingest/isolated-diff/work-unit-executor.test.ts \
  src/ingest/isolated-diff/patch-integrator.test.ts \
  src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  src/sl/tools/sl-write-source.tool.test.ts \
  src/sl/tools/sl-edit-source.tool.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run dead-code check for TypeScript changes**

Run:

```bash
pnpm run dead-code
```

Expected: PASS, or only pre-existing findings unrelated to the files in this
plan. If there are unrelated pre-existing findings, capture the exact output in
the final handoff.

- [ ] **Step 4: Run pre-commit for changed files**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/ingest/artifact-gates.ts \
  packages/context/src/ingest/artifact-gates.test.ts \
  packages/context/src/ingest/semantic-layer-target-policy.ts \
  packages/context/src/ingest/semantic-layer-target-policy.test.ts \
  packages/context/src/ingest/isolated-diff/git-patch.ts \
  packages/context/src/ingest/isolated-diff/git-patch.test.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/context/src/ingest/index.ts \
  packages/context/src/tools/action-target-connection.ts \
  packages/context/src/tools/index.ts \
  packages/context/src/sl/tools/sl-write-source.tool.ts \
  packages/context/src/sl/tools/sl-write-source.tool.test.ts \
  packages/context/src/sl/tools/sl-edit-source.tool.ts \
  packages/context/src/sl/tools/sl-edit-source.tool.test.ts
```

Expected: PASS. If the repository has no usable pre-commit configuration or the
local `uv` version cannot satisfy the project pin, report the exact failure and
run `pnpm --filter @ktx/context run type-check` plus the Vitest suite above.

- [ ] **Step 5: Verify persistent trace acceptance criteria**

Inspect the traces produced by the two new runner failures. The trace must
include these events and fields:

```text
job-wiki-ref-conflict:
- final_artifact_gates_failed
- ingest_failed
- failure_report_created
- no squash_finished event
- error.message includes "account-segments -> source-page"

job-unauthorized-wu-target:
- patch_policy_rejected
- ingest_failed
- failure_report_created
- no squash_finished event
- data.allowedTargetConnectionIds includes "warehouse"
- data.touchedPaths includes "semantic-layer/finance/orders.yaml"

job-unauthorized-reconcile-target:
- semantic_layer_target_policy_started
- semantic_layer_target_policy_failed
- ingest_failed
- failure_report_created
- no squash_finished event
- data.allowedTargetConnectionIds includes "warehouse"
- data.touchedPaths includes "semantic-layer/finance/reconcile_orders.yaml"
- error.message includes "semantic-layer target connection not allowed"
```

The failed stored reports for the two target-policy regressions must include:

```text
failure.phase:
- "integration" for WorkUnit patch policy rejection
- "target_policy" for reconciliation or integration-stage mutation rejection

failure.details:
- allowedTargetConnectionIds
- touchedPaths
- invalid path and connection in the error message
```

- [ ] **Step 6: Commit verification-only fixes if needed**

If verification exposes formatting, type, or test issues in the files changed
by this plan, fix them and commit:

```bash
git add \
  packages/context/src/ingest/artifact-gates.ts \
  packages/context/src/ingest/artifact-gates.test.ts \
  packages/context/src/ingest/semantic-layer-target-policy.ts \
  packages/context/src/ingest/semantic-layer-target-policy.test.ts \
  packages/context/src/ingest/isolated-diff/git-patch.ts \
  packages/context/src/ingest/isolated-diff/git-patch.test.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.ts \
  packages/context/src/ingest/isolated-diff/patch-integrator.test.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/ingest-bundle.runner.isolated-diff.test.ts \
  packages/context/src/ingest/index.ts \
  packages/context/src/tools/action-target-connection.ts \
  packages/context/src/tools/index.ts \
  packages/context/src/sl/tools/sl-write-source.tool.ts \
  packages/context/src/sl/tools/sl-write-source.tool.test.ts \
  packages/context/src/sl/tools/sl-edit-source.tool.ts \
  packages/context/src/sl/tools/sl-edit-source.tool.test.ts
git commit -m "chore(ingest): verify isolated diff gate closure"
```

If verification passes without edits, do not create an empty commit.

## Self-review

Spec coverage:

- Wiki `refs` and inline `[[...]]` validation is added to the final global gate
  for changed wiki pages in the composed integration tree.
- WorkUnit patch integration rejects unauthorized semantic-layer target
  connections before patch application can commit into the integration tree.
- Reconciliation and other integration-stage mutations are checked with a
  traced target-policy gate before final artifact gates and before squash.
- SL write/edit tools reject out-of-scope target connections during
  session-scoped ingest tool calls.
- Failure traces and failed reports include explicit target-policy context,
  rejected paths, allowed connection IDs, failure phase, and no `squash_finished`
  event when the run stops before main.

Placeholder scan:

- The plan contains no placeholder tokens, deferred implementation notes, or
  unspecified edge-case instructions.

Type consistency:

- `allowedTargetConnectionIds` is the patch-policy and patch-integrator field.
- `allowedConnectionNames` remains the existing `ToolSession` field.
- `semantic_layer_target_policy_*` is the trace event prefix from `traceTimed()`.
- `refs` is the existing wiki frontmatter field that implements the spec's
  wiki-reference gate.
